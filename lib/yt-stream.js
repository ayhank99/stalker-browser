const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const DEFAULT_INVIDIOUS = [
  'https://inv.nadeko.net',
  'https://invidious.io.lol',
  'https://inv.vern.cc',
  'https://invidious.private.coffee',
  'https://yt.cdaut.de',
  'https://invidious.nerdvpn.de',
  'https://invidious.privacydev.net',
  'https://inv.thepixora.com',
  'https://yt.chocolatemoo53.com'
];

const DEFAULT_PIPED = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://piped-api.garudalinux.org'
];

const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
const PROXY_ID_RE = /^yt_([a-zA-Z0-9_-]{11})$/;
const streamCache = new Map();
const CACHE_MS = Number(process.env.STREAM_CACHE_MS) || 10 * 60 * 1000;

function normalizeHost(hostname) {
  return String(hostname || '').toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
}

function buildProxyId(videoId) {
  return VIDEO_ID_RE.test(String(videoId || '')) ? `yt_${videoId}` : '';
}

function extractVideoId(input) {
  if (!input) return null;
  const value = String(input).trim();
  if (VIDEO_ID_RE.test(value)) return value;

  const proxyMatch = value.match(PROXY_ID_RE);
  if (proxyMatch) return proxyMatch[1];

  try {
    const parsed = new URL(value);
    const host = normalizeHost(parsed.hostname);
    const parts = parsed.pathname.split('/').filter(Boolean);

    if (host === 'youtu.be' && VIDEO_ID_RE.test(parts[0] || '')) return parts[0];
    if (host === 'youtube.com' || host === 'music.youtube.com' || host === 'youtube-nocookie.com') {
      const watchId = parsed.searchParams.get('v');
      if (VIDEO_ID_RE.test(watchId || '')) return watchId;
      if (['embed', 'live', 'shorts', 'v'].includes(parts[0]) && VIDEO_ID_RE.test(parts[1] || '')) return parts[1];
    }
  } catch (_) {}

  const m = value.match(/(?:v=|youtu\.be\/|embed\/|live\/|shorts\/|\/v\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

function requestText(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (e) { return reject(e); }
    const protocol = parsed.protocol === 'https:' ? https : http;
    const req = protocol.get(parsed, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'application/json,text/plain,*/*'
      }
    }, (resp) => {
      if ([301, 302, 303, 307, 308].includes(resp.statusCode) && resp.headers.location) {
        resp.resume();
        return resolve(requestText(new URL(resp.headers.location, parsed).toString(), timeoutMs));
      }
      let data = '';
      resp.setEncoding('utf8');
      resp.on('data', c => { data += c; });
      resp.on('end', () => resolve({ statusCode: resp.statusCode, body: data }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function postJson(url, body, headers = {}, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (e) { return reject(e); }
    const protocol = parsed.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(body);
    const req = protocol.request(parsed, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent': 'Mozilla/5.0',
        ...headers
      }
    }, (resp) => {
      let data = '';
      resp.setEncoding('utf8');
      resp.on('data', c => { data += c; });
      resp.on('end', () => resolve({ statusCode: resp.statusCode, body: data }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function configuredInvidious() {
  const configured = String(process.env.INVIDIOUS_INSTANCES || '')
    .split(',')
    .map(v => v.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return configured.length ? configured : DEFAULT_INVIDIOUS;
}

function getYtDlpBinaries() {
  const candidates = [];
  if (process.env.YTDLP_PATH) candidates.push(process.env.YTDLP_PATH);

  try {
    const ytdlExec = require('youtube-dl-exec');
    if (ytdlExec && ytdlExec.constants && ytdlExec.constants.YOUTUBE_DL_PATH) {
      candidates.push(ytdlExec.constants.YOUTUBE_DL_PATH);
    }
  } catch (_) {}

  const localBin = process.platform === 'win32'
    ? path.join(__dirname, '..', 'bin', 'yt-dlp.exe')
    : path.join(__dirname, '..', 'bin', 'yt-dlp');
  if (fs.existsSync(localBin)) candidates.push(localBin);

  candidates.push(process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  candidates.push('yt-dlp');
  candidates.push('youtube-dl');

  return [...new Set(candidates.filter(Boolean))];
}

async function fromYtDlp(videoId) {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const baseArgs = [
    '--no-warnings',
    '--no-playlist',
    '--skip-download',
    '--extractor-args',
    'youtube:player_client=android_vr,tv,web',
    '--geo-bypass',
    '--no-check-certificates'
  ];

  const cookiesFile = '/tmp/yt-cookies.txt';
  if (process.env.YOUTUBE_COOKIES && !fs.existsSync(cookiesFile)) {
    try { fs.writeFileSync(cookiesFile, process.env.YOUTUBE_COOKIES); } catch (_) {}
  }
  if (fs.existsSync(cookiesFile)) {
    baseArgs.push('--cookies', cookiesFile);
  }

  let lastError = '';
  const binaries = getYtDlpBinaries();

  for (const bin of binaries) {
    try {
      const { stdout } = await execFileAsync(bin, [
        ...baseArgs,
        '-f',
        'best[protocol^=m3u8]',
        '--print',
        '%(protocol)s\t%(url)s',
        '--',
        watchUrl
      ], { timeout: 40000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });

      const line = stdout.split(/\r?\n/).map(v => v.trim()).find(Boolean);
      if (!line) continue;
      const [proto, ...rest] = line.split('\t');
      const url = rest.join('\t');
      if (proto && proto.startsWith('m3u8') && url) {
        return { url, isM3U8: true, source: 'yt-dlp' };
      }
    } catch (e) {
      lastError = String(e.stderr || e.message || '').split(/\r?\n/).filter(Boolean).slice(0, 2).join(' | ');
    }
  }

  for (const bin of binaries) {
    try {
      const { stdout, stderr } = await execFileAsync(bin, [
        ...baseArgs,
        '-f',
        'best[ext=mp4]/best',
        '-g',
        '--',
        watchUrl
      ], { timeout: 40000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });

      const url = stdout.split(/\r?\n/).map(v => v.trim()).find(v => v.startsWith('http'));
      if (url) {
        return { url, isM3U8: false, isRedirect: true, kind: 'mp4', source: 'yt-dlp' };
      }
      if (stderr) lastError = String(stderr).split(/\r?\n/).filter(Boolean).slice(0, 2).join(' | ');
    } catch (e) {
      lastError = String(e.stderr || e.message || '').split(/\r?\n/).filter(Boolean).slice(0, 2).join(' | ');
    }
  }

  return { url: null, isM3U8: false, source: 'yt-dlp', error: lastError || 'no URL' };
}

function buildYTCookieHeader() {
  return process.env.YOUTUBE_COOKIES_HEADER || 'CONSENT=YES+cb; SOCS=CAESEwgDEgk0OTk5OTk5OTkYASAAGg==';
}

async function fromInnertube(videoId) {
  const playerUrl = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
  const clients = [
    {
      id: '28',
      name: 'ANDROID_VR',
      version: '1.63.4',
      androidSdkVersion: 32,
      osName: 'Android',
      osVersion: '10',
      userAgent: 'Mozilla/5.0 (Linux; Android 10; Quest 2) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/123.0.6312.122 Mobile Safari/537.36'
    },
    {
      id: '7',
      name: 'TVHTML5',
      version: '7.20250101',
      userAgent: 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 5.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/5.0 TV Safari/538.1'
    },
    {
      id: '3',
      name: 'ANDROID',
      version: '19.44.38',
      androidSdkVersion: 30,
      osName: 'Android',
      osVersion: '11',
      userAgent: 'com.google.android.youtube/19.44.38(Linux; U; Android 11) gzip',
      key: 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM394'
    }
  ];

  for (const client of clients) {
    try {
      const context = {
        client: {
          clientName: client.name,
          clientVersion: client.version,
          ...(client.androidSdkVersion ? {
            androidSdkVersion: client.androidSdkVersion,
            osName: client.osName,
            osVersion: client.osVersion
          } : {})
        }
      };
      const apiUrl = client.key ? `${playerUrl}&key=${client.key}` : playerUrl;
      const r = await postJson(apiUrl, {
        context,
        videoId,
        contentCheckOk: true,
        racyCheckOk: true
      }, {
        'User-Agent': client.userAgent,
        'X-YouTube-Client-Name': client.id,
        'X-YouTube-Client-Version': client.version,
        Cookie: buildYTCookieHeader(),
        Origin: 'https://www.youtube.com',
        Referer: 'https://www.youtube.com/'
      });

      if (r.statusCode !== 200) continue;
      let json;
      try { json = JSON.parse(r.body); } catch (_) { continue; }
      if (!json || !json.streamingData) continue;

      const status = json.playabilityStatus && json.playabilityStatus.status;
      if (status && status !== 'OK' && status !== 'LIVE_STREAM_OFFLINE') continue;

      const hls = json.streamingData.hlsManifestUrl;
      if (typeof hls === 'string' && hls) {
        return { url: hls, isM3U8: true, source: `innertube:${client.name}` };
      }

      const muxed = (json.streamingData.formats || [])
        .filter(f => f && f.url && String(f.mimeType || '').includes('video/'))
        .sort((a, b) => (Number(b.height) || 0) - (Number(a.height) || 0));
      if (muxed[0] && muxed[0].url) {
        const mime = String(muxed[0].mimeType || '').toLowerCase();
        return {
          url: muxed[0].url,
          isM3U8: false,
          isRedirect: true,
          kind: mime.includes('webm') ? 'webm' : 'mp4',
          source: `innertube:${client.name}`
        };
      }
    } catch (_) {}
  }

  return null;
}

async function fromInvidious(videoId) {
  for (const base of configuredInvidious()) {
    try {
      const r = await requestText(`${base}/api/v1/videos/${encodeURIComponent(videoId)}`, 6000);
      if (r.statusCode !== 200 || !r.body || r.body.trim().startsWith('<')) continue;
      const json = JSON.parse(r.body);
      if (json && typeof json.hls === 'string' && json.hls) {
        return { url: json.hls, isM3U8: true, source: `invidious:${base}` };
      }
    } catch (_) {}
  }
  return null;
}

async function fromPiped(videoId) {
  for (const base of DEFAULT_PIPED) {
    try {
      const r = await requestText(`${base}/streams/${encodeURIComponent(videoId)}`, 6000);
      if (r.statusCode !== 200 || !r.body || r.body.trim().startsWith('<')) continue;
      const json = JSON.parse(r.body);
      if (json && typeof json.hls === 'string' && json.hls) {
        return { url: json.hls, isM3U8: true, source: `piped:${base}` };
      }
    } catch (_) {}
  }
  return null;
}

async function fromYtdlCore(videoId) {
  try {
    const mod = require('@ybd-project/ytdl-core');
    const YtdlCore = mod.YtdlCore || mod.default;
    const clientSets = [['TVHTML5'], ['IOS'], ['ANDROID'], ['MWEB'], ['WEB']];

    for (const clients of clientSets) {
      try {
        const ytdl = YtdlCore ? new YtdlCore({ clients }) : mod;
        const info = typeof (ytdl && ytdl.getBasicInfo) === 'function'
          ? await ytdl.getBasicInfo(`https://www.youtube.com/watch?v=${videoId}`)
          : await mod.getBasicInfo(`https://www.youtube.com/watch?v=${videoId}`);

        const hls = info && info.streamingData && info.streamingData.hlsManifestUrl;
        if (typeof hls === 'string' && hls) {
          return { url: hls, isM3U8: true, source: `ytdl-core:${clients[0]}` };
        }

        const formats = (info && info.formats) || [];
        const hlsFmt = formats.find(f => {
          const proto = String(f && f.protocol || '').toLowerCase();
          return f && f.url && (proto.startsWith('m3u8') || /\.m3u8(?:[?#]|$)/i.test(f.url));
        });
        if (hlsFmt) return { url: hlsFmt.url, isM3U8: true, source: `ytdl-core:${clients[0]}` };

        const muxed = formats
          .filter(f => f && f.url && (f.hasVideo || f.height || f.qualityLabel) && (f.hasAudio || f.audioQuality || f.audioBitrate))
          .sort((a, b) => (Number(b.height) || 0) - (Number(a.height) || 0));
        if (muxed[0] && muxed[0].url) {
          const mime = String(muxed[0].mimeType || '').toLowerCase();
          return {
            url: muxed[0].url,
            isM3U8: false,
            isRedirect: true,
            kind: mime.includes('webm') ? 'webm' : 'mp4',
            source: `ytdl-core:${clients[0]}`
          };
        }
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

async function getStreamUrl(videoId) {
  const normalizedId = extractVideoId(videoId);
  if (!normalizedId) return { url: null, isM3U8: false, source: 'none', error: 'invalid video id' };

  const cached = streamCache.get(normalizedId);
  if (cached && cached.expiresAt > Date.now()) return { ...cached.value, cached: true };

  const attempts = [];
  const resolvers = [
    ['yt-dlp', fromYtDlp],
    ['innertube', fromInnertube],
    ['invidious', fromInvidious],
    ['piped', fromPiped],
    ['ytdl-core', fromYtdlCore]
  ];

  for (const [name, resolver] of resolvers) {
    try {
      const result = await resolver(normalizedId);
      attempts.push({ source: result && result.source || name, ok: Boolean(result && result.url), error: result && result.error || null });
      if (result && result.url) {
        const value = { ...result, attempts };
        streamCache.set(normalizedId, { value, expiresAt: Date.now() + CACHE_MS });
        return value;
      }
    } catch (e) {
      attempts.push({ source: name, ok: false, error: e.message });
    }
  }

  return { url: null, isM3U8: false, source: 'none', attempts, error: 'No stream URL found' };
}

module.exports = { extractVideoId, buildProxyId, getStreamUrl };
