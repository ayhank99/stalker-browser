const https = require('https');
const http = require('http');
const { getChannels } = require('./yt-channels');
const { getStreamUrl, extractVideoId, invalidateStreamCache, isGoogleCdnUrl } = require('./yt-stream');

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

function firstHeader(value) {
  return String(Array.isArray(value) ? value[0] : (value || '')).split(',')[0].trim();
}

function requestOrigin(req) {
  const proto = firstHeader(req.headers['x-forwarded-proto']) || (req.secure ? 'https' : 'http');
  const host = firstHeader(req.headers['x-forwarded-host']) || req.headers.host || '';
  return proto + '://' + host;
}

function toHttpUrl(value) {
  const parsed = new URL(String(value));
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http/https can be proxied');
  }
  return parsed;
}

function encodeSegment(value) {
  return Buffer.from(String(value), 'utf8').toString('base64url');
}

function decodeSegment(value) {
  try {
    return Buffer.from(String(value || ''), 'base64url').toString('utf8');
  } catch (_) {
    return '';
  }
}

function proxiedSegmentUrl(value, sourceUrl, origin, id) {
  try {
    const absolute = new URL(value, sourceUrl).toString();
    const parsed = toHttpUrl(absolute);
    return origin + '/proxy/' + encodeURIComponent(id) + '?u=' + encodeURIComponent(encodeSegment(parsed.toString()));
  } catch (_) {
    return null;
  }
}

function rewritePlaylist(body, sourceUrl, req, id) {
  const origin = requestOrigin(req);
  return body.split('\n').map(raw => {
    const line = raw.trim();
    if (!line) return raw;
    if (line.startsWith('#')) {
      return raw.replace(/URI=(["'])(.*?)\1/g, (match, quote, uri) => {
        const rewritten = proxiedSegmentUrl(uri, sourceUrl, origin, id);
        return rewritten ? 'URI=' + quote + rewritten + quote : match;
      });
    }
    return proxiedSegmentUrl(line, sourceUrl, origin, id) || raw;
  }).join('\n');
}

function proxyUrl(url, req, res, id, isM3U8, redirectCount, onGoogleCdn403) {
  if (!url) return res.status(502).send('Stream URL alinamadi');
  if ((redirectCount || 0) > 5) return res.status(502).send('Too many redirects');

  let parsedUrl;
  try {
    parsedUrl = toHttpUrl(url);
  } catch (_) {
    return res.status(400).send('Gecersiz URL');
  }

  const protocol = parsedUrl.protocol === 'https:' ? https : http;
  const upstream = protocol.get(parsedUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: '*/*',
      ...(req.headers.range ? { Range: req.headers.range } : {})
    }
  }, (proxyRes) => {
    // When YouTube/Google CDN returns 403, try a proxy-friendly fallback (Invidious/Piped)
    if (proxyRes.statusCode === 403 && isGoogleCdnUrl(url) && typeof onGoogleCdn403 === 'function') {
      proxyRes.resume();
      onGoogleCdn403();
      return;
    }

    if (REDIRECT_STATUS.has(proxyRes.statusCode) && proxyRes.headers.location) {
      proxyRes.resume();
      const nextUrl = new URL(proxyRes.headers.location, parsedUrl).toString();
      return proxyUrl(nextUrl, req, res, id, isM3U8, (redirectCount || 0) + 1, onGoogleCdn403);
    }

    const ct = proxyRes.headers['content-type'] || '';
    const shouldRewrite = isM3U8 || parsedUrl.pathname.endsWith('.m3u8') || /mpegurl|m3u/i.test(ct);

    if (shouldRewrite) {
      let body = '';
      proxyRes.on('data', chunk => { body += chunk; });
      proxyRes.on('end', () => {
        if (proxyRes.statusCode < 200 || proxyRes.statusCode >= 300) {
          if (!res.headersSent) res.status(proxyRes.statusCode || 502).send('Stream source error');
          return;
        }
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'no-store');
        res.status(200).send(rewritePlaylist(body, parsedUrl, req, id));
      });
      proxyRes.on('error', () => { if (!res.headersSent) res.status(502).send('Stream error'); });
      return;
    }

    res.setHeader('Content-Type', ct || 'video/mp4');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Accept-Ranges', 'bytes');
    if (proxyRes.headers['content-length']) res.setHeader('Content-Length', proxyRes.headers['content-length']);
    if (proxyRes.headers['content-range']) res.setHeader('Content-Range', proxyRes.headers['content-range']);
    res.writeHead(proxyRes.statusCode || 200);
    proxyRes.pipe(res);
  });

  upstream.setTimeout(25000, () => upstream.destroy(new Error('Proxy timeout')));
  upstream.on('error', () => { if (!res.headersSent) res.status(502).send('Proxy baglanti hatasi'); });
}

async function handle(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).send('Method not allowed');

  const id = req.params && req.params.id;
  if (!id) return res.status(400).send('ID gerekli');

  try {
    let channel = null;
    const idVideo = extractVideoId(id);
    if (idVideo && /^yt_[a-zA-Z0-9_-]{11}$/.test(String(id || ''))) {
      channel = { videoId: idVideo };
    } else {
      const channels = await getChannels();
      channel = channels[id];
    }
    if (!channel) return res.status(404).send('Kanal bulunamadi');

    const rawU = req.query && (Array.isArray(req.query.u) ? req.query.u[0] : req.query.u);
    const rawUrl = req.query && (Array.isArray(req.query.url) ? req.query.url[0] : req.query.url);
    const segmentUrl = rawUrl || (rawU ? decodeSegment(rawU) : '');

    if (req.method === 'HEAD') {
      res.setHeader('Content-Type', segmentUrl ? 'video/MP2T' : 'application/vnd.apple.mpegurl; charset=utf-8');
      return res.status(200).end();
    }

    if (segmentUrl) {
      return proxyUrl(segmentUrl, req, res, id, false, 0);
    }

    const stream = await getStreamUrl(channel.videoId);
    if (!stream || !stream.url) {
      return res.status(503).send('YouTube stream alinamadi. ' + (stream && stream.error || 'Tum yontemler basarisiz oldu'));
    }

    // When Google CDN returns 403 (cloud IP blocked), retry using proxy-friendly sources only
    const handleGoogleCdn403 = async () => {
      console.warn('[yt-proxy] googlevideo.com 403 - cache temizleniyor, proxy kaynagi deneniyor:', channel.videoId);
      invalidateStreamCache(channel.videoId);
      try {
        const fallback = await getStreamUrl(channel.videoId, { skipGoogleCdn: true });
        if (fallback && fallback.url) {
          return proxyUrl(fallback.url, req, res, id, !!fallback.isM3U8, 0);
        }
      } catch (_) {}
      if (!res.headersSent) res.status(503).send('YouTube stream erisilemez (IP engeli). Invidious/Piped da basarisiz oldu.');
    };

    if (stream.isM3U8) {
      return proxyUrl(stream.url, req, res, id, true, 0, isGoogleCdnUrl(stream.url) ? handleGoogleCdn403 : null);
    }

    return proxyUrl(stream.url, req, res, id, false, 0, isGoogleCdnUrl(stream.url) ? handleGoogleCdn403 : null);
  } catch (e) {
    console.error('[yt-proxy]', e && e.message);
    if (!res.headersSent) res.status(500).send('Sunucu hatasi');
  }
}

module.exports = { handle };
