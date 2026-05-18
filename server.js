require('./env-loader');
var express = require('express');
var fetch = require('node-fetch');
var cors = require('cors');
var path = require('path');
var fs = require('fs');
var http = require('http');
var https = require('https');
var net = require('net');
var childProcess = require('child_process');
var spawn = childProcess.spawn;
var spawnSync = childProcess.spawnSync;
var exec = childProcess.exec;
var execFile = childProcess.execFile;
var crypto = require('crypto');
var createHash = crypto.createHash;
var randomUUID = typeof crypto.randomUUID === 'function'
  ? crypto.randomUUID.bind(crypto)
  : function () { return String(Date.now()) + '-' + String(Math.floor(Math.random() * 1000000)); };
var createStorage = require('./storage').createStorage;
var ytStream = require('./lib/yt-stream');

var app = express();
var PORT = Number(process.env.PORT || 3000);
var XTREAM_PORT = Number(process.env.XTREAM_PORT || 8080);
var DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');
var DATA_FILE = process.env.DATA_FILE
  ? path.resolve(process.env.DATA_FILE)
  : path.join(DATA_DIR, 'playlists.json');
var SETTINGS_FILE = process.env.SETTINGS_FILE
  ? path.resolve(process.env.SETTINGS_FILE)
  : path.join(DATA_DIR, 'server-config.json');
var STREAM_BASE_URL = normalizeStreamBaseUrl(process.env.STREAM_BASE_URL || '');
var DEFAULT_XTREAM_USER = String(process.env.XTREAM_USER || 'admin').trim() || 'admin';
var DEFAULT_XTREAM_PASS = String(process.env.XTREAM_PASS || 'admin').trim() || 'admin';
var ENABLE_TV_SERVER = process.env.ENABLE_TV_SERVER === '0' || process.env.VERCEL
  ? false
  : true;
var TV_DELIVERY_MODE = process.env.TV_DELIVERY_MODE === 'redirect' && process.env.ALLOW_REDIRECT_MODE === '1'
  ? 'redirect'
  : 'proxy';
var APP_READONLY = process.env.APP_READONLY === '1';
var FORCE_FILE_STORAGE = process.env.STORAGE_MODE === 'file' || process.env.FORCE_FILE_STORAGE === '1';
var youtubeCommandCache = undefined;
var youtubeProxyPythonCache = undefined;

function uniqueValues(values) {
  var seen = {};
  var result = [];

  values.forEach(function (value) {
    if (!value || seen[value]) {
      return;
    }
    seen[value] = true;
    result.push(value);
  });

  return result;
}

function setNoCacheHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
}

function getPlaylistRevision(playlists) {
  var lists = getTvOutputPlaylists(playlists || []);
  var max = 0;

  lists.forEach(function (playlist) {
    if (!playlist) {
      return;
    }
    var candidates = [playlist.updatedAt, playlist.meta && playlist.meta.tvPublishedAt, playlist.createdAt];
    candidates.forEach(function (value) {
      var stamp = Date.parse(String(value || ''));
      if (!Number.isNaN(stamp) && stamp > max) {
        max = stamp;
      }
    });
  });

  if (loopChannelsRevision && loopChannelsRevision > max) {
    max = loopChannelsRevision;
  }

  if (!max) {
    max = Date.now();
  }

  return max.toString(36);
}

function getCommandMatches(commandName) {
  if (process.platform !== 'win32') {
    return [commandName];
  }

  var result = spawnSync('where.exe', [commandName], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true
  });

  if (result.error || result.status !== 0) {
    return [commandName];
  }

  return uniqueValues(
    [commandName].concat(
      result.stdout
        .split(/\r?\n/)
        .map(function (line) {
          return String(line || '').trim();
        })
        .filter(Boolean)
    )
  );
}

function getPythonExecutablePath(venvName) {
  return process.platform === 'win32'
    ? path.join(__dirname, venvName, 'Scripts', 'python.exe')
    : path.join(__dirname, venvName, 'bin', 'python');
}

function getPythonCandidates() {
  return uniqueValues(
    [
      process.env.YOUTUBE_PYTHON,
      process.env.PYTHON,
      getPythonExecutablePath('.venv'),
      getPythonExecutablePath('.venv-1')
    ]
      .concat(getCommandMatches('python'))
      .concat(getCommandMatches('python3'))
      .filter(function (candidate) {
        return candidate && (candidate.indexOf(path.sep) === -1 || fs.existsSync(candidate));
      })
  );
}

function canRunCommand(command, args) {
  var result = spawnSync(command, args, {
    stdio: 'ignore',
    windowsHide: true
  });

  return !result.error && result.status === 0;
}

function canImportPythonModule(command, moduleName) {
  return canRunCommand(command, ['-c', 'import ' + moduleName]);
}

function resolveYouTubeCommand() {
  if (youtubeCommandCache !== undefined) {
    return youtubeCommandCache;
  }

  var ytDlpCandidates = getCommandMatches(process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
    .concat(getCommandMatches('yt-dlp'));
  var selectedBinary = uniqueValues(ytDlpCandidates).find(function (candidate) {
    return canRunCommand(candidate, ['--version']);
  });

  if (selectedBinary) {
    youtubeCommandCache = {
      command: selectedBinary,
      argsPrefix: [],
      label: selectedBinary
    };
    return youtubeCommandCache;
  }

  var selectedPython = getPythonCandidates().find(function (candidate) {
    return canImportPythonModule(candidate, 'yt_dlp');
  });

  if (!selectedPython) {
    youtubeCommandCache = null;
    return youtubeCommandCache;
  }

  youtubeCommandCache = {
    command: selectedPython,
    argsPrefix: ['-m', 'yt_dlp'],
    label: selectedPython + ' -m yt_dlp'
  };
  return youtubeCommandCache;
}

function resolveYouTubeProxyPython() {
  if (youtubeProxyPythonCache !== undefined) {
    return youtubeProxyPythonCache;
  }

  youtubeProxyPythonCache = getPythonCandidates().find(function (candidate) {
    return canImportPythonModule(candidate, 'flask') && canImportPythonModule(candidate, 'yt_dlp');
  }) || '';
  return youtubeProxyPythonCache;
}

function runYtDlp(youtubeUrl, callback) {
  var youtubeCommand = resolveYouTubeCommand();
  if (!youtubeCommand) {
    callback(new Error('yt-dlp bulunamadi. `python -m pip install -r requirements.txt` calistirin.'));
    return;
  }

  var args = youtubeCommand.argsPrefix.concat([
    '--no-check-certificate',
    '--geo-bypass',
    '--no-playlist',
    '-f', 'best[height<=720][ext=mp4]/best[height<=720]/best',
    '-g',
    youtubeUrl
  ]);

  execFile(youtubeCommand.command, args, {
    timeout: 45000,
    windowsHide: true
  }, function (error, stdout, stderr) {
    if (error) {
      callback(new Error(stderr || error.message));
      return;
    }

    var streamUrl = String(stdout || '').trim().split(/\r?\n/)[0];
    if (!streamUrl) {
      callback(new Error('YouTube stream URL bulunamadi'));
      return;
    }

    callback(null, streamUrl);
  });
}

function getFileMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs || 0;
  } catch (error) {
    return 0;
  }
}

function ensureTsxBundles() {
  if (process.env.VERCEL || process.env.SKIP_UI_BUILD === '1') {
    return;
  }

  var bundles = [
    {
      entry: path.join(__dirname, 'src', 'ui', 'editor.tsx'),
      out: path.join(__dirname, 'public', 'tsx', 'editor.js')
    },
    {
      entry: path.join(__dirname, 'src', 'ui', 'tv-server.tsx'),
      out: path.join(__dirname, 'public', 'tsx', 'tv-server.js')
    }
  ];

  var hasExistingBundles = bundles.every(function (bundle) {
    return fs.existsSync(bundle.out);
  });

  var shouldBuild = !hasExistingBundles || process.env.FORCE_REBUILD_UI === '1';
  if (!shouldBuild && hasExistingBundles) {
    var newestEntry = Math.max.apply(null, bundles.map(function (bundle) {
      return getFileMtimeMs(bundle.entry);
    }));
    var oldestOut = Math.min.apply(null, bundles.map(function (bundle) {
      return getFileMtimeMs(bundle.out);
    }));
    shouldBuild = newestEntry > oldestOut;
  }

  if (!shouldBuild) {
    return;
  }

  var result;
  try {
    result = spawnSync(process.execPath, [path.join(__dirname, 'scripts', 'build-ui.mjs')], {
      cwd: __dirname,
      stdio: 'inherit'
    });
  } catch (error) {
    // If build can't run but we have existing bundles, keep going.
    if (hasExistingBundles) {
      console.log('[UI] TSX derleme atlandi:', (error && error.message) ? error.message : String(error));
      return;
    }
    throw error;
  }

  if (result.status !== 0) {
    if (!hasExistingBundles) {
      throw new Error('TSX arayuzu derlenemedi.');
    }
  }
}

var youtubeProxyProcess = null;

function isLocalPortListening(port, callback) {
  var socket = new net.Socket();
  var finished = false;

  function done(result) {
    if (finished) {
      return;
    }
    finished = true;
    try {
      socket.destroy();
    } catch (error) {
      // ignore
    }
    callback(!!result);
  }

  socket.setTimeout(400);
  socket.once('connect', function () {
    done(true);
  });
  socket.once('timeout', function () {
    done(false);
  });
  socket.once('error', function () {
    done(false);
  });

  try {
    socket.connect(Number(port) || 0, '127.0.0.1');
  } catch (error) {
    done(false);
  }
}

function probeLocalJsonEndpoint(port, pathName, timeoutMs, callback) {
  var doneCalled = false;

  function done(payload) {
    if (doneCalled) {
      return;
    }
    doneCalled = true;
    callback(payload || null);
  }

  var req;
  try {
    req = http.request({
      hostname: '127.0.0.1',
      port: port,
      path: pathName,
      method: 'GET',
      timeout: timeoutMs || 500
    }, function (res) {
      var chunks = [];
      res.on('data', function (chunk) {
        chunks.push(chunk);
      });
      res.on('end', function () {
        if (res.statusCode !== 200) {
          done(null);
          return;
        }
        try {
          var text = Buffer.concat(chunks).toString('utf8');
          done(JSON.parse(text));
        } catch (error) {
          done(null);
        }
      });
    });
  } catch (error) {
    done(null);
    return;
  }

  req.on('timeout', function () {
    try {
      req.destroy();
    } catch (error) {
      // ignore
    }
    done(null);
  });

  req.on('error', function () {
    done(null);
  });

  try {
    req.end();
  } catch (error) {
    done(null);
  }
}

function stopYouTubeProxy() {
  if (!youtubeProxyProcess) {
    return;
  }

  var proc = youtubeProxyProcess;
  youtubeProxyProcess = null;

  try {
    proc.removeAllListeners('exit');
  } catch (error) {
    // ignore
  }

  try {
    if (!proc.killed) {
      proc.kill();
    }
  } catch (error) {
    // ignore
  }
}

var shutdownHooksInstalled = false;
function installShutdownHooks() {
  if (shutdownHooksInstalled) {
    return;
  }
  shutdownHooksInstalled = true;

  process.on('exit', function () {
    stopYouTubeProxy();
  });

  process.on('SIGINT', function () {
    stopYouTubeProxy();
    process.exit(0);
  });

  process.on('SIGTERM', function () {
    stopYouTubeProxy();
    process.exit(0);
  });
}

function startYouTubeProxy() {
  if (youtubeProxyProcess) {
    return;
  }

  var proxyScript = path.join(__dirname, 'youtube_proxy.py');
  if (!fs.existsSync(proxyScript)) {
    console.log('[YouTube Proxy] youtube_proxy.py bulunamadi, atlaniyor');
    return;
  }

  // Some environments (CI, restricted sandboxes, serverless) disallow child processes.
  // Don't crash the whole server if spawning the helper process isn't permitted.
  if (process.env.VERCEL) {
    console.log('[YouTube Proxy] Vercel ortaminda child process kapali, atlaniyor');
    return;
  }

  var pythonCmd = resolveYouTubeProxyPython();
  if (!pythonCmd) {
    console.log('[YouTube Proxy] Flask + yt-dlp bulunan bir Python yok, atlaniyor');
    return;
  }

  var proxyHost = String(process.env.YOUTUBE_PROXY_HOST || '0.0.0.0').trim() || '0.0.0.0';
  var proxyPort = Math.max(1, Number(process.env.YOUTUBE_PROXY_PORT || 5000) || 5000);

  isLocalPortListening(proxyPort, function (alreadyListening) {
    if (alreadyListening) {
      console.log('[YouTube Proxy] port ' + proxyPort + ' zaten kullanimda. Proxy zaten acik olabilir; atlaniyor.');
      return;
    }

    console.log('[YouTube Proxy] Baslatiliyor:', pythonCmd + ' (port ' + proxyPort + ')');

    try {
      youtubeProxyProcess = spawn(pythonCmd, [proxyScript], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        windowsHide: true,
        env: Object.assign({}, process.env, {
          YOUTUBE_PROXY_HOST: proxyHost,
          YOUTUBE_PROXY_PORT: String(proxyPort)
        })
      });
    } catch (error) {
      youtubeProxyProcess = null;
      console.log('[YouTube Proxy] Baslatma hatasi:', (error && error.message) ? error.message : String(error));
      return;
    }

    installShutdownHooks();

    youtubeProxyProcess.stdout.on('data', function(data) {
      console.log('[YouTube Proxy]', data.toString().trim());
    });

    youtubeProxyProcess.stderr.on('data', function(data) {
      console.log('[YouTube Proxy]', data.toString().trim());
    });

    youtubeProxyProcess.on('error', function(error) {
      console.log('[YouTube Proxy] Baslatma hatasi:', error.message);
    });

    youtubeProxyProcess.on('exit', function(code) {
      youtubeProxyProcess = null;
      if (code !== 0) {
        console.log('[YouTube Proxy] Cikis kodu:', code);
      }
    });

    console.log('[YouTube Proxy] PID:', youtubeProxyProcess.pid);
  });
}

function pickConnectionString() {
  var keys = [
    'DATABASE_URL',
    'POSTGRES_URL',
    'POSTGRES_PRISMA_URL',
    'POSTGRES_URL_NON_POOLING',
    'NEON_DATABASE_URL'
  ];
  var selected = '';
  keys.some(function (key) {
    var value = String(process.env[key] || '').trim();
    if (!value) {
      return false;
    }
    selected = value;
    return true;
  });
  return selected;
}

function getConnectionHost(connectionString) {
  try {
    return new URL(String(connectionString || '').trim()).hostname || '';
  } catch (error) {
    return '';
  }
}

function getDatabaseProviderLabel(connectionString) {
  var host = getConnectionHost(connectionString).toLowerCase();
  if (!host) {
    return '';
  }
  if (host.indexOf('supabase.com') !== -1) {
    return 'Supabase';
  }
  if (host.indexOf('neon.tech') !== -1) {
    return 'Neon';
  }
  return 'Postgres';
}

var DATABASE_CONNECTION_STRING = pickConnectionString();
var STORAGE_READONLY_REASON = !DATABASE_CONNECTION_STRING && process.env.VERCEL
  ? 'Kaydetme kapali: Vercel ortaminda veritabani baglantisi yok. Project Settings > Environment Variables icine DATABASE_URL ekleyip yeniden deploy et.'
  : APP_READONLY
    ? 'Kaydetme kapali: bu deployment salt okunur modda. Degisiklikleri yerel editor uzerinden yap ve Postgres uzerinden paylas.'
    : '';

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// The UI bundles under /tsx are generated locally and can change between runs.
// Avoid stale browser caches, especially for module scripts.
app.use('/tsx', function (req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
var PUBLIC_DIR = path.join(__dirname, 'public');
function setPublicStaticHeaders() {}
app.use(express.static(PUBLIC_DIR, { setHeaders: setPublicStaticHeaders }));
// Optional convenience: allow /public/* URLs to serve the same static files.
app.use('/public', express.static(PUBLIC_DIR, { setHeaders: setPublicStaticHeaders }));

// Suppress browser PWA manifest 404 noise
app.get('/manifest.json', function(req, res) {
  res.json({ name: 'IPTV Manager', short_name: 'IPTV', start_url: '/', display: 'standalone', background_color: '#0a1628', theme_color: '#0a1628' });
});

// Frontend SPA routes — serve HTML files for extensionless paths
app.get('/yt-channels', function(req, res) {
  res.sendFile(path.join(PUBLIC_DIR, 'yt-channels.html'));
});

var tokenCache = {};
var storage = createStorage({
  connectionString: FORCE_FILE_STORAGE ? '' : DATABASE_CONNECTION_STRING,
  playlistFile: DATA_FILE,
  settingsFile: SETTINGS_FILE,
  readOnlyReason: STORAGE_READONLY_REASON,
  forceFileStorage: FORCE_FILE_STORAGE,
  defaultUser: DEFAULT_XTREAM_USER,
  defaultPass: DEFAULT_XTREAM_PASS
});

app.get('/api/health', function (req, res) {
  var proxyPort = Math.max(1, Number(process.env.YOUTUBE_PROXY_PORT || 5000) || 5000);
  res.json({
    status: 'ok',
    now: new Date().toISOString(),
    webPort: PORT,
    tvPort: XTREAM_PORT,
    tvServerEnabled: ENABLE_TV_SERVER,
    youtubeProxyEnabled: process.env.ENABLE_YOUTUBE_PROXY !== '0',
    youtubeProxyPort: proxyPort,
    storage: storage.isDatabase ? 'database' : 'file',
    storageMode: storage.mode || (storage.isDatabase ? 'database' : 'file'),
    storageFallbackReason: storage.fallbackReason || ''
  });
});
var STALKER_MAG_USER_AGENT = 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG250';
var STALKER_STREAM_USER_AGENT = 'KSPlayer';
var VERCEL_DEPLOY_IN_PROGRESS = false;
var LAST_VERCEL_DEPLOY = null;
var FFMPEG_PATH = (function () {
  try {
    return require('ffmpeg-static') || 'ffmpeg';
  } catch (error) {
    return 'ffmpeg';
  }
})();
var PLAYLIST_CACHE_TTL_MS = Math.max(1000, Number(process.env.PLAYLIST_CACHE_TTL_MS || 15000) || 15000);
var SERVER_CONFIG_CACHE_TTL_MS = Math.max(1000, Number(process.env.SERVER_CONFIG_CACHE_TTL_MS || 15000) || 15000);
var NATIVE_CATALOG_CACHE_TTL_MS = Math.max(1000, Number(process.env.NATIVE_CATALOG_CACHE_TTL_MS || 15000) || 15000);
var OUTPUT_CACHE_TTL_MS = Math.max(1000, Number(process.env.OUTPUT_CACHE_TTL_MS || 15000) || 15000);
var playlistCacheState = {
  value: null,
  expiresAt: 0,
  pending: null,
  version: 0
};
var playlistSummaryCacheState = {
  value: null,
  expiresAt: 0,
  pending: null,
  version: 0
};
var serverConfigCacheState = {
  value: null,
  expiresAt: 0,
  pending: null
};
var nativeCatalogCacheState = {};
var outputDataCacheState = {
  value: null,
  expiresAt: 0,
  pending: null,
  version: -1
};
var streamIndexCacheState = {
  value: null,
  expiresAt: 0,
  pending: null,
  version: -1
};

function resetDerivedCatalogCaches() {
  nativeCatalogCacheState = {};
  outputDataCacheState = {
    value: null,
    expiresAt: 0,
    pending: null,
    version: -1
  };
  streamIndexCacheState = {
    value: null,
    expiresAt: 0,
    pending: null,
    version: -1
  };
}

function invalidatePlaylistCaches() {
  playlistCacheState.value = null;
  playlistCacheState.expiresAt = 0;
  playlistCacheState.pending = null;
  playlistSummaryCacheState.value = null;
  playlistSummaryCacheState.expiresAt = 0;
  playlistSummaryCacheState.pending = null;
  playlistCacheState.version += 1;
  playlistSummaryCacheState.version = playlistCacheState.version;
  resetDerivedCatalogCaches();
}

function invalidateServerConfigCache() {
  serverConfigCacheState.value = null;
  serverConfigCacheState.expiresAt = 0;
  serverConfigCacheState.pending = null;
}

async function loadPlaylists(options) {
  var force = !!(options && options.force);
  if (!force && playlistCacheState.value && playlistCacheState.expiresAt > Date.now()) {
    return playlistCacheState.value;
  }
  if (!force && playlistCacheState.pending) {
    return playlistCacheState.pending;
  }

  playlistCacheState.pending = storage.listPlaylists()
    .then(function (playlists) {
      playlistCacheState.value = playlists;
      playlistCacheState.expiresAt = Date.now() + PLAYLIST_CACHE_TTL_MS;
      playlistCacheState.pending = null;
      return playlists;
    })
    .catch(function (error) {
      playlistCacheState.pending = null;
      throw error;
    });

  return playlistCacheState.pending;
}

async function loadPlaylistSummaries(options) {
  var force = !!(options && options.force);
  if (!force && playlistSummaryCacheState.value && playlistSummaryCacheState.expiresAt > Date.now()) {
    return playlistSummaryCacheState.value;
  }
  if (!force && playlistSummaryCacheState.pending) {
    return playlistSummaryCacheState.pending;
  }

  playlistSummaryCacheState.pending = storage.listPlaylistSummaries()
    .then(function (summaries) {
      playlistSummaryCacheState.value = summaries;
      playlistSummaryCacheState.expiresAt = Date.now() + PLAYLIST_CACHE_TTL_MS;
      playlistSummaryCacheState.pending = null;
      playlistSummaryCacheState.version = playlistCacheState.version;
      return summaries;
    })
    .catch(function (error) {
      playlistSummaryCacheState.pending = null;
      throw error;
    });

  return playlistSummaryCacheState.pending;
}

async function loadPlaylistById(id) {
  return storage.getPlaylist(id);
}

async function createPlaylistRecord(playlist) {
  var result = await storage.createPlaylist(playlist);
  invalidatePlaylistCaches();
  return result;
}

async function updatePlaylistRecord(id, patch) {
  var result = await storage.updatePlaylist(id, patch);
  invalidatePlaylistCaches();
  return result;
}

async function deletePlaylistRecord(id) {
  var result = await storage.deletePlaylist(id);
  invalidatePlaylistCaches();
  return result;
}

async function getServerCredentials() {
  if (serverConfigCacheState.value && serverConfigCacheState.expiresAt > Date.now()) {
    return serverConfigCacheState.value;
  }
  if (serverConfigCacheState.pending) {
    return serverConfigCacheState.pending;
  }

  serverConfigCacheState.pending = storage.getServerConfig()
    .then(function (config) {
      serverConfigCacheState.value = config;
      serverConfigCacheState.expiresAt = Date.now() + SERVER_CONFIG_CACHE_TTL_MS;
      serverConfigCacheState.pending = null;
      return config;
    })
    .catch(function (error) {
      serverConfigCacheState.pending = null;
      throw error;
    });

  return serverConfigCacheState.pending;
}

async function saveServerCredentials(config) {
  var result = await storage.saveServerConfig(config);
  invalidateServerConfigCache();
  return result;
}

function safeTrim(value) {
  return String(value || '').trim();
}

function pickFirstNonEmpty(source, keys) {
  var selected = '';
  (keys || []).some(function (key) {
    var value = source && source[key];
    if (value == null) {
      return false;
    }
    if (typeof value === 'string' && !value.trim()) {
      return false;
    }
    selected = value;
    return true;
  });
  return selected;
}

function pickFirstNonEmptyText(source, keys) {
  return safeTrim(pickFirstNonEmpty(source, keys));
}

function pickItemImage(item) {
  return pickFirstNonEmptyText(item, [
    'logo',
    'stream_icon',
    'cover',
    'cover_big',
    'movie_image',
    'screenshot_uri',
    'screenshot_url',
    'pic',
    'poster'
  ]);
}

function pickItemPlot(item) {
  return pickFirstNonEmptyText(item, ['plot', 'description', 'overview', 'comments']);
}

function normalizeDefaultPortUrl(raw) {
  var value = safeTrim(raw);
  if (!value) {
    return '';
  }

  try {
    var parsed = new URL(value);
    if ((parsed.protocol === 'http:' && parsed.port === '80') || (parsed.protocol === 'https:' && parsed.port === '443')) {
      parsed.port = '';
    }
    return parsed.toString();
  } catch (error) {
    return value.replace(/\/+$/, '');
  }
}

function normalizeSourceEndpoint(raw) {
  var value = normalizeDefaultPortUrl(raw);
  if (!value) {
    return '';
  }

  try {
    var parsed = new URL(value);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString().replace(/\/+$/, '');
  } catch (error) {
    return value.replace(/\/+$/, '');
  }
}

function normalizeOutputText(value) {
  return safeTrim(value).toLowerCase().replace(/\s+/g, ' ');
}

function getOutputItemSourceType(item, playlist) {
  return safeTrim(item && item.sourceType) || safeTrim(playlist && playlist.type);
}

function getOutputItemSourceMeta(item, playlist) {
  return (item && item.sourceMeta && typeof item.sourceMeta === 'object')
    ? item.sourceMeta
    : ((playlist && playlist.meta && typeof playlist.meta === 'object') ? playlist.meta : {});
}

function getOutputItemSourceEndpoint(item, playlist) {
  var sourceMeta = getOutputItemSourceMeta(item, playlist);
  return normalizeSourceEndpoint(
    sourceMeta.host ||
    sourceMeta.url ||
    sourceMeta.portalUrl ||
    (playlist && playlist.meta && (playlist.meta.host || playlist.meta.url || playlist.meta.portalUrl)) ||
    ''
  );
}

function getOutputDuplicateKey(kind, playlist, item) {
  var sourceType = getOutputItemSourceType(item, playlist) || 'unknown';
  var sourceEndpoint = getOutputItemSourceEndpoint(item, playlist);
  var title = normalizeOutputText(item && item.name);
  var rawCmd = normalizeDefaultPortUrl(item && (item.sourceCmd || item.cmd || item.direct_source || item.originalUrl));
  var id = safeTrim(item && item.id);

  if (sourceEndpoint && title) {
    return [kind, sourceType, sourceEndpoint, title].join('|');
  }
  if (rawCmd) {
    return [kind, sourceType, rawCmd].join('|');
  }
  return [kind, sourceType, id, title].join('|');
}

function createOutputDeduper() {
  var seen = {};
  return function shouldIncludeOutputItem(kind, playlist, item) {
    var key = getOutputDuplicateKey(kind, playlist, item);
    if (!key || key === [kind, 'unknown', '', ''].join('|')) {
      return true;
    }
    if (seen[key]) {
      return false;
    }
    seen[key] = true;
    return true;
  };
}

function stableHashText(value) {
  var text = safeTrim(value);
  var hash = 0;
  for (var index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

function parseDateValueMs(value) {
  if (value == null || value === '') {
    return 0;
  }

  if (value instanceof Date) {
    return isNaN(value.getTime()) ? 0 : value.getTime();
  }

  var text = String(value).trim();
  if (!text || text === '0' || text === 'null' || text === 'undefined') {
    return 0;
  }

  if (/^\d+$/.test(text)) {
    var numeric = Number(text);
    if (!isFinite(numeric) || numeric <= 0) {
      return 0;
    }
    if (text.length >= 13) {
      return numeric;
    }
    if (text.length >= 10) {
      return numeric * 1000;
    }
    return 0;
  }

  var parsed = Date.parse(text.replace(/\//g, '-'));
  return isNaN(parsed) ? 0 : parsed;
}

function toIsoDateStringOrEmpty(value) {
  var ms = parseDateValueMs(value);
  return ms ? new Date(ms).toISOString() : '';
}

function cleanMetaObject(source) {
  var output = {};
  Object.keys(source || {}).forEach(function (key) {
    var value = source[key];
    if (value == null) {
      return;
    }
    if (typeof value === 'string' && !value.trim()) {
      return;
    }
    output[key] = typeof value === 'string' ? value.trim() : value;
  });
  return output;
}

function getHiddenCategoryMap(playlist) {
  var hiddenCategories = playlist && playlist.meta && playlist.meta.hiddenCategories;
  var result = { live: {}, movies: {}, series: {} };

  ['live', 'movies', 'series'].forEach(function (kind) {
    var groups = hiddenCategories && hiddenCategories[kind];
    if (!groups || typeof groups !== 'object') {
      return;
    }
    Object.keys(groups).forEach(function (groupName) {
      if (groups[groupName]) {
        result[kind][groupName] = true;
      }
    });
  });

  return result;
}

function isPlaylistCategoryHidden(playlist, kind, groupName) {
  var hiddenMap = getHiddenCategoryMap(playlist);
  return !!(hiddenMap[kind] && hiddenMap[kind][groupName]);
}

function isPlaylistPublishedToTv(playlist) {
  return !!(playlist && playlist.meta && playlist.meta.tvPublished);
}

function isCuratedOutputPlaylist(playlist) {
  return !!(
    playlist &&
    (
      playlist.type === 'custom' ||
      playlist.type === 'playlist' ||
      (playlist.meta && playlist.meta.playlistBucket === 'curated')
    )
  );
}

function getTvOutputPlaylists(playlists) {
  var available = (playlists || []).filter(function (playlist) {
    return !!(playlist && playlist.data);
  });
  var published = available.filter(isPlaylistPublishedToTv);
  if (published.length) {
    return published;
  }

  var curated = available.filter(isCuratedOutputPlaylist);
  return curated.length ? curated : available;
}

function buildXtreamAccountMeta(loginData) {
  var userInfo = loginData && loginData.user_info ? loginData.user_info : {};
  var expireRaw = pickFirstNonEmpty(userInfo, ['exp_date', 'expiration', 'expires']);
  var accountStatus = pickFirstNonEmpty(userInfo, ['status', 'message']);

  return cleanMetaObject({
    expireAt: toIsoDateStringOrEmpty(expireRaw),
    expireRaw: expireRaw,
    accountStatus: accountStatus,
    maxConnections: pickFirstNonEmpty(userInfo, ['max_connections'])
  });
}

function normalizeMacAddress(macAddress) {
  return String(macAddress || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/-/g, ':')
    .toUpperCase();
}

function encodeStalkerCmdParam(cmd) {
  return encodeURIComponent(String(cmd || '').trim())
    .replace(/%3A/gi, ':')
    .replace(/%2F/gi, '/');
}

function deriveStalkerIdentity(macAddress) {
  var normalizedMac = normalizeMacAddress(macAddress);
  var md5 = createHash('md5').update(normalizedMac).digest('hex');
  var serialNumber = md5.slice(0, 13).toUpperCase();
  var serialPrefix = serialNumber.toLowerCase().replace(/[^a-f0-9]/g, '');
  var cfduid = (serialPrefix + md5.slice(serialPrefix.length)).slice(0, 32);

  return {
    serialNumber: serialNumber,
    cfduid: cfduid
  };
}

function getOrigin(rawUrl) {
  try {
    var parsed = new URL(rawUrl);
    return parsed.origin;
  } catch (error) {
    return '';
  }
}

function isLoopbackHost(hostname) {
  var host = String(hostname || '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0';
}

function isFullStalkerPortal(portalUrl) {
  var value = safeTrim(portalUrl);
  return value.indexOf('/stalker_portal/') !== -1 ||
    value.indexOf('/server/load.php') !== -1 ||
    /\/portal\.php(?:\?|$)/i.test(value);
}

function resolveStalkerEndpoint(portalUrl) {
  var normalized = safeTrim(portalUrl).replace(/\/+$/, '');
  if (!normalized) {
    return '';
  }
  if (/\.php(?:\?.*)?$/i.test(normalized)) {
    return normalized;
  }
  return normalized + '/portal.php';
}

function buildStalkerRequestUrl(portalUrl, params) {
  var endpoint = resolveStalkerEndpoint(portalUrl);
  var queryParts = [];

  Object.keys(params || {}).forEach(function (key) {
    if (key === 'cmd') {
      queryParts.push(key + '=' + encodeStalkerCmdParam(params[key]));
      return;
    }
    queryParts.push(key + '=' + encodeURIComponent(params[key]));
  });

  if (!(params || {}).JsHttpRequest) {
    queryParts.push('JsHttpRequest=1-xml');
  }

  return endpoint + '?' + queryParts.join('&');
}

function stalkerHeaders(mac, token, targetUrl, serialNumber, cfduid) {
  var origin = getOrigin(targetUrl);
  var headers = {
    'User-Agent': STALKER_MAG_USER_AGENT,
    'X-User-Agent': STALKER_MAG_USER_AGENT,
    Accept: '*/*',
    Connection: 'keep-alive',
    'Accept-Language': 'en-US,en;q=0.9',
    Cookie: 'mac=' + normalizeMacAddress(mac) + '; stb_lang=en_US@rg=dezzzz; timezone=Europe/Berlin' + (cfduid ? '; __cfduid=' + cfduid : '')
  };

  if (token) {
    headers.Authorization = 'Bearer ' + token;
  }
  if (serialNumber) {
    headers.SN = serialNumber;
  }
  if (origin) {
    headers.Origin = origin;
    headers.Referer = origin;
  }

  return headers;
}

async function readJsonResponse(response) {
  var text = await response.text();
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error('Gecersiz JSON yaniti: ' + text.slice(0, 200));
  }
}

async function getStalkerToken(portalUrl, mac) {
  var endpoint = resolveStalkerEndpoint(portalUrl);
  var normalizedMac = normalizeMacAddress(mac);
  var cacheKey = endpoint + '__' + normalizedMac;
  var identity = deriveStalkerIdentity(normalizedMac);
  if (tokenCache[cacheKey] && tokenCache[cacheKey].token) {
    return tokenCache[cacheKey].token;
  }

  var handshakeUrl = buildStalkerRequestUrl(endpoint, {
    type: 'stb',
    action: 'handshake',
    JsHttpRequest: '1-xml'
  });

  var response = await fetch(handshakeUrl, {
    headers: stalkerHeaders(normalizedMac, '', handshakeUrl, identity.serialNumber, identity.cfduid),
    timeout: 15000
  });
  var data = await readJsonResponse(response);
  var token = data && data.js && data.js.token ? data.js.token : '';

  if (!token && isFullStalkerPortal(endpoint)) {
    throw new Error('Stalker token alinamadi');
  }

  if (token) {
    tokenCache[cacheKey] = { token: token };
  }
  return token;
}

async function stalkerCall(portalUrl, mac, params) {
  var endpoint = resolveStalkerEndpoint(portalUrl);
  var normalizedMac = normalizeMacAddress(mac);
  var cacheKey = endpoint + '__' + normalizedMac;
  var identity = deriveStalkerIdentity(normalizedMac);
  var action = params && params.action ? params.action : '';
  var token = '';

  if (action !== 'handshake') {
    token = await getStalkerToken(endpoint, normalizedMac);
  }

  var requestUrl = buildStalkerRequestUrl(endpoint, params || {});
  var response = await fetch(requestUrl, {
    headers: stalkerHeaders(normalizedMac, token, requestUrl, identity.serialNumber, identity.cfduid),
    timeout: action === 'create_link' ? 30000 : 20000
  });
  var data = await readJsonResponse(response);

  if (action === 'handshake' && data && data.js && data.js.token) {
    tokenCache[cacheKey] = { token: data.js.token };
  }

  return data;
}

function normalizeStreamUrl(raw, portalUrl) {
  var cleaned = safeTrim(raw)
    .replace(/^ffmpeg\s+/i, '')
    .replace(/^auto\s+/i, '')
    .replace(/^mpegts\s+/i, '')
    .replace(/^ffrt\s+/i, '')
    .replace(/^["']|["']$/g, '')
    .trim();

  if (!cleaned) {
    return '';
  }

  var urlMatch = cleaned.match(/https?:\/\/\S+/i);
  if (urlMatch) {
    cleaned = urlMatch[0];
  } else if (/^\/\S+/.test(cleaned)) {
    cleaned = cleaned.match(/^\/\S+/)[0];
  }

  var portal;
  try {
    portal = new URL(portalUrl);
  } catch (error) {
    portal = null;
  }

  if (/^\/\//.test(cleaned) && portal) {
    cleaned = portal.protocol + cleaned;
  } else if (/^\//.test(cleaned) && portal) {
    cleaned = portal.origin + cleaned;
  } else if (!/^https?:\/\//i.test(cleaned) && /^[a-z0-9.-]+\/\S+/i.test(cleaned) && portal) {
    cleaned = portal.protocol + '//' + cleaned;
  }

  try {
    var parsed = new URL(cleaned);
    if (portal && isLoopbackHost(parsed.hostname) && !isLoopbackHost(portal.hostname)) {
      parsed.protocol = portal.protocol;
      parsed.host = portal.host;
      cleaned = parsed.toString();
    } else {
      cleaned = parsed.toString();
    }
  } catch (error) {
    if (portal) {
      try {
        cleaned = new URL(cleaned, portal.origin).toString();
      } catch (innerError) {
        return '';
      }
    } else {
      return '';
    }
  }

  return cleaned;
}

function shouldResolveStalkerCmd(cmd) {
  var value = safeTrim(cmd);
  if (!value) {
    return true;
  }
  return /^(?:ffmpeg|ffrt|auto|mpegts)\s+/i.test(value) ||
    value.indexOf('localhost') !== -1 ||
    value.indexOf('127.0.0.1') !== -1 ||
    value.charAt(0) === '/';
}

function getStalkerDirectStreamUrl(portalUrl, cmd) {
  var rawCmd = safeTrim(cmd);
  if (!rawCmd || shouldResolveStalkerCmd(rawCmd)) {
    return '';
  }
  return normalizeStreamUrl(rawCmd, portalUrl);
}

function getSeriesSeasonNumber(seriesItem) {
  var rawId = safeTrim(seriesItem && seriesItem.id);
  if (!rawId) {
    return 0;
  }
  var parts = rawId.split(':');
  var value = parseInt(parts[parts.length - 1], 10);
  return isFinite(value) ? value : 0;
}

function pickPreferredSeriesSeason(seriesItems) {
  return pickPreferredSeriesSeasonForNumber(seriesItems, 0);
}

function pickPreferredSeriesSeasonForNumber(seriesItems, preferredSeasonNumber) {
  var best = null;
  var bestRank = -1;

  (seriesItems || []).forEach(function (item) {
    var cmd = safeTrim(item && item.cmd);
    if (!cmd) {
      return;
    }
    var rank = getSeriesSeasonNumber(item);
    if (preferredSeasonNumber && rank !== preferredSeasonNumber) {
      return;
    }
    if (!best || rank >= bestRank) {
      best = item;
      bestRank = rank;
    }
  });

  return best;
}

function pickPreferredSeriesEpisode(seriesItem, preferredEpisodeNumber) {
  if (preferredEpisodeNumber) {
    return preferredEpisodeNumber;
  }

  var episodes = Array.isArray(seriesItem && seriesItem.series) ? seriesItem.series : [];
  var preferred = 0;

  episodes.forEach(function (value) {
    var numeric = parseInt(value, 10);
    if (isFinite(numeric) && numeric > preferred) {
      preferred = numeric;
    }
  });

  return preferred || 1;
}

async function fetchStalkerSeriesSeasons(portalUrl, mac, itemId) {
  var lookupId = safeTrim(itemId);
  if (!lookupId) {
    throw new Error('Stalker dizi kimligi bulunamadi');
  }

  var seasonList = await stalkerCall(portalUrl, mac, {
    type: 'series',
    action: 'get_ordered_list',
    movie_id: lookupId,
    p: 1,
    JsHttpRequest: '1-xml'
  });

  return seasonList && seasonList.js && Array.isArray(seasonList.js.data) ? seasonList.js.data : [];
}

async function resolveStalkerSeriesStream(portalUrl, mac, rawCmd, itemId, options) {
  var playbackOptions = options || {};
  var seasonCmd = safeTrim(rawCmd);
  var preferredEpisode = parseInt(playbackOptions.preferredEpisodeNumber, 10) || 0;

  if (!seasonCmd || playbackOptions.preferredSeasonNumber) {
    var seasons = await fetchStalkerSeriesSeasons(portalUrl, mac, itemId);
    var preferredSeason = pickPreferredSeriesSeasonForNumber(
      seasons,
      parseInt(playbackOptions.preferredSeasonNumber, 10) || 0
    );

    if (!preferredSeason) {
      throw new Error('Stalker dizi sezonu bulunamadi');
    }

    seasonCmd = safeTrim(preferredSeason.cmd);
    preferredEpisode = pickPreferredSeriesEpisode(preferredSeason, preferredEpisode);
  }

  var episodeCandidates = [];
  if (preferredEpisode) {
    episodeCandidates.push(String(preferredEpisode));
  }
  if (episodeCandidates.indexOf('1') === -1) {
    episodeCandidates.push('1');
  }

  var resolvedRaw = '';
  for (var index = 0; index < episodeCandidates.length; index += 1) {
    var episodeNumber = episodeCandidates[index];
    try {
      var data = await stalkerCall(portalUrl, mac, {
        type: 'vod',
        action: 'create_link',
        cmd: seasonCmd,
        series: episodeNumber,
        forced_storage: 'undefined',
        disable_ad: 0,
        download: 0,
        JsHttpRequest: '1-xml'
      });
      resolvedRaw = data && data.js && data.js.cmd ? data.js.cmd : '';
      if (normalizeStreamUrl(resolvedRaw, portalUrl)) {
        break;
      }
    } catch (error) {
      if (index === episodeCandidates.length - 1) {
        throw error;
      }
    }
  }

  var streamUrl = normalizeStreamUrl(resolvedRaw, portalUrl);
  if (!streamUrl) {
    throw new Error('Stalker dizi yayin URL alinamadi');
  }

  return {
    streamUrl: streamUrl,
    playbackHeaders: buildStalkerPlaybackHeaders(portalUrl, mac, streamUrl)
  };
}

async function resolveStalkerPlaybackTarget(portalUrl, mac, kind, rawCmd, itemId, options) {
  var directStreamUrl = getStalkerDirectStreamUrl(portalUrl, rawCmd);
  if (directStreamUrl) {
    return {
      streamUrl: directStreamUrl,
      playbackHeaders: buildStalkerPlaybackHeaders(portalUrl, mac, directStreamUrl)
    };
  }

  if (kind === 'series') {
    return resolveStalkerSeriesStream(portalUrl, mac, rawCmd, itemId, options || {});
  }

  if (!safeTrim(rawCmd)) {
    throw new Error('Stalker komutu bulunamadi');
  }

  var typeMap = { live: 'itv', movies: 'vod', series: 'series' };
  var apiType = typeMap[kind] || kind;
  var data = await stalkerCall(portalUrl, mac, {
    type: apiType,
    action: 'create_link',
    cmd: rawCmd,
    series: '',
    forced_storage: 'undefined',
    disable_ad: 0,
    download: 0,
    JsHttpRequest: '1-xml'
  });
  var resolvedRaw = data && data.js && data.js.cmd ? data.js.cmd : '';
  var streamUrl = normalizeStreamUrl(resolvedRaw, portalUrl);

  if (!streamUrl) {
    throw new Error('Stalker yayin URL alinamadi');
  }

  return {
    streamUrl: streamUrl,
    playbackHeaders: buildStalkerPlaybackHeaders(portalUrl, mac, streamUrl)
  };
}

function isDirectTokenizedStalkerStream(streamUrl) {
  try {
    var parsedUrl = new URL(streamUrl);
    var normalizedPath = parsedUrl.pathname.toLowerCase();
    var hasPlayToken = parsedUrl.searchParams.has('play_token');
    var hasMac = parsedUrl.searchParams.has('mac');
    var hasStream = parsedUrl.searchParams.has('stream');
    var extension = safeTrim(parsedUrl.searchParams.get('extension')).toLowerCase();

    return normalizedPath.endsWith('/play/live.php') && (hasPlayToken || (hasMac && hasStream)) && (!extension || extension === 'ts');
  } catch (error) {
    return false;
  }
}

function isYouTubeUrl(url) {
  var normalized = String(url || '').trim().toLowerCase();
  return normalized.indexOf('youtube.com/watch') !== -1 ||
         normalized.indexOf('youtu.be/') !== -1 ||
         normalized.indexOf('youtube.com/live/') !== -1 ||
         normalized.indexOf('youtube.com/shorts/') !== -1;
}

function buildYouTubeProxyId(videoId) {
  var id = safeTrim(videoId);
  return /^[A-Za-z0-9_-]{11}$/.test(id) ? ('yt_' + id) : '';
}

function buildYouTubeProxyPath(videoId) {
  var proxyId = buildYouTubeProxyId(videoId);
  return proxyId ? ('/proxy/' + proxyId) : '';
}

function buildYouTubeProxyUrl(baseUrl, videoId) {
  var proxyPath = buildYouTubeProxyPath(videoId);
  return proxyPath ? (String(baseUrl || '').replace(/\/+$/, '') + proxyPath) : '';
}

function isYouTubeProxyUrl(url) {
  try {
    var parsed = new URL(String(url || ''), 'http://local.invalid');
    return /^\/proxy\/yt_[A-Za-z0-9_-]{11}$/.test(parsed.pathname);
  } catch (_) {
    return /^\/proxy\/yt_[A-Za-z0-9_-]{11}(?:[?#]|$)/.test(String(url || ''));
  }
}

function isGoogleVideoUrl(url) {
  var normalized = String(url || '').trim().toLowerCase();
  return normalized.indexOf('googlevideo.com/') !== -1 ||
         normalized.indexOf('manifest.googlevideo.com/') !== -1;
}

function isCrossOriginStalkerStream(portalUrl, streamUrl) {
  try {
    return new URL(portalUrl).origin !== new URL(streamUrl).origin;
  } catch (error) {
    return false;
  }
}

function buildStalkerPlaybackHeaders(portalUrl, mac, streamUrl) {
  if (!mac || !streamUrl) {
    return {};
  }
  var identity = deriveStalkerIdentity(mac);
  var endpoint = resolveStalkerEndpoint(portalUrl);
  var cacheKey = endpoint + '__' + normalizeMacAddress(mac);
  var token = tokenCache[cacheKey] ? tokenCache[cacheKey].token : '';

  if (isDirectTokenizedStalkerStream(streamUrl)) {
    var directHeaders = stalkerHeaders(mac, token, streamUrl, identity.serialNumber, identity.cfduid);
    return directHeaders;
  }

  if (isCrossOriginStalkerStream(portalUrl, streamUrl)) {
    return {
      'User-Agent': STALKER_STREAM_USER_AGENT,
      Accept: '*/*',
      Connection: 'keep-alive'
    };
  }

  return stalkerHeaders(mac, isFullStalkerPortal(endpoint) ? token : '', streamUrl, identity.serialNumber, identity.cfduid);
}

function parseProxyHeaders(rawHeaders) {
  if (!rawHeaders) {
    return {};
  }

  try {
    var parsed = JSON.parse(rawHeaders);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    var normalized = {};
    Object.keys(parsed).forEach(function (key) {
      var value = safeTrim(parsed[key]);
      if (value) {
        normalized[key] = value;
      }
    });
    return normalized;
  } catch (error) {
    return {};
  }
}

function setCommonProxyHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Type, Content-Length, Content-Range');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
}

function setProxyHeaders(res, upstream) {
  var passHeaders = [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
    'cache-control',
    'last-modified',
    'etag'
  ];

  passHeaders.forEach(function (header) {
    var value = upstream.headers.get(header);
    if (value) {
      res.setHeader(header, value);
    }
  });

  setCommonProxyHeaders(res);
}

function setNodeResponseProxyHeaders(res, headers) {
  var passHeaders = [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
    'cache-control',
    'last-modified',
    'etag'
  ];

  passHeaders.forEach(function (header) {
    var value = headers ? headers[header] : '';
    if (value) {
      res.setHeader(header, value);
    }
  });

  setCommonProxyHeaders(res);
}

function buildRuntimeBaseUrl(req) {
  return req.protocol + '://' + req.get('host');
}

function buildInternalAppBaseUrl() {
  return 'http://127.0.0.1:' + String(PORT);
}

function buildProxyStreamUrl(req, targetUrl, headers, mac) {
  var proxyUrl = buildRuntimeBaseUrl(req) + '/stream?url=' + encodeURIComponent(targetUrl);

  if (mac) {
    proxyUrl += '&mac=' + encodeURIComponent(mac);
  }

  if (headers && Object.keys(headers).length) {
    proxyUrl += '&headers=' + encodeURIComponent(JSON.stringify(headers));
  }

  return proxyUrl;
}

function buildInternalProxyStreamUrl(targetUrl, headers, mac) {
  var proxyUrl = buildInternalAppBaseUrl() + '/stream?url=' + encodeURIComponent(targetUrl);

  if (mac) {
    proxyUrl += '&mac=' + encodeURIComponent(mac);
  }

  if (headers && Object.keys(headers).length) {
    proxyUrl += '&headers=' + encodeURIComponent(JSON.stringify(headers));
  }

  return proxyUrl;
}

function buildCompatStreamUrl(req, targetUrl, headers, mac) {
  var compatUrl = buildRuntimeBaseUrl(req) + '/stream/compat?url=' + encodeURIComponent(targetUrl);

  if (mac) {
    compatUrl += '&mac=' + encodeURIComponent(mac);
  }

  if (headers && Object.keys(headers).length) {
    compatUrl += '&headers=' + encodeURIComponent(JSON.stringify(headers));
  }

  return compatUrl;
}

function getExtensionFromUrl(rawUrl) {
  var text = safeTrim(rawUrl);
  if (!text) {
    return '';
  }

  // Handle relative URLs/paths like "/hls/..." without relying on URL()
  var withoutHash = text.split('#')[0];
  var withoutQuery = withoutHash.split('?')[0];
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(withoutQuery) && !withoutQuery.startsWith('//')) {
    var relativeMatch = withoutQuery.match(/\.([a-z0-9]+)$/i);
    return relativeMatch ? relativeMatch[1].toLowerCase() : '';
  }

  try {
    var pathname = new URL(text).pathname;
    var match = pathname.match(/\.([a-z0-9]+)$/i);
    return match ? match[1].toLowerCase() : '';
  } catch (error) {
    return '';
  }
}

function inferStreamKind(targetUrl, contentType) {
  var normalizedType = String(contentType || '').toLowerCase();
  var extension = getExtensionFromUrl(targetUrl);

  if (
    normalizedType.indexOf('application/vnd.apple.mpegurl') !== -1 ||
    normalizedType.indexOf('application/x-mpegurl') !== -1 ||
    extension === 'm3u' ||
    extension === 'm3u8'
  ) {
    return 'hls';
  }

  if (
    normalizedType.indexOf('video/mp2t') !== -1 ||
    normalizedType.indexOf('application/mp2t') !== -1 ||
    ['mpegts', 'm2ts', 'mts', 'mpg', 'mpeg', 'ts'].indexOf(extension) !== -1 ||
    /\/play\/live\.php/i.test(String(targetUrl || '')) ||
    /\/live\/play\//i.test(String(targetUrl || ''))
  ) {
    return 'mpegts';
  }

  if (
    normalizedType.indexOf('application/dash+xml') !== -1 ||
    extension === 'mpd'
  ) {
    return 'dash';
  }

  if (
    normalizedType.indexOf('audio/') === 0 ||
    ['aac', 'flac', 'm4a', 'mp3', 'oga', 'ogg', 'wav'].indexOf(extension) !== -1
  ) {
    return 'audio';
  }

  if (
    normalizedType.indexOf('video/') === 0 ||
    ['avi', 'flv', 'm4v', 'mkv', 'mov', 'mp4', 'mpeg4', 'webm'].indexOf(extension) !== -1
  ) {
    return 'video';
  }

  return 'unknown';
}

function buildSingleVariantHlsMasterPlaylist(streamUrl) {
  var url = safeTrim(streamUrl);
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720',
    url
  ].join('\n');
}

function sendSingleVariantHlsMaster(res, streamUrl) {
  setCommonProxyHeaders(res);
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
  res.status(200).send(buildSingleVariantHlsMasterPlaylist(streamUrl));
}

function getStreamMimeType(targetUrl, contentType, kind) {
  var normalizedType = String(contentType || '').trim();
  var extension;

  if (normalizedType) {
    return normalizedType;
  }

  switch (kind) {
    case 'hls':
      return 'application/x-mpegURL';
    case 'mpegts':
      return 'video/mp2t';
    case 'dash':
      return 'application/dash+xml';
    case 'audio':
      return 'audio/mpeg';
    case 'video':
      extension = getExtensionFromUrl(targetUrl);
      if (extension === 'webm') return 'video/webm';
      if (extension === 'mkv') return 'video/x-matroska';
      return 'video/mp4';
    default:
      return 'video/mp4';
  }
}

function isStalkerLiveRequestHeaders(headers) {
  var userAgent = String(
    (headers || {})['User-Agent'] || (headers || {})['user-agent'] || ''
  ).trim().toLowerCase();
  var xUserAgent = String(
    (headers || {})['X-User-Agent'] || (headers || {})['x-user-agent'] || ''
  ).trim().toLowerCase();
  var icyMetaData = String(
    (headers || {})['Icy-MetaData'] || (headers || {})['icy-metadata'] || ''
  ).trim();
  var cookie = String((headers || {})['Cookie'] || (headers || {})['cookie'] || '')
    .trim()
    .toLowerCase();
  var serialNumber = String((headers || {})['SN'] || (headers || {})['sn'] || '').trim();
  var authorization = String(
    (headers || {})['Authorization'] || (headers || {})['authorization'] || ''
  ).trim();

  return icyMetaData === '1' ||
    userAgent === 'ksplayer' ||
    xUserAgent.indexOf('mag250') !== -1 ||
    (
      cookie.indexOf('mac=') !== -1 &&
      (Boolean(serialNumber) || Boolean(authorization))
    );
}

function applyMacPlaybackHeaders(targetUrl, extraHeaders, mac) {
  if (!mac) {
    return;
  }

  if (!extraHeaders.Cookie && !extraHeaders.cookie) {
    extraHeaders.Cookie = 'mac=' + mac + '; stb_lang=en_US@rg=dezzzz; timezone=Europe/Berlin';
  }
  if (!extraHeaders['X-User-Mac'] && !extraHeaders['x-user-mac']) {
    extraHeaders['X-User-Mac'] = mac;
  }
  if (!extraHeaders['User-Agent'] && !extraHeaders['user-agent']) {
    extraHeaders['User-Agent'] = STALKER_MAG_USER_AGENT;
  }
  if (!extraHeaders['X-User-Agent'] && !extraHeaders['x-user-agent']) {
    extraHeaders['X-User-Agent'] = STALKER_MAG_USER_AGENT;
  }
}

function resolveRelativeUrl(baseUrl, value) {
  try {
    return new URL(value, baseUrl).toString();
  } catch (error) {
    return value;
  }
}

function isHlsResponse(targetUrl, contentType, previewText) {
  var normalizedUrl = String(targetUrl || '').toLowerCase();
  var normalizedType = String(contentType || '').toLowerCase();
  var normalizedPreview = String(previewText || '').trim().toLowerCase();

  return normalizedType.indexOf('application/vnd.apple.mpegurl') !== -1 ||
    normalizedType.indexOf('application/x-mpegurl') !== -1 ||
    /\.m3u8(\?|$)/i.test(targetUrl) ||
    normalizedPreview.indexOf('#extm3u') === 0;
}

function isOwnStreamDeliveryUrl(req, targetUrl) {
  try {
    var parsed = new URL(String(targetUrl || ''), buildRuntimeBaseUrl(req));
    var requestHost = safeTrim(req.get('host')).split(':')[0].toLowerCase();
    return Boolean(requestHost) &&
      parsed.hostname.toLowerCase() === requestHost &&
      /^\/(?:live|movie|series)\//i.test(parsed.pathname);
  } catch (error) {
    return false;
  }
}

function rewriteManifestLine(line, manifestUrl, req, headers, mac) {
  var trimmed = String(line || '').trim();
  if (!trimmed) {
    return line;
  }

  if (trimmed.charAt(0) === '#') {
    return line.replace(/URI="([^"]+)"/g, function (_match, uri) {
      var resolvedUri = resolveRelativeUrl(manifestUrl, uri);
      var proxiedUri = buildProxyStreamUrl(req, resolvedUri, headers, mac);
      return 'URI="' + proxiedUri + '"';
    });
  }

  return buildProxyStreamUrl(req, resolveRelativeUrl(manifestUrl, trimmed), headers, mac);
}

function rewriteHlsManifest(manifest, manifestUrl, req, headers, mac) {
  return String(manifest || '')
    .split(/\r?\n/)
    .map(function (line) {
      return rewriteManifestLine(line, manifestUrl, req, headers, mac);
    })
    .join('\n');
}

function formatFfmpegHeaders(headers) {
  return Object.keys(headers || {})
    .filter(function (key) { return key && safeTrim(headers[key]); })
    .map(function (key) { return key + ': ' + safeTrim(headers[key]) + '\r\n'; })
    .join('');
}

function shouldBypassCompatTranscode(targetUrl, headers) {
  return isDirectTokenizedStalkerStream(targetUrl) ||
    isStalkerLiveRequestHeaders(headers || {});
}

function shouldUseNodeHttpProxyInput(targetUrl, headers) {
  return isDirectTokenizedStalkerStream(targetUrl) ||
    isStalkerLiveRequestHeaders(headers || {}) ||
    isYouTubeUrl(targetUrl);
}

function shouldUseLocalProxyCompatInput(targetUrl, headers) {
  return shouldBypassCompatTranscode(targetUrl, headers) ||
    isGoogleVideoUrl(targetUrl) ||
    inferStreamKind(targetUrl, '') === 'hls';
}

function isRedirectStatusCode(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isRedirectDeliveryAllowed() {
  return TV_DELIVERY_MODE === 'redirect' && process.env.ALLOW_REDIRECT_MODE === '1';
}

function summarizeStreamUrlForLog(targetUrl) {
  try {
    var parsed = new URL(String(targetUrl || ''));
    return parsed.protocol + '//' + parsed.host + parsed.pathname;
  } catch (error) {
    return String(targetUrl || '').split('?')[0].substring(0, 160);
  }
}

async function fetchWithPreservedHeaders(targetUrl, headers, timeoutMs) {
  var currentUrl = targetUrl;
  var maxRedirects = 5;
  var response = null;

  for (var redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
    response = await fetch(currentUrl, {
      headers: headers,
      timeout: timeoutMs,
      redirect: 'manual'
    });

    if (!isRedirectStatusCode(response.status)) {
      return {
        response: response,
        finalUrl: currentUrl
      };
    }

    var location = safeTrim(response.headers.get('location'));
    if (!location) {
      return {
        response: response,
        finalUrl: currentUrl
      };
    }

    try {
      if (response.body) {
        response.body.destroy();
      }
    } catch (destroyError) {
    }

    currentUrl = resolveRelativeUrl(currentUrl, location);
  }

  return {
    response: response,
    finalUrl: currentUrl
  };
}

async function proxyRemoteStream(req, res, targetUrl, baseHeaders) {
  var target = safeTrim(targetUrl);
  if (!target) {
    res.status(400).json({ error: 'Stream URL gerekli' });
    return;
  }

  // Allow proxying local HLS output via relative path (used by loop channels in the editor/webplayer).
  // Keep this scope tight to /hls only to avoid accidentally proxying arbitrary local endpoints.
  if (target[0] === '/' && target.indexOf('/hls/') === 0) {
    target = buildRuntimeBaseUrl(req) + target;
  }

  try {
    new URL(target);
  } catch (error) {
    res.status(400).json({ error: 'Gecersiz stream URL' });
    return;
  }

  var headers = {};
  Object.keys(baseHeaders || {}).forEach(function (key) {
    headers[key] = baseHeaders[key];
  });

  if (!headers['User-Agent'] && !headers['user-agent']) {
    headers['User-Agent'] = 'Mozilla/5.0';
  }
  if (!headers.Accept && !headers.accept) {
    headers.Accept = '*/*';
  }
  if (req.headers.range && !headers.Range && !headers.range) {
    headers.Range = req.headers.range;
  }

  console.log('[TV] proxy stream:', summarizeStreamUrlForLog(target));

  if (shouldUseNodeHttpProxyInput(target, headers)) {
    await proxyRemoteStreamWithNodeHttp(req, res, target, headers);
    return;
  }

  try {
    var upstreamResult = await fetchWithPreservedHeaders(target, headers, 45000);
    var upstream = upstreamResult.response;
    var finalUrl = safeTrim(upstreamResult.finalUrl || target);
    var contentType = safeTrim(upstream.headers.get('content-type'));
    console.log('[TV] upstream:', upstream.status, contentType || '(no content-type)', summarizeStreamUrlForLog(finalUrl));

    if (!upstream.ok && upstream.status !== 206) {
      setCommonProxyHeaders(res);
      res.status(upstream.status);
      var errorText = await upstream.text();
      res.send(errorText || 'Upstream hata');
      return;
    }

    if (isHlsResponse(finalUrl, contentType, '')) {
      var manifestText = await upstream.text();
      var rewrittenManifest = rewriteHlsManifest(
        manifestText,
        finalUrl,
        req,
        headers,
        safeTrim(req.query.mac)
      );

      setCommonProxyHeaders(res);
      res.status(upstream.status);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', contentType || 'application/x-mpegURL');
      res.send(rewrittenManifest);
      return;
    }

    setProxyHeaders(res, upstream);
    res.status(upstream.status);

    upstream.body.pipe(res);
    req.on('close', function () {
      try {
        upstream.body.destroy();
      } catch (error) {
      }
    });
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
}

function proxyRemoteStreamWithNodeHttp(req, res, targetUrl, headers) {
  return new Promise(function (resolve) {
    var upstreamClosed = false;

    function markResolved() {
      if (upstreamClosed) {
        return;
      }
      upstreamClosed = true;
      resolve();
    }

    function fail(error) {
      if (!res.headersSent) {
        res.status(500).json({ error: error.message });
      }
      markResolved();
    }

    function requestUrl(currentUrl, redirectCount) {
      if (redirectCount > 5) {
        fail(new Error('Cok fazla yonlendirme'));
        return;
      }

      var parsed;
      try {
        parsed = new URL(currentUrl);
      } catch (error) {
        fail(error);
        return;
      }

      var transport = parsed.protocol === 'https:' ? https : http;
      var upstreamReq = transport.request({
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: headers
      }, function (upstreamRes) {
        upstreamReq.setTimeout(0);
        if (typeof upstreamRes.setTimeout === 'function') {
          upstreamRes.setTimeout(0);
        }

        var statusCode = Number(upstreamRes.statusCode || 0);
        var location = safeTrim(upstreamRes.headers.location);
        var contentType = safeTrim((upstreamRes.headers || {})['content-type']);

        if (isRedirectStatusCode(statusCode) && location) {
          upstreamRes.resume();
          requestUrl(resolveRelativeUrl(currentUrl, location), redirectCount + 1);
          return;
        }

        console.log('[TV] upstream:', statusCode, contentType || '(no content-type)', summarizeStreamUrlForLog(currentUrl));

        if (!statusCode) {
          try { upstreamRes.destroy(); } catch (destroyError) {}
          fail(new Error('Upstream durum kodu alinamadi'));
          return;
        }

        if ((statusCode === 200 || statusCode === 206) && isHlsResponse(currentUrl, contentType, '')) {
          var manifestChunks = [];
          upstreamRes.on('data', function (chunk) {
            manifestChunks.push(chunk);
          });
          upstreamRes.on('end', function () {
            if (!res.headersSent) {
              var manifestText = Buffer.concat(manifestChunks).toString('utf8');
              var rewrittenManifest = rewriteHlsManifest(
                manifestText,
                currentUrl,
                req,
                headers,
                safeTrim(req.query.mac)
              );
              setCommonProxyHeaders(res);
              res.status(statusCode);
              res.setHeader('Cache-Control', 'no-store');
              res.setHeader('Content-Type', contentType || 'application/x-mpegURL');
              res.send(rewrittenManifest);
            }
            markResolved();
          });
          upstreamRes.on('close', markResolved);
          upstreamRes.on('error', function () { markResolved(); });
          return;
        }

        if (statusCode !== 200 && statusCode !== 206) {
          setNodeResponseProxyHeaders(res, upstreamRes.headers || {});
          res.status(statusCode);
          upstreamRes.pipe(res);
          upstreamRes.on('end', markResolved);
          upstreamRes.on('close', markResolved);
          upstreamRes.on('error', function () { markResolved(); });
          return;
        }

        setNodeResponseProxyHeaders(res, upstreamRes.headers || {});
        res.status(statusCode);
        upstreamRes.pipe(res);

        req.on('close', function () {
          try { upstreamReq.destroy(); } catch (error) {}
          try { upstreamRes.destroy(); } catch (error) {}
        });

        upstreamRes.on('end', markResolved);
        upstreamRes.on('close', markResolved);
        upstreamRes.on('error', function () { markResolved(); });
      });

      upstreamReq.setTimeout(15000, function () {
        upstreamReq.destroy(new Error('Upstream baglanti zaman asimi'));
      });

      upstreamReq.on('error', fail);
      upstreamReq.end();
    }

    requestUrl(targetUrl, 0);
  });
}

async function proxyCompatibleStream(req, res, targetUrl, baseHeaders, options) {
  var target = safeTrim(targetUrl);
  var probeOnly = !!(options && options.probeOnly);
  if (!target) {
    res.status(400).json({ error: 'Stream URL gerekli' });
    return;
  }

  // Allow local loop HLS playback through compat route as well (even though it usually isn't needed).
  if (target[0] === '/' && target.indexOf('/hls/') === 0) {
    target = buildRuntimeBaseUrl(req) + target;
  }

  try {
    new URL(target);
  } catch (error) {
    res.status(400).json({ error: 'Gecersiz stream URL' });
    return;
  }

  var headers = {};
  Object.keys(baseHeaders || {}).forEach(function (key) {
    headers[key] = baseHeaders[key];
  });

  if (!headers['User-Agent'] && !headers['user-agent']) {
    headers['User-Agent'] = 'Mozilla/5.0';
  }
  if (!headers.Accept && !headers.accept) {
    headers.Accept = '*/*';
  }

  var inputKind = inferStreamKind(target, '');
  var useFastTransmux = isGoogleVideoUrl(target) || inputKind === 'hls';
  var ffmpegInput = shouldUseLocalProxyCompatInput(target, headers)
    ? buildInternalProxyStreamUrl(target, headers, '')
    : target;
  var ffmpegHeaders = ffmpegInput === target ? formatFfmpegHeaders(headers) : '';
  var ffmpegArgs = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-fflags',
    useFastTransmux ? '+genpts+nobuffer+discardcorrupt' : '+genpts+discardcorrupt',
    '-err_detect',
    'ignore_err',
    '-analyzeduration',
    useFastTransmux ? '1000000' : '3000000',
    '-probesize',
    useFastTransmux ? '1000000' : '3000000',
    '-reconnect',
    '1',
    '-reconnect_at_eof',
    '1',
    '-reconnect_streamed',
    '1',
    '-reconnect_delay_max',
    '5'
  ];

  if (ffmpegHeaders) {
    ffmpegArgs.push('-headers');
    ffmpegArgs.push(ffmpegHeaders);
  }

  ffmpegArgs = ffmpegArgs.concat([
    '-i',
    ffmpegInput,
    '-map',
    '0:v:0?',
    '-map',
    '0:a:0?',
    '-sn',
    '-dn'
  ]);

  if (useFastTransmux) {
    ffmpegArgs = ffmpegArgs.concat([
      '-c:v',
      'copy',
      '-c:a',
      'copy',
      '-mpegts_flags',
      '+resend_headers',
      '-muxpreload',
      '0',
      '-muxdelay',
      '0',
      '-f',
      'mpegts',
      'pipe:1'
    ]);
  } else {
    ffmpegArgs = ffmpegArgs.concat([
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-tune',
      'zerolatency',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-ac',
      '2',
      '-b:a',
      '128k',
      '-f',
      'mpegts',
      'pipe:1'
    ]);
  }

  var ffmpegProcess;
  try {
    ffmpegProcess = spawn(FFMPEG_PATH, ffmpegArgs, {
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (error) {
    res.status(500).json({ error: 'FFmpeg baslatilamadi: ' + error.message });
    return;
  }

  var stderr = '';
  var started = false;
  var finished = false;
  var startedAt = Date.now();
  var startupTimer = setTimeout(function () {
    if (started || finished) {
      return;
    }

    try { ffmpegProcess.kill(); } catch (error) {}
  }, 25000);

  console.log('[Compat] Starting FFmpeg for:', ffmpegInput, '| mode:', useFastTransmux ? 'copy' : 'transcode');
  ffmpegProcess.stderr.on('data', function (chunk) {
    if (stderr.length < 4000) {
      stderr += chunk.toString();
    }
    console.log('[Compat][ffmpeg]', chunk.toString().trim());
  });

  ffmpegProcess.on('error', function (error) {
    finished = true;
    clearTimeout(startupTimer);
    if (!res.headersSent) {
      res.status(500).json({ error: 'FFmpeg hatasi: ' + error.message });
      return;
    }
    try { res.destroy(error); } catch (destroyError) {}
  });

  req.on('close', function () {
    if (!started) {
      console.log('[Compat] Client disconnected before first byte');
    }
    try { ffmpegProcess.kill(); } catch (error) {}
  });

  ffmpegProcess.stdout.on('error', function (error) {
    try { res.destroy(error); } catch (destroyError) {}
  });

  if (!probeOnly) {
    setCommonProxyHeaders(res);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'video/mp2t');
    res.status(200);
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }
  }

  ffmpegProcess.stdout.once('data', function (chunk) {
    if (finished) {
      return;
    }

    started = true;
    clearTimeout(startupTimer);
    console.log('[Compat] First byte after ms:', Date.now() - startedAt);
    if (probeOnly) {
      finished = true;
      try { ffmpegProcess.kill(); } catch (error) {}
      if (!res.headersSent) {
        res.json({ ok: true });
      }
      return;
    }
    res.write(chunk);
    ffmpegProcess.stdout.pipe(res);
  });

  ffmpegProcess.on('close', function (code, signal) {
    finished = true;
    clearTimeout(startupTimer);
    console.log('[Compat] FFmpeg exit code:', code, 'signal:', signal || '');

    if (!started) {
      if (!res.headersSent) {
        res.status(504).json({
          error: 'Uyumluluk akisi veri uretmedi',
          details: safeTrim(stderr) || ('FFmpeg cikis kodu: ' + code + (signal ? ', signal: ' + signal : ''))
        });
        return;
      }

      try { res.end(); } catch (error) {}
      return;
    }

    if (code === 0) {
      return;
    }

    if (!res.headersSent) {
      res.status(502).json({ error: 'Compat proxy basarisiz', details: safeTrim(stderr) || ('FFmpeg cikis kodu: ' + code + (signal ? ', signal: ' + signal : '')) });
      return;
    }

    try { res.end(); } catch (error) {}
  });
}

async function inspectRemoteStream(req, res, targetUrl, baseHeaders) {
  var target = safeTrim(targetUrl);
  var mac = normalizeMacAddress(req.query.mac);
  if (!target) {
    res.status(400).json({ error: 'Stream URL gerekli', playable: false });
    return;
  }

  // Support local loop HLS URLs passed as relative paths from the webplayer/editor.
  if (target[0] === '/' && target.indexOf('/hls/') === 0) {
    target = buildRuntimeBaseUrl(req) + target;
  }

  try {
    new URL(target);
  } catch (error) {
    res.status(400).json({ error: 'Gecersiz stream URL', playable: false });
    return;
  }

  var headers = {};
  Object.keys(baseHeaders || {}).forEach(function (key) {
    headers[key] = baseHeaders[key];
  });

  if (!headers['User-Agent'] && !headers['user-agent']) {
    headers['User-Agent'] = 'Mozilla/5.0';
  }
  if (!headers.Accept && !headers.accept) {
    headers.Accept = '*/*';
  }

  var shouldBypassInspection =
    isDirectTokenizedStalkerStream(target) ||
    isStalkerLiveRequestHeaders(headers) ||
    isYouTubeUrl(target);
  var bypassKind = inferStreamKind(target, '');

  if (shouldBypassInspection) {
    res.json({
      playable: true,
      finalUrl: target,
      contentType: bypassKind === 'mpegts' ? 'video/mp2t' : '',
      mimeType: getStreamMimeType(target, '', bypassKind),
      kind: bypassKind === 'unknown' ? 'mpegts' : bypassKind,
      proxyUrl: buildProxyStreamUrl(req, target, headers, mac),
      compatUrl: buildCompatStreamUrl(req, target, headers, mac)
    });
    return;
  }

  try {
    var upstreamResult = await fetchWithPreservedHeaders(target, headers, 15000);
    var upstream = upstreamResult.response;
    var finalUrl = safeTrim(upstreamResult.finalUrl || target);
    var contentType = safeTrim(upstream.headers.get('content-type'));
    var kind = inferStreamKind(finalUrl, contentType);
    var mimeType = getStreamMimeType(finalUrl, contentType, kind);
    var normalizedType = contentType.toLowerCase();
    var directPlaybackUrl = kind === 'hls' && isOwnStreamDeliveryUrl(req, target)
      ? target
      : buildProxyStreamUrl(req, finalUrl, headers, mac);
    var playable =
      upstream.ok ||
      upstream.status === 206 ||
      kind !== 'unknown';

    if (normalizedType.indexOf('text/html') !== -1) {
      playable = false;
    }

    try {
      if (upstream.body) {
        upstream.body.destroy();
      }
    } catch (destroyError) {
    }

    res.status(upstream.ok || upstream.status === 206 ? 200 : upstream.status).json({
      playable: playable,
      finalUrl: finalUrl,
      contentType: contentType,
      mimeType: mimeType,
      kind: kind,
      proxyUrl: directPlaybackUrl,
      compatUrl: buildCompatStreamUrl(req, finalUrl, headers, mac),
      status: upstream.status
    });
  } catch (error) {
    res.status(500).json({
      playable: false,
      error: error.message,
      proxyUrl: buildProxyStreamUrl(req, target, headers, mac),
      compatUrl: buildCompatStreamUrl(req, target, headers, mac)
    });
  }
}

function setStreamCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Type, Content-Length, Content-Range');
}

async function handleProxyStreamRequest(req, res) {
  var targetUrl = safeTrim(req.query.url);
  var extraHeaders = parseProxyHeaders(req.query.headers);
  var mac = normalizeMacAddress(req.query.mac);

  applyMacPlaybackHeaders(targetUrl, extraHeaders, mac);
  await proxyRemoteStream(req, res, targetUrl, extraHeaders);
}

async function handleCompatStreamRequest(req, res) {
  var targetUrl = safeTrim(req.query.url);
  var extraHeaders = parseProxyHeaders(req.query.headers);
  var mac = normalizeMacAddress(req.query.mac);
  var probeOnly = String(req.query.probe || '') === '1';

  applyMacPlaybackHeaders(targetUrl, extraHeaders, mac);
  if (shouldBypassCompatTranscode(targetUrl, extraHeaders)) {
    if (probeOnly) {
      res.json({ ok: true, bypassed: true });
      return;
    }
    console.log('[Compat] Bypassing FFmpeg for:', targetUrl);
    await proxyRemoteStream(req, res, targetUrl, extraHeaders);
    return;
  }
  await proxyCompatibleStream(req, res, targetUrl, extraHeaders, {
    probeOnly: probeOnly
  });
}

async function handleInspectStreamRequest(req, res) {
  var targetUrl = safeTrim(req.query.url);
  var extraHeaders = parseProxyHeaders(req.query.headers);
  var mac = normalizeMacAddress(req.query.mac);

  applyMacPlaybackHeaders(targetUrl, extraHeaders, mac);
  await inspectRemoteStream(req, res, targetUrl, extraHeaders);
}

function makeOutputId(kind, item, fallbackIndex, playlistSeed) {
  var rawId = safeTrim(item && item.id);
  var normalizedSeed = safeTrim(playlistSeed) || safeTrim(item && item.sourcePlaylistId) || safeTrim(item && item.sourcePlaylistName);
  if (/^\d+$/.test(rawId) && !normalizedSeed) {
    return rawId;
  }

  var seed = [kind, normalizedSeed, rawId, item && item.name, item && item.cmd, fallbackIndex].join('|');
  var hash = 0;
  for (var i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }

  var prefixes = { live: 100000000, movies: 200000000, series: 300000000 };
  return String((prefixes[kind] || 400000000) + (hash % 90000000));
}

function normalizeStreamBaseUrl(raw) {
  var base = safeTrim(raw);
  if (!base) return '';
  return base.replace(/\/$/, '');
}

function isPrivateOrLocalHostname(hostname) {
  var host = String(hostname || '').toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host === '0.0.0.0' || host === '127.0.0.1' || host.endsWith('.local')) {
    return true;
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    var parts = host.split('.').map(function(p) { return parseInt(p, 10); });
    if (parts.some(function(n) { return isNaN(n) || n < 0 || n > 255; })) return true;
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  }
  return false;
}

function getStreamBaseUrlStatus() {
  var base = STREAM_BASE_URL;
  if (!base) {
    return { ok: false, configured: false, baseUrl: '', error: 'Streaming server URL not configured. Set STREAM_BASE_URL in .env' };
  }
  try {
    var u = new URL(base);
    if (process.env.VERCEL) {
      if (isPrivateOrLocalHostname(u.hostname)) {
        return { ok: false, configured: true, baseUrl: base, error: 'Streaming server URL must be a public hostname (not localhost/private IP).' };
      }
      if (u.protocol !== 'https:') {
        return { ok: false, configured: true, baseUrl: base, error: 'Streaming server URL must be HTTPS in production.' };
      }
    }
  } catch (_) {
    return { ok: false, configured: true, baseUrl: base, error: 'Invalid STREAM_BASE_URL format.' };
  }
  return { ok: true, configured: true, baseUrl: base, error: '' };
}

async function collectOutputData() {
  if (
    outputDataCacheState.value &&
    outputDataCacheState.version === playlistCacheState.version &&
    outputDataCacheState.expiresAt > Date.now()
  ) {
    return outputDataCacheState.value;
  }
  if (outputDataCacheState.pending) {
    return outputDataCacheState.pending;
  }

  outputDataCacheState.pending = (async function () {
    var lists = getTvOutputPlaylists(await loadPlaylists());
    var liveStreams = [];
    var movieStreams = [];
    var seriesStreams = [];
    var liveCategories = [];
    var movieCategories = [];
    var seriesCategories = [];
    var catCounter = 1;
    var shouldIncludeOutputItem = createOutputDeduper();

    lists.forEach(function (playlist) {
      if (!playlist || !playlist.data) {
        return;
      }

      ['live', 'movies', 'series'].forEach(function (kind) {
        var groups = playlist.data[kind] || {};
        Object.keys(groups).forEach(function (groupName) {
          if (isPlaylistCategoryHidden(playlist, kind, groupName)) {
            return;
          }

          var categoryId = String(catCounter++);
          var targetCategories = kind === 'live' ? liveCategories : kind === 'movies' ? movieCategories : seriesCategories;
          targetCategories.push({
            category_id: categoryId,
            category_name: groupName,
            parent_id: 0
          });

          (groups[groupName] || []).forEach(function (item, index) {
            if (!shouldIncludeOutputItem(kind, playlist, item)) {
              return;
            }

            var outputId = makeOutputId(kind, item, index, playlist.id);
            var imageUrl = pickItemImage(item);
            var plotText = pickItemPlot(item);

            if (kind === 'live') {
              if (safeTrim(item && item.sourceType) === 'loop' && safeTrim(item && item.id)) {
                }
              liveStreams.push({
                num: liveStreams.length + 1,
                name: item.name,
                stream_type: 'live',
                stream_id: parseInt(outputId, 10),
                stream_icon: imageUrl,
                epg_channel_id: item.epg_id || '',
                added: '0',
                category_id: categoryId,
                container_extension: streamExtension('live', item),
                custom_sid: '',
                direct_source: item.sourceCmd || item.cmd || '',
                output_id: outputId
              });
            } else if (kind === 'movies') {
              movieStreams.push({
                num: movieStreams.length + 1,
                name: item.name,
                stream_type: 'movie',
                stream_id: parseInt(outputId, 10),
                stream_icon: imageUrl,
                cover: imageUrl,
                plot: plotText,
                cast: safeTrim(item && item.actors),
                director: safeTrim(item && item.director),
                genre: safeTrim(item && item.genres_str),
                releaseDate: safeTrim(item && item.year),
                rating: safeTrim(item && (item.rating || item.rating_imdb || item.rate)),
                added: '',
                category_id: categoryId,
                container_extension: 'mp4',
                custom_sid: '',
                direct_source: item.sourceCmd || item.cmd || '',
                output_id: outputId
              });
            } else {
              seriesStreams.push({
                series_id: parseInt(outputId, 10),
                name: item.name,
                cover: imageUrl,
                cover_big: imageUrl,
                plot: plotText,
                cast: safeTrim(item && item.actors),
                director: safeTrim(item && item.director),
                genre: safeTrim(item && item.genres_str),
                releaseDate: safeTrim(item && item.year),
                category_id: categoryId,
                direct_source: item.sourceCmd || item.cmd || '',
                output_id: outputId
              });
            }
          });
        });
      });
    });

    // Inject Loop Channels as LIVE streams so they show up on TV playlists (Xtream/M3U).
    var liveCategoryIdByName = {};
    liveCategories.forEach(function (cat) {
      var name = safeTrim(cat && cat.category_name);
      if (name && !liveCategoryIdByName[name]) {
        liveCategoryIdByName[name] = cat.category_id;
      }
    });

    var result = {
      liveStreams: liveStreams,
      movieStreams: movieStreams,
      seriesStreams: seriesStreams,
      liveCategories: liveCategories,
      movieCategories: movieCategories,
      seriesCategories: seriesCategories
    };

    outputDataCacheState.value = result;
    outputDataCacheState.expiresAt = Date.now() + OUTPUT_CACHE_TTL_MS;
    outputDataCacheState.pending = null;
    outputDataCacheState.version = playlistCacheState.version;
    return result;
  })().catch(function (error) {
    outputDataCacheState.pending = null;
    throw error;
  });

  return outputDataCacheState.pending;
}

async function getStreamEntryIndex() {
  if (
    streamIndexCacheState.value &&
    streamIndexCacheState.version === playlistCacheState.version &&
    streamIndexCacheState.expiresAt > Date.now()
  ) {
    return streamIndexCacheState.value;
  }
  if (streamIndexCacheState.pending) {
    return streamIndexCacheState.pending;
  }

  streamIndexCacheState.pending = (async function () {
    var lists = getTvOutputPlaylists(await loadPlaylists());
    var nextIndex = { live: {}, movies: {}, series: {} };
    var shouldIncludeOutputItem = createOutputDeduper();

    lists.forEach(function (playlist) {
      if (!playlist || !playlist.data) {
        return;
      }

      ['live', 'movies', 'series'].forEach(function (kind) {
        Object.keys(playlist.data[kind] || {}).forEach(function (groupName) {
          if (isPlaylistCategoryHidden(playlist, kind, groupName)) {
            return;
          }

          (playlist.data[kind][groupName] || []).forEach(function (item, index) {
            if (!shouldIncludeOutputItem(kind, playlist, item)) {
              return;
            }

            var outputId = makeOutputId(kind, item, index, playlist.id);
            if (kind === 'live' && safeTrim(item && item.sourceType) === 'loop' && safeTrim(item && item.id)) {
            }
            nextIndex[kind][outputId] = {
              playlist: playlist,
              groupName: groupName,
              item: item
            };
          });
        });
      });
    });

    // Loop channels also need to be resolvable via /live/<id> for Xtream clients.
    streamIndexCacheState.value = nextIndex;
    streamIndexCacheState.expiresAt = Date.now() + OUTPUT_CACHE_TTL_MS;
    streamIndexCacheState.pending = null;
    streamIndexCacheState.version = playlistCacheState.version;
    return nextIndex;
  })().catch(function (error) {
    streamIndexCacheState.pending = null;
    throw error;
  });

  return streamIndexCacheState.pending;
}

async function findStream(kind, streamId) {
  var entryIndex = await getStreamEntryIndex();
  var foundEntry = entryIndex[kind] && entryIndex[kind][streamId];
  return foundEntry ? foundEntry.item : null;
}

async function findStreamEntry(kind, streamId) {
  var entryIndex = await getStreamEntryIndex();
  return entryIndex[kind] && entryIndex[kind][streamId] ? entryIndex[kind][streamId] : null;
}

function getXtreamCredentials(sourceMeta) {
  var meta = sourceMeta && typeof sourceMeta === 'object' ? sourceMeta : {};
  return {
    host: safeTrim(meta.host || meta.url).replace(/\/+$/, ''),
    username: safeTrim(meta.username || meta.user),
    password: safeTrim(meta.password || meta.pass)
  };
}

function buildXtreamApiUrl(sourceMeta, action, extraParams) {
  var credentials = getXtreamCredentials(sourceMeta);
  if (!credentials.host || !credentials.username || !credentials.password) {
    return '';
  }

  var params = new URLSearchParams();
  params.set('username', credentials.username);
  params.set('password', credentials.password);
  if (action) {
    params.set('action', action);
  }
  Object.keys(extraParams || {}).forEach(function (key) {
    var value = extraParams[key];
    if (value != null && value !== '') {
      params.set(key, value);
    }
  });

  return credentials.host + '/player_api.php?' + params.toString();
}

async function fetchXtreamSeriesInfo(sourceMeta, seriesId) {
  var url = buildXtreamApiUrl(sourceMeta, 'get_series_info', { series_id: safeTrim(seriesId) });
  if (!url) {
    throw new Error('Xtream dizi kaynak bilgisi eksik');
  }
  var response = await fetch(url, { timeout: 30000 });
  return readJsonResponse(response);
}

function flattenXtreamEpisodes(seriesInfo) {
  var episodes = seriesInfo && seriesInfo.episodes;
  var result = [];

  if (Array.isArray(episodes)) {
    episodes.forEach(function (episode, index) {
      result.push({ seasonKey: safeTrim(episode && (episode.season || episode.season_number)) || '1', episode: episode, index: index });
    });
    return result;
  }

  if (episodes && typeof episodes === 'object') {
    Object.keys(episodes).forEach(function (seasonKey) {
      var seasonEpisodes = Array.isArray(episodes[seasonKey]) ? episodes[seasonKey] : [];
      seasonEpisodes.forEach(function (episode, index) {
        result.push({ seasonKey: seasonKey, episode: episode, index: index });
      });
    });
  }

  return result;
}

function getXtreamEpisodeSeasonNumber(entry) {
  var episode = entry && entry.episode ? entry.episode : {};
  return parsePositiveInt(
    episode.season ||
    episode.season_number ||
    episode.season_num ||
    (entry && entry.seasonKey),
    1
  );
}

function getXtreamEpisodeNumber(entry) {
  var episode = entry && entry.episode ? entry.episode : {};
  return parsePositiveInt(
    episode.episode_num ||
    episode.episode_number ||
    episode.episode ||
    episode.number,
    (entry && entry.index != null ? entry.index + 1 : 1)
  );
}

function buildXtreamEpisodeStreamUrl(sourceMeta, episode) {
  var credentials = getXtreamCredentials(sourceMeta);
  var direct = safeTrim(episode && (episode.direct_source || episode.stream_url || episode.url));
  if (direct) {
    return direct;
  }

  var episodeId = safeTrim(episode && (episode.id || episode.episode_id || episode.stream_id));
  if (!credentials.host || !credentials.username || !credentials.password || !episodeId) {
    return '';
  }

  var extension = safeTrim(episode && episode.container_extension) || 'mp4';
  return credentials.host +
    '/series/' +
    encodeURIComponent(credentials.username) +
    '/' +
    encodeURIComponent(credentials.password) +
    '/' +
    encodeURIComponent(episodeId) +
    '.' +
    extension.replace(/^\./, '');
}

async function resolveXtreamSeriesStream(sourceMeta, item, options) {
  var rawCmd = safeTrim(item && (item.sourceCmd || item.cmd));
  var seriesId = safeTrim(item && item.id);
  var playbackOptions = options || {};

  try {
    var seriesInfo = await fetchXtreamSeriesInfo(sourceMeta, seriesId);
    var entries = flattenXtreamEpisodes(seriesInfo);
    var preferredSeason = parsePositiveInt(playbackOptions.preferredSeasonNumber, 0);
    var preferredEpisode = parsePositiveInt(playbackOptions.preferredEpisodeNumber, 0);
    var selected = null;

    entries.some(function (entry) {
      var seasonNumber = getXtreamEpisodeSeasonNumber(entry);
      var episodeNumber = getXtreamEpisodeNumber(entry);
      if (preferredSeason && seasonNumber !== preferredSeason) {
        return false;
      }
      if (preferredEpisode && episodeNumber !== preferredEpisode) {
        return false;
      }
      selected = entry;
      return true;
    });

    if (!selected && entries.length) {
      selected = entries[0];
    }

    var streamUrl = selected ? buildXtreamEpisodeStreamUrl(sourceMeta, selected.episode) : '';
    if (streamUrl) {
      return {
        streamUrl: streamUrl,
        playbackHeaders: {}
      };
    }
  } catch (error) {
    if (!rawCmd) {
      throw error;
    }
  }

  if (!rawCmd) {
    throw new Error('Xtream dizi bolum URL alinamadi');
  }

  return {
    streamUrl: rawCmd,
    playbackHeaders: {}
  };
}

async function resolvePlaylistItemStream(playlist, kind, item, options) {
  var rawCmd = safeTrim(item && (item.sourceCmd || item.cmd));
  var rawId = safeTrim(item && item.id);
  var sourceType = safeTrim(item && item.sourceType) || safeTrim(playlist && playlist.type);
  var sourceMeta = item && item.sourceMeta ? item.sourceMeta : (playlist && playlist.meta);
  if (!playlist || !item) {
    throw new Error('Kayit bulunamadi');
  }

  if (sourceType === 'xtream' && kind === 'series') {
    return resolveXtreamSeriesStream(sourceMeta || {}, item, options || {});
  }

  if (sourceType !== 'stalker') {
    return {
      streamUrl: rawCmd,
      playbackHeaders: {}
    };
  }

  return resolveStalkerPlaybackTarget(
    sourceMeta && sourceMeta.url,
    sourceMeta && sourceMeta.mac,
    kind,
    rawCmd,
    rawId,
    options || {}
  );
}

function getOriginalPlaybackUrl(item) {
  var sourceMeta = item && item.sourceMeta || {};
  return safeTrim(sourceMeta.originalUrl || (item && (item.sourceCmd || item.cmd || item.direct_source || item.originalUrl)));
}

var youtubeCache = {};
var YOUTUBE_CACHE_TTL_MS = 4 * 60 * 60 * 1000;

function getCachedYouTubeEntry(youtubeUrl) {
  var cacheKey = safeTrim(youtubeUrl);
  var cached = youtubeCache[cacheKey];
  if (!cached) {
    return null;
  }

  if ((Date.now() - cached.timestamp) >= YOUTUBE_CACHE_TTL_MS) {
    delete youtubeCache[cacheKey];
    return null;
  }

  return cached;
}

function setCachedYouTubeEntry(youtubeUrl, streamUrl) {
  var cacheKey = safeTrim(youtubeUrl);
  var kind = inferStreamKind(streamUrl, '');
  youtubeCache[cacheKey] = {
    streamUrl: streamUrl,
    kind: kind,
    timestamp: Date.now()
  };
  return youtubeCache[cacheKey];
}

function clearCachedYouTubeEntry(youtubeUrl) {
  var cacheKey = safeTrim(youtubeUrl);
  if (!cacheKey) return;
  try { delete youtubeCache[cacheKey]; } catch (_) {}
}

async function resolveYouTubeStream(item) {
  var url = item.url || item.cmd || item.sourceCmd || '';
  var videoId = ytStream.extractVideoId(url);
  if (!videoId) return null;

  try {
    var skipGoogleCdn = !!(
      process.env.RAILWAY_ENVIRONMENT ||
      process.env.RAILWAY_STATIC_URL ||
      process.env.RAILWAY_SERVICE_ID ||
      process.env.RENDER ||
      process.env.HEROKU_APP_NAME ||
      process.env.FLY_APP_NAME ||
      process.env.AWS_LAMBDA_FUNCTION_NAME ||
      process.env.VERCEL
    );
    var stream = await ytStream.getStreamUrl(videoId, { skipGoogleCdn: skipGoogleCdn });
    if ((!stream || !stream.url) && skipGoogleCdn) {
      stream = await ytStream.getStreamUrl(videoId, { skipGoogleCdn: false });
    }
    if (stream && stream.url) {
      var resolvedKind = stream.isM3U8 ? 'hls' : (stream.kind || inferStreamKind(stream.url, ''));
      console.log('[YouTube] unified resolver OK:', stream.source || 'unknown', resolvedKind, summarizeStreamUrlForLog(stream.url));
      return {
        streamUrl: stream.url,
        isHls: !!stream.isM3U8,
        videoId: videoId,
        playerMode: 'hls',
        kind: resolvedKind === 'unknown' ? (stream.isM3U8 ? 'hls' : 'mp4') : resolvedKind,
        playbackHeaders: {
          'User-Agent': 'Mozilla/5.0',
          Accept: '*/*'
        },
        resolverSource: stream.source || '',
        resolverAttempts: stream.attempts || []
      };
    }
    console.warn('[YouTube] unified resolver failed:', videoId, stream && (stream.error || JSON.stringify(stream.attempts || [])));
  } catch (unifiedError) {
    console.warn('[YouTube] unified resolver hata:', (unifiedError && unifiedError.message || '').substring(0, 160));
  }

  // ADIM 1: yt-dlp (lokal — en güvenilir, live HLS döndürür)
  if (!process.env.VERCEL) {
    try {
      var ytCmd = resolveYouTubeCommand();
      if (ytCmd) {
        var hlsUrl = await new Promise(function(resolve, reject) {
          var cp = require('child_process');
          var args = (ytCmd.argsPrefix || []).concat([
            '--no-check-certificate',
            '--geo-bypass',
            '--no-playlist',
            '-f', 'best[height<=720][ext=mp4]/best[height<=720]/best',
            '-g',
            '--',
            'https://www.youtube.com/watch?v=' + videoId
          ]);
          var proc = cp.spawn(ytCmd.command || ytCmd, args, { timeout: 25000, windowsHide: true });
          var out = '';
          var err = '';
          proc.stdout.on('data', function(d) { out += d.toString(); });
          proc.stderr.on('data', function(d) { err += d.toString(); });
          proc.on('close', function(code) {
            var lines = out.trim().split('\n').filter(Boolean);
            if (lines[0]) resolve(lines[0].trim());
            else reject(new Error('yt-dlp cikis: ' + code + ' | ' + err.substring(0, 100)));
          });
          proc.on('error', reject);
        });
        if (hlsUrl) {
          var isHls = hlsUrl.indexOf('manifest') !== -1 || hlsUrl.indexOf('.m3u8') !== -1;
          console.log('[YouTube] yt-dlp OK:', isHls ? 'HLS' : 'MP4', hlsUrl.substring(0, 60));
          return { streamUrl: hlsUrl, isHls: isHls, videoId: videoId, playerMode: 'hls', kind: isHls ? 'hls' : 'mp4', playbackHeaders: {} };
        }
      }
    } catch (e) {
      console.warn('[YouTube] yt-dlp hata:', e.message.substring(0, 80));
    }
  }

  // ADIM 2: InnerTube API (iOS client — Vercel'de de calisir, cipher yok)
  try {
    var itResult = await resolveViaInnerTube(videoId);
    if (itResult && itResult.streamUrl) {
      console.log('[YouTube] InnerTube OK:', itResult.kind, itResult.streamUrl.substring(0, 60));
      return { streamUrl: itResult.streamUrl, isHls: itResult.isHls, videoId: videoId, playerMode: 'hls', kind: itResult.kind, playbackHeaders: {} };
    }
  } catch (ite) {
    console.warn('[YouTube] InnerTube hata:', (ite && ite.message || '').substring(0, 80));
  }

  // ADIM 3: @ybd-project/ytdl-core combined format (ikinci fallback)
  try {
    var ytdlMod = require('@ybd-project/ytdl-core');
    var YtdlCore = ytdlMod.YtdlCore || ytdlMod.default;
    var ytdl = new YtdlCore({ clients: ['IOS', 'WEB'] });
    var info = await ytdl.getBasicInfo('https://www.youtube.com/watch?v=' + videoId);
    var formats = (info && info.formats) || [];
    var hlsManifestUrl = safeTrim(info && info.streamingData && info.streamingData.hlsManifestUrl);
    if (hlsManifestUrl) {
      console.log('[YouTube] ytdl-core HLS OK');
      return { streamUrl: hlsManifestUrl, isHls: true, videoId: videoId, playerMode: 'hls', kind: 'hls', playbackHeaders: {} };
    }
    // Some ytdl-core forks don't reliably set hasVideo/hasAudio; infer muxed formats from mime + audio fields.
    var muxed = formats
      .filter(function(f) {
        if (!f || !f.url) return false;
        var mime = String(f.mimeType || '');
        var hasVideo = f.hasVideo === true ||
          mime.indexOf('video/') === 0 ||
          !!f.qualityLabel ||
          !!f.height ||
          !!f.width;
        var hasAudio = f.hasAudio === true ||
          mime.indexOf('audio/') === 0 ||
          !!f.audioQuality ||
          typeof f.audioBitrate === 'number' ||
          typeof f.audioChannels === 'number' ||
          !!f.audioSampleRate;
        return hasVideo && hasAudio;
      })
      .sort(function(a, b) {
        var ha = Number(a && a.height) || 0;
        var hb = Number(b && b.height) || 0;
        if (hb !== ha) return hb - ha;
        return (Number(b && b.bitrate) || 0) - (Number(a && a.bitrate) || 0);
      });

    if (muxed.length > 0) {
      var picked = muxed[0];
      var pickedMime = String(picked.mimeType || '').toLowerCase();
      var kind = pickedMime.indexOf('video/webm') === 0 ? 'webm' : 'mp4';
      console.log('[YouTube] ytdl-core muxed OK:', kind);
      return { streamUrl: picked.url, isHls: false, videoId: videoId, playerMode: 'hls', kind: kind, playbackHeaders: {} };
    }
  } catch (e) {
    console.warn('[YouTube] ytdl-core hata:', e.message.substring(0, 60));
  }

  // ADIM 4: Piped API
  try {
    var piped = await getPipedStreamInfo(videoId);
    if (piped && (piped.hlsUrl || piped.streamUrl)) {
      var pipedUrl = piped.hlsUrl || piped.streamUrl;
      var pipedHls = !!(piped.hlsUrl);
      console.log('[YouTube] Piped OK:', pipedHls ? 'HLS' : 'MP4', pipedUrl.substring(0, 60));
      return { streamUrl: pipedUrl, isHls: pipedHls, videoId: videoId, playerMode: 'hls', kind: pipedHls ? 'hls' : 'mp4', playbackHeaders: {} };
    }
  } catch (pe) {
    console.warn('[YouTube] Piped hata:', (pe && pe.message || '').substring(0, 60));
  }

  // ADIM 5: Invidious API
  try {
    var inv = await resolveViaInvidious(videoId);
    if (inv && inv.streamUrl) {
      console.log('[YouTube] Invidious OK:', inv.kind, inv.streamUrl.substring(0, 60));
      return { streamUrl: inv.streamUrl, isHls: inv.isHls, videoId: videoId, playerMode: 'hls', kind: inv.kind, playbackHeaders: {} };
    }
  } catch (inve) {
    console.warn('[YouTube] Invidious hata:', (inve && inve.message || '').substring(0, 60));
  }

  // ADIM 6: iframe fallback (sadece webplayer)
  console.warn('[YouTube] Tum yontemler basarisiz, iframe fallback:', videoId);
  return { streamUrl: null, hlsUrl: null, videoId: videoId, playerMode: 'iframe', kind: 'iframe', playbackHeaders: {} };
}

function getServerBaseUrl(req) {
  return req.protocol + '://' + req.get('host');
}

function streamExtension(kind, item) {
  if (kind === 'live') {
    if (safeTrim(item && item.sourceType) === 'loop') {
      return 'm3u8';
    }
    var originalUrl = getOriginalPlaybackUrl(item);
    if (originalUrl && isYouTubeUrl(originalUrl)) {
      return 'm3u8';
    }
    if (originalUrl && isYouTubeProxyUrl(originalUrl)) {
      return 'm3u8';
    }
    if (/\.m3u8(?:[\?#]|$)/i.test(originalUrl)) {
      return 'm3u8';
    }
    return 'ts';
  }
  if (kind === 'movies') {
    var cmd = safeTrim(item && (item.sourceCmd || item.cmd));
    var match = cmd.match(/\.([a-z0-9]{2,5})(?:[\?#]|$)/i);
    return match ? match[1].toLowerCase() : 'mp4';
  }
  return 'mp4';
}

function buildLocalStreamUrl(baseUrl, kind, username, password, outputId, item) {
  return baseUrl + '/' + kind + '/' + encodeURIComponent(username) + '/' + encodeURIComponent(password) + '/' + outputId + '.' + streamExtension(kind, item);
}

function buildLocalSeriesEpisodeUrl(baseUrl, username, password, outputId, seasonNumber, episodeNumber) {
  return baseUrl + '/series/' + encodeURIComponent(username) + '/' + encodeURIComponent(password) + '/' + outputId + '-s' + seasonNumber + '-e' + episodeNumber + '.mp4';
}

function normalizeNativeType(value) {
  var text = safeTrim(value).toLowerCase();
  if (text === 'movie' || text === 'movies' || text === 'vod') {
    return 'movies';
  }
  if (text === 'live' || text === 'channel' || text === 'channels') {
    return 'live';
  }
  if (text === 'series' || text === 'show' || text === 'shows') {
    return 'series';
  }
  return '';
}

function parsePositiveInt(value, fallbackValue) {
  var numeric = parseInt(String(value == null ? '' : value).trim(), 10);
  return isFinite(numeric) && numeric > 0 ? numeric : (fallbackValue || 0);
}

function cleanNativeText(value) {
  var text = safeTrim(value);
  if (!text) {
    return '';
  }
  if (/^(n\/a|null|undefined|none|unknown)$/i.test(text)) {
    return '';
  }
  if (/^0{4}-0{2}-0{2}(?:\s+0{2}:0{2}:0{2})?$/i.test(text)) {
    return '';
  }
  return text;
}

function normalizeLookupToken(value) {
  return cleanNativeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function splitDelimitedValues(value, pattern) {
  return uniqueValues(
    cleanNativeText(value)
      .split(pattern)
      .map(function (item) {
        return cleanNativeText(item);
      })
      .filter(Boolean)
  );
}

function parseGenreList(value) {
  return splitDelimitedValues(
    String(value == null ? '' : value)
      .replace(/\s+\/\s+/g, ',')
      .replace(/\s+\|\s+/g, ','),
    /\s*,\s*/
  );
}

function parsePersonList(value) {
  return splitDelimitedValues(
    String(value == null ? '' : value)
      .replace(/\s+\/\s+/g, ',')
      .replace(/\s+\|\s+/g, ','),
    /\s*,\s*/
  );
}

function parseNumericRating(value) {
  var text = cleanNativeText(value).replace(',', '.');
  if (!text) {
    return null;
  }
  var numeric = Number(text);
  if (!isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return Math.round(numeric * 10) / 10;
}

function extractYearValue(value) {
  var text = cleanNativeText(value);
  if (!text) {
    return null;
  }
  var match = text.match(/\b(19|20)\d{2}\b/);
  return match ? parseInt(match[0], 10) : null;
}

function parseRuntimeMinutes(value) {
  var text = cleanNativeText(value);
  if (!text) {
    return null;
  }
  if (/^\d+$/.test(text)) {
    var numeric = parseInt(text, 10);
    if (numeric > 0 && numeric < 1000) {
      return numeric;
    }
  }
  var hourMatch = text.match(/(\d+)\s*h/i);
  var minuteMatch = text.match(/(\d+)\s*m/i);
  if (hourMatch || minuteMatch) {
    return (hourMatch ? parseInt(hourMatch[1], 10) * 60 : 0) + (minuteMatch ? parseInt(minuteMatch[1], 10) : 0);
  }
  return null;
}

function pickPosterUrl(item) {
  return cleanNativeText(
    pickFirstNonEmpty(item, ['logo', 'cover', 'cover_big', 'movie_image', 'screenshot_uri', 'screenshot_url', 'pic'])
  );
}

function pickBackdropUrl(item) {
  var direct = cleanNativeText(pickFirstNonEmpty(item, ['screenshot_uri', 'screenshot_url', 'cover_big', 'movie_image', 'pic', 'cover', 'logo']));
  if (direct) {
    return direct;
  }
  var screenshots = cleanNativeText(item && item.screenshots);
  if (!screenshots) {
    return '';
  }
  return cleanNativeText(String(screenshots).split(/[,\|;]/)[0]);
}

function createPersonSummary(name) {
  var cleanName = cleanNativeText(name);
  return {
    personId: normalizeLookupToken(cleanName).replace(/\s+/g, '-'),
    name: cleanName,
    photoUrl: '',
    biography: ''
  };
}

function serializeNativeCatalogItem(entry) {
  return {
    id: entry.id,
    type: entry.type,
    title: entry.title,
    originalTitle: entry.originalTitle,
    overview: entry.overview,
    posterUrl: entry.posterUrl,
    backdropUrl: entry.backdropUrl,
    logoUrl: entry.logoUrl,
    year: entry.year,
    releaseDate: entry.releaseDate,
    runtimeMinutes: entry.runtimeMinutes,
    durationText: entry.durationText,
    imdbRating: entry.imdbRating,
    tmdbRating: entry.tmdbRating,
    tmdbId: entry.tmdbId,
    genres: entry.genres,
    actorNames: entry.actorNames,
    director: entry.director,
    categoryId: entry.categoryId,
    categoryName: entry.categoryName,
    playlistId: entry.playlistId,
    playlistName: entry.playlistName
  };
}

function buildNativeCatalogEntry(kind, playlist, groupName, item, outputId) {
  var title = cleanNativeText(item && item.name) || 'Isimsiz';
  var originalTitle = cleanNativeText(item && (item.o_name || item.old_name));
  var actorNames = parsePersonList(item && item.actors);
  var genres = parseGenreList(item && item.genres_str);
  var overview = cleanNativeText(item && (item.plot || item.description || item.overview || item.comments));
  var releaseDate = cleanNativeText(item && item.year);
  var logoUrl = cleanNativeText(pickItemImage(item));
  var imdbRating = parseNumericRating(item && item.rating_imdb);
  var tmdbRating = parseNumericRating(item && (item.rate || item.rating_kinopoisk));

  return {
    id: safeTrim(outputId || (item && item.output_id) || (item && item.id)),
    type: kind,
    title: title,
    originalTitle: originalTitle,
    overview: overview,
    posterUrl: pickPosterUrl(item),
    backdropUrl: pickBackdropUrl(item),
    logoUrl: logoUrl,
    year: extractYearValue(releaseDate || (item && item.year_end) || (item && item.added)),
    releaseDate: releaseDate,
    runtimeMinutes: parseRuntimeMinutes(item && item.time),
    durationText: cleanNativeText(item && item.time),
    imdbRating: imdbRating,
    tmdbRating: tmdbRating,
    tmdbId: cleanNativeText(item && (item.tmdb_id || item.tmdb)),
    genres: genres,
    actorNames: actorNames,
    director: cleanNativeText(item && item.director),
    categoryId: kind + '::' + groupName,
    categoryName: groupName,
    playlistId: safeTrim(playlist && playlist.id),
    playlistName: safeTrim(playlist && playlist.name),
    sourceType: cleanNativeText(item && (item.sourceType || (playlist && playlist.type))),
    _searchText: [
      title,
      originalTitle,
      overview,
      genres.join(' '),
      actorNames.join(' '),
      cleanNativeText(item && item.director),
      groupName
    ].join(' ').toLowerCase(),
    _sortDateMs: parseDateValueMs(item && (item.added || item.releaseDate || item.year)),
    _actorsNormalized: actorNames.map(normalizeLookupToken),
    _genresNormalized: genres.map(normalizeLookupToken)
  };
}

async function collectNativeCatalog(kind) {
  var cached = nativeCatalogCacheState[kind];
  if (
    cached &&
    cached.version === playlistCacheState.version &&
    cached.expiresAt > Date.now() &&
    cached.value
  ) {
    return cached.value;
  }
  if (cached && cached.pending) {
    return cached.pending;
  }

  nativeCatalogCacheState[kind] = nativeCatalogCacheState[kind] || {};
  nativeCatalogCacheState[kind].pending = (async function () {
    var lists = getTvOutputPlaylists(await loadPlaylists());
    var categoriesById = {};
    var entries = [];

    lists.forEach(function (playlist) {
      if (!playlist || !playlist.data) {
        return;
      }

      Object.keys(playlist.data[kind] || {}).forEach(function (groupName) {
        if (isPlaylistCategoryHidden(playlist, kind, groupName)) {
          return;
        }

        var categoryId = kind + '::' + groupName;
        if (!categoriesById[categoryId]) {
          categoriesById[categoryId] = {
            id: categoryId,
            title: groupName,
            count: 0
          };
        }

        (playlist.data[kind][groupName] || []).forEach(function (item, index) {
          var entry = buildNativeCatalogEntry(kind, playlist, groupName, item, makeOutputId(kind, item, index, playlist.id));
          entries.push(entry);
          categoriesById[categoryId].count += 1;
        });
      });
    });

    entries.sort(function (left, right) {
      if (left._sortDateMs !== right._sortDateMs) {
        return right._sortDateMs - left._sortDateMs;
      }
      return left.title.localeCompare(right.title);
    });

    var result = {
      categories: Object.keys(categoriesById)
        .map(function (key) { return categoriesById[key]; })
        .sort(function (left, right) {
          return left.title.localeCompare(right.title);
        }),
      entries: entries
    };

    nativeCatalogCacheState[kind] = {
      value: result,
      pending: null,
      expiresAt: Date.now() + NATIVE_CATALOG_CACHE_TTL_MS,
      version: playlistCacheState.version
    };

    return result;
  })().catch(function (error) {
    nativeCatalogCacheState[kind] = {
      value: null,
      pending: null,
      expiresAt: 0,
      version: playlistCacheState.version
    };
    throw error;
  });

  return nativeCatalogCacheState[kind].pending;
}

function buildNativeRecommendations(entry, allEntries, limit) {
  var sourceActorSet = {};
  var sourceGenreSet = {};
  var results = [];

  (entry._actorsNormalized || []).forEach(function (value) {
    sourceActorSet[value] = true;
  });
  (entry._genresNormalized || []).forEach(function (value) {
    sourceGenreSet[value] = true;
  });

  (allEntries || []).forEach(function (candidate) {
    if (!candidate || candidate.id === entry.id || candidate.type !== entry.type) {
      return;
    }

    var score = 0;

    if (candidate.categoryId === entry.categoryId) {
      score += 4;
    }
    if (candidate.playlistId === entry.playlistId) {
      score += 1;
    }
    if (candidate.year && entry.year && candidate.year === entry.year) {
      score += 1;
    }

    (candidate._genresNormalized || []).forEach(function (genre) {
      if (sourceGenreSet[genre]) {
        score += 3;
      }
    });
    (candidate._actorsNormalized || []).forEach(function (actor) {
      if (sourceActorSet[actor]) {
        score += 4;
      }
    });

    if (score > 0) {
      results.push({
        score: score,
        item: candidate
      });
    }
  });

  return results
    .sort(function (left, right) {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return left.item.title.localeCompare(right.item.title);
    })
    .slice(0, limit || 12)
    .map(function (result) {
      return serializeNativeCatalogItem(result.item);
    });
}

async function buildSeriesNativeSeasons(foundSeries, baseUrl, credentials, streamId) {
  var seriesItem = foundSeries && foundSeries.item ? foundSeries.item : {};
  var sourceMeta = seriesItem && seriesItem.sourceMeta ? seriesItem.sourceMeta : (foundSeries.playlist && foundSeries.playlist.meta);
  var sourceType = safeTrim(seriesItem.sourceType || (foundSeries.playlist && foundSeries.playlist.type));
  var result = {
    seasons: [],
    castText: '',
    directorText: '',
    genreText: '',
    overview: '',
    posterUrl: '',
    releaseDate: ''
  };

  if (sourceType !== 'stalker' || !sourceMeta || !sourceMeta.url || !sourceMeta.mac || !safeTrim(seriesItem.id)) {
    return result;
  }

  var seasonItems = await fetchStalkerSeriesSeasons(sourceMeta.url, sourceMeta.mac, seriesItem.id);
  result.seasons = seasonItems.map(function (seasonItem) {
    var seasonNumber = getSeriesSeasonNumber(seasonItem);
    var seasonName = safeTrim(seasonItem.name) || ('Season ' + seasonNumber);
    var seasonEpisodes = Array.isArray(seasonItem.series) ? seasonItem.series : [];

    if (!result.overview) {
      result.overview = cleanNativeText(seasonItem.description);
    }
    if (!result.posterUrl) {
      result.posterUrl = cleanNativeText(seasonItem.screenshot_uri || seasonItem.screenshot_url || seasonItem.pic);
    }
    if (!result.castText) {
      result.castText = cleanNativeText(seasonItem.actors);
    }
    if (!result.directorText) {
      result.directorText = cleanNativeText(seasonItem.director);
    }
    if (!result.genreText) {
      result.genreText = cleanNativeText(seasonItem.genres_str);
    }
    if (!result.releaseDate) {
      result.releaseDate = cleanNativeText(seasonItem.year);
    }

    return {
      id: safeTrim(foundSeries.item && foundSeries.item.id) + '-s' + seasonNumber,
      seasonNumber: seasonNumber,
      title: seasonName,
      overview: cleanNativeText(seasonItem.description),
      posterUrl: cleanNativeText(seasonItem.screenshot_uri || seasonItem.screenshot_url || seasonItem.pic || result.posterUrl),
      episodeCount: seasonEpisodes.length,
      episodes: seasonEpisodes.map(function (episodeValue) {
        var episodeNumber = parseInt(episodeValue, 10) || 1;
        return {
          id: safeTrim(foundSeries.item && foundSeries.item.id) + '-s' + seasonNumber + '-e' + episodeNumber,
          seasonNumber: seasonNumber,
          episodeNumber: episodeNumber,
          title: seasonName + ' - Episode ' + episodeNumber,
          overview: cleanNativeText(seasonItem.description),
          posterUrl: cleanNativeText(seasonItem.screenshot_uri || seasonItem.screenshot_url || seasonItem.pic || result.posterUrl),
          playUrl: buildLocalSeriesEpisodeUrl(baseUrl, credentials.username, credentials.password, streamId, seasonNumber, episodeNumber)
        };
      })
    };
  });

  return result;
}

async function authorizeNativeApi(req, res) {
  var credentials;

  try {
    credentials = await getServerCredentials();
  } catch (error) {
    res.status(500).json({ error: error.message });
    return null;
  }

  var providedUser = safeTrim(req.query.username || req.get('x-iptv-user'));
  var providedPass = safeTrim(req.query.password || req.get('x-iptv-pass'));

  if (providedUser !== credentials.username || providedPass !== credentials.password) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }

  return {
    credentials: credentials,
    baseUrl: getServerBaseUrl(req)
  };
}

function getVercelCliCommand() {
  return process.platform === 'win32' ? 'vercel.cmd' : 'vercel';
}

function readLocalVercelProjectInfo() {
  try {
    var projectPath = path.join(__dirname, '.vercel', 'project.json');
    if (!require('fs').existsSync(projectPath)) {
      return null;
    }
    var parsed = JSON.parse(require('fs').readFileSync(projectPath, 'utf8'));
    return {
      projectId: safeTrim(parsed.projectId),
      orgId: safeTrim(parsed.orgId),
      projectName: safeTrim(parsed.projectName)
    };
  } catch (error) {
    return null;
  }
}

function extractDeploymentUrl(output) {
  var lines = String(output || '')
    .split(/\r?\n/)
    .map(function (line) { return String(line || '').trim(); })
    .filter(Boolean);

  for (var index = lines.length - 1; index >= 0; index -= 1) {
    var match = lines[index].match(/https?:\/\/\S+/i);
    if (match && match[0]) {
      return match[0].replace(/[)\].,;]+$/g, '');
    }
  }

  return '';
}

function runLocalVercelDeploy() {
  return new Promise(function (resolve, reject) {
    var cli = getVercelCliCommand();
    var linkedProject = readLocalVercelProjectInfo();
    var command = cli;
    var commandArgs = ['--prod', '--yes'];

    if (!linkedProject || !linkedProject.projectName) {
      reject(new Error('Bu klasor bir Vercel projesine bagli degil. Once `vercel` ile projeyi linkle.'));
      return;
    }

    if (process.platform === 'win32') {
      command = process.env.ComSpec || process.env.comspec || 'cmd.exe';
      commandArgs = ['/d', '/s', '/c', 'vercel --prod --yes'];
    }

    var child = spawn(command, commandArgs, {
      cwd: __dirname,
      shell: false,
      env: process.env,
      windowsHide: true
    });
    var stdout = '';
    var stderr = '';

    child.stdout.on('data', function (chunk) {
      stdout += String(chunk || '');
    });

    child.stderr.on('data', function (chunk) {
      stderr += String(chunk || '');
    });

    child.on('error', function (error) {
      reject(error);
    });

    child.on('close', function (code) {
      if (code !== 0) {
        reject(new Error((stderr || stdout || ('Vercel deploy basarisiz. Exit code: ' + code)).trim()));
        return;
      }

      resolve({
        deploymentUrl: extractDeploymentUrl(stdout),
        stdout: stdout.trim(),
        stderr: stderr.trim()
      });
    });
  });
}

async function deliverResolvedStream(req, res, resolved) {
  if (!resolved || !resolved.streamUrl) {
    res.status(404).send('Stream URL bulunamadi');
    return;
  }

  var finalStreamUrl = safeTrim(resolved.streamUrl);
  // Allow playlist items to store local relative paths (e.g. "/hls/...") and still work in proxy/redirect modes.
  if (finalStreamUrl && !/^[a-z][a-z0-9+.-]*:\/\//i.test(finalStreamUrl) && !finalStreamUrl.startsWith('//')) {
    finalStreamUrl = buildRuntimeBaseUrl(req) + (finalStreamUrl.startsWith('/') ? '' : '/') + finalStreamUrl;
  }

  var requestedExtensionMatch = String(req.path || '').match(/\.([a-z0-9]{2,5})$/i);
  var requestedExtension = requestedExtensionMatch ? requestedExtensionMatch[1].toLowerCase() : '';
  var resolvedKind = safeTrim(resolved.kind) || inferStreamKind(finalStreamUrl, '');
  var shouldTranscodeToTs =
    requestedExtension === 'ts' &&
    (resolved.forceCompatibilityProxy || resolvedKind === 'hls' || resolvedKind === 'dash');

  if (isRedirectDeliveryAllowed() && resolvedKind === 'hls') {
    console.log('[TV] redirect HLS master:', summarizeStreamUrlForLog(finalStreamUrl));
    sendSingleVariantHlsMaster(res, finalStreamUrl);
    return;
  }

  if (shouldTranscodeToTs) {
    console.log('[TV] deliver compat proxy:', summarizeStreamUrlForLog(finalStreamUrl));
    await proxyCompatibleStream(req, res, finalStreamUrl, resolved.playbackHeaders || {}, {
      probeOnly: false
    });
    return;
  }

  if (isRedirectDeliveryAllowed()) {
    console.log('[TV] redirect stream:', summarizeStreamUrlForLog(finalStreamUrl));
    res.redirect(302, finalStreamUrl);
    return;
  }

  console.log('[TV] deliver proxy:', summarizeStreamUrlForLog(finalStreamUrl));
  await proxyRemoteStream(req, res, finalStreamUrl, resolved.playbackHeaders || {});
}

app.post('/api/stalker', async function (req, res) {
  try {
    var data = await stalkerCall(req.body.portalUrl, req.body.mac, req.body.params || {});
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/resolve', async function (req, res) {
  try {
    var resolveType = req.body.type || 'live';
    var sourceType = safeTrim(req.body.sourceType);
    var resolveOptions = {
      preferredSeasonNumber: req.body.seasonNumber || req.body.season,
      preferredEpisodeNumber: req.body.episodeNumber || req.body.episode
    };
    var resolved = sourceType === 'xtream' && resolveType === 'series'
      ? await resolveXtreamSeriesStream(req.body.sourceMeta || req.body.meta || req.body, {
          id: req.body.itemId || req.body.id || '',
          cmd: req.body.cmd
        }, resolveOptions)
      : await resolveStalkerPlaybackTarget(
          req.body.portalUrl,
          req.body.mac,
          resolveType,
          req.body.cmd,
          req.body.itemId || req.body.id || '',
          resolveOptions
        );

    res.json({
      streamUrl: resolved.streamUrl,
      raw: req.body.cmd || '',
      playbackHeaders: resolved.playbackHeaders || {}
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/youtube/resolve', async function (req, res) {
  res.set('Access-Control-Allow-Origin', '*');
  var url = safeTrim(req.query.url);
  var videoId = ytStream.extractVideoId(url);
  if (!videoId) {
    return res.json({ ok: false, error: 'Gecersiz YouTube URL', videoId: null });
  }

  var fakeItem = { url: url };
  var result = await resolveYouTubeStream(fakeItem);

  return res.json({
    ok: true,
    streamUrl: (result && result.streamUrl) || null,
    hlsUrl: (result && (result.hlsUrl || result.streamUrl)) || null,
    videoId: videoId,
    playerMode: (result && result.playerMode) || 'iframe',
    isHls: (result && result.isHls) || false
  });
});

// ── /api/yt — YouTube IPTV + WebPlayer stream redirect ───────────────────────
// Python yt_resolver.py (local) veya ytdl-core (Vercel) ile YouTube URL'yi
// dogrudan stream URL'sine cevirerek 302 redirect doner.
// IPTV player redirect'i takip eder ve YouTube CDN'den oynatir.
// Web player da ayni sekilde calisir (HLS veya MP4).
// Ornek: GET /api/yt?id=dQw4w9wgxcQ  veya  GET /api/yt?url=https://youtu.be/dQw4w9wgxcQ

function resolveViaPythonScript(videoId) {
  return new Promise(function (resolve, reject) {
    var ytCmd = resolveYouTubeCommand();
    // Python modu: command = python.exe, argsPrefix = ['-m', 'yt_dlp']
    var pythonExec = (ytCmd && ytCmd.argsPrefix && ytCmd.argsPrefix.length > 0)
      ? ytCmd.command
      : null;
    if (!pythonExec) {
      reject(new Error('Python + yt_dlp bulunamadi'));
      return;
    }

    var resolverScript = path.join(__dirname, 'yt_resolver.py');
    var ytUrl = 'https://www.youtube.com/watch?v=' + videoId;

    var cp = require('child_process');
    cp.execFile(pythonExec, [resolverScript, ytUrl], {
      timeout: 40000,
      windowsHide: true
    }, function (err, stdout, stderr) {
      if (err) {
        reject(new Error((stderr || err.message || 'yt_resolver hata').substring(0, 160)));
        return;
      }
      var url = (stdout || '').trim().split(/\r?\n/)[0];
      if (url && url.startsWith('http')) {
        resolve(url);
      } else {
        reject(new Error('yt_resolver gecersiz cikti: ' + url.substring(0, 80)));
      }
    });
  });
}

app.options('/api/yt', function (req, res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Range, Content-Type, Origin');
  res.status(204).end();
});

app.get('/api/yt', async function (req, res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');

  var rawParam = safeTrim(req.query.url) || safeTrim(req.query.id);
  if (!rawParam) {
    return res.status(400).json({ error: 'url veya id parametresi gerekli. Ornek: /api/yt?id=dQw4w9wgxcQ' });
  }

  var videoId = ytStream.extractVideoId(rawParam);
  if (!videoId) {
    return res.status(400).json({ error: 'Gecersiz YouTube URL veya video ID', raw: rawParam });
  }

  console.log('[/api/yt] Cozumleniyor:', videoId);

  // 1. Python yt_resolver.py (sadece local)
  if (!process.env.VERCEL) {
    try {
      var pyUrl = await resolveViaPythonScript(videoId);
      console.log('[/api/yt] Python OK');
      return proxyRemoteStream(req, res, pyUrl, {
        'User-Agent': 'Mozilla/5.0',
        Accept: '*/*'
      });
    } catch (_) {}
  }

  // 2. InnerTube iOS API (Vercel dahil her ortamda, dogru POST ile)
  try {
    var itRes = await resolveViaInnerTube(videoId);
    if (itRes && itRes.streamUrl) {
      console.log('[/api/yt] InnerTube OK:', itRes.kind);
      return proxyRemoteStream(req, res, itRes.streamUrl, {
        'User-Agent': 'Mozilla/5.0',
        Accept: '*/*'
      });
    }
  } catch (ite) {
    console.warn('[/api/yt] InnerTube hata:', String(ite.message).substring(0, 80));
  }

  // 3. Piped API
  try {
    var piped = await getPipedStreamInfo(videoId);
    var pu = piped && (piped.hlsUrl || piped.streamUrl);
    if (pu) {
      console.log('[/api/yt] Piped OK');
      return proxyRemoteStream(req, res, pu, {
        'User-Agent': 'Mozilla/5.0',
        Accept: '*/*'
      });
    }
  } catch (_) {}

  // 4. Invidious API
  try {
    var invRes = await resolveViaInvidious(videoId);
    if (invRes && invRes.streamUrl) {
      console.log('[/api/yt] Invidious API OK:', invRes.kind);
      return proxyRemoteStream(req, res, invRes.streamUrl, {
        'User-Agent': 'Mozilla/5.0',
        Accept: '*/*'
      });
    }
  } catch (_) {}

  // 5. Invidious /latest_version — kesin son care, instance'i kontrol etmeden redirect
  // Invidious kendi sunucusu uzerinden YouTube'dan videoyu cekip IPTV player'a verir.
  // IPTV player bu URL'yi alir ve Invidious uzerinden videoyu oynatir.
  var invInstances = INVIDIOUS_API_INSTANCES.concat([
    'https://invidious.io.lol',
    'https://invidious.ducks.party',
    'https://iv.datura.network'
  ]);
  // Kisa bir health check ile ilk cevap veren instance'i sec
  var bestInv = null;
  var invChecks = invInstances.map(function(base) {
    return fetchWithTimeout(base + '/api/v1/stats', 3000)
      .then(function(r) { return r.ok ? base : null; })
      .catch(function() { return null; });
  });
  try {
    var invResults = await Promise.all(invChecks);
    bestInv = invResults.find(function(b) { return b !== null; });
  } catch (_) {}

  var invFinalBase = bestInv || 'https://inv.nadeko.net';
  var invFinalUrl = invFinalBase + '/latest_version?id=' + videoId + '&itag=22&local=true';
  console.log('[/api/yt] Invidious latest_version son care:', invFinalBase);
  return proxyRemoteStream(req, res, invFinalUrl, {
    'User-Agent': 'Mozilla/5.0',
    Accept: '*/*'
  });
});

app.options('/api/stream', function (req, res) {
  setStreamCorsHeaders(res);
  res.status(204).end();
});

app.options('/api/stream/compat', function (req, res) {
  setStreamCorsHeaders(res);
  res.status(204).end();
});

app.options('/api/stream/inspect', function (req, res) {
  setStreamCorsHeaders(res);
  res.status(204).end();
});

app.options('/stream', function (req, res) {
  setStreamCorsHeaders(res);
  res.status(204).end();
});

app.options('/stream/compat', function (req, res) {
  setStreamCorsHeaders(res);
  res.status(204).end();
});

app.options('/stream/inspect', function (req, res) {
  setStreamCorsHeaders(res);
  res.status(204).end();
});

app.get('/api/stream', async function (req, res) {
  await handleProxyStreamRequest(req, res);
});

app.get('/api/stream/compat', async function (req, res) {
  await handleCompatStreamRequest(req, res);
});

app.get('/api/stream/inspect', async function (req, res) {
  await handleInspectStreamRequest(req, res);
});

app.get('/stream', async function (req, res) {
  await handleProxyStreamRequest(req, res);
});

app.get('/stream/compat', async function (req, res) {
  await handleCompatStreamRequest(req, res);
});

app.get('/stream/inspect', async function (req, res) {
  await handleInspectStreamRequest(req, res);
});

app.get('/api/hls-proxy', async function(req, res) {
  var targetUrl = safeTrim(req.query.url);
  if (!targetUrl) return res.status(400).json({ error: 'url required' });
  try { new URL(targetUrl); } catch(e) { return res.status(400).json({ error: 'invalid url' }); }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  try {
    var result = await fetchWithPreservedHeaders(targetUrl, { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' }, 15000);
    var upstream = result.response;
    var finalUrl = safeTrim(result.finalUrl || targetUrl);
    if (!upstream.ok) return res.status(upstream.status).json({ error: 'upstream ' + upstream.status });

    var ct = upstream.headers.get('content-type') || '';
    var isM3u8 = targetUrl.toLowerCase().includes('.m3u8') || ct.includes('mpegurl') || ct.includes('m3u');

    if (isM3u8) {
      var text = await upstream.text();
      var baseUrl = finalUrl.substring(0, finalUrl.lastIndexOf('/') + 1);
      text = text.split('\n').map(function(line) {
        var trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return line;
        var abs = (trimmed.startsWith('http://') || trimmed.startsWith('https://')) ? trimmed : (baseUrl + trimmed);
        return '/api/hls-proxy?url=' + encodeURIComponent(abs);
      }).join('\n');
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return res.send(text);
    }

    res.setHeader('Content-Type', ct || 'video/MP2T');
    var cl = upstream.headers.get('content-length');
    if (cl) res.setHeader('Content-Length', cl);
    upstream.body.pipe(res);
  } catch(e) {
    if (!res.headersSent) res.status(502).json({ error: e.message });
  }
});

app.post('/api/xtream/fetch', async function (req, res) {
  var host = safeTrim(req.body.host).replace(/\/+$/, '');
  var user = safeTrim(req.body.username);
  var pass = safeTrim(req.body.password);

  try {
    var loginRes = await fetch(
      host + '/player_api.php?username=' + encodeURIComponent(user) + '&password=' + encodeURIComponent(pass),
      { timeout: 10000 }
    );
    var loginData = await readJsonResponse(loginRes);

    if (!loginData || (loginData.user_info && loginData.user_info.auth === 0)) {
      res.status(401).json({ error: 'Giris basarisiz' });
      return;
    }

    var result = { live: {}, movies: {}, series: {} };

    async function fetchCats(action) {
      var response = await fetch(
        host + '/player_api.php?username=' + encodeURIComponent(user) + '&password=' + encodeURIComponent(pass) + '&action=' + action,
        { timeout: 15000 }
      );
      var data = await readJsonResponse(response);
      var map = {};
      if (Array.isArray(data)) {
        data.forEach(function (item) {
          map[item.category_id] = item.category_name;
        });
      }
      return map;
    }

    async function fetchList(action) {
      var response = await fetch(
        host + '/player_api.php?username=' + encodeURIComponent(user) + '&password=' + encodeURIComponent(pass) + '&action=' + action,
        { timeout: 30000 }
      );
      return readJsonResponse(response);
    }

    var liveCats = await fetchCats('get_live_categories');
    var liveList = await fetchList('get_live_streams');
    if (Array.isArray(liveList)) {
      liveList.forEach(function (item) {
        var category = liveCats[item.category_id] || 'Genel';
        if (!result.live[category]) {
          result.live[category] = [];
        }
        result.live[category].push({
          name: item.name,
          logo: pickItemImage(item),
          cmd: host + '/live/' + encodeURIComponent(user) + '/' + encodeURIComponent(pass) + '/' + item.stream_id + '.ts',
          sourceCmd: host + '/live/' + encodeURIComponent(user) + '/' + encodeURIComponent(pass) + '/' + item.stream_id + '.ts',
          tvg_id: safeTrim(item.epg_channel_id || item.tvg_id),
          id: String(item.stream_id)
        });
      });
    }

    var vodCats = await fetchCats('get_vod_categories');
    var vodList = await fetchList('get_vod_streams');
    if (Array.isArray(vodList)) {
      vodList.forEach(function (item) {
        var category = vodCats[item.category_id] || 'Genel';
        if (!result.movies[category]) {
          result.movies[category] = [];
        }
        result.movies[category].push({
          name: item.name,
          logo: pickItemImage(item),
          description: pickItemPlot(item),
          actors: safeTrim(item.cast || item.actors),
          director: safeTrim(item.director),
          genres_str: safeTrim(item.genre || item.genres_str),
          year: safeTrim(item.releaseDate || item.releasedate || item.year),
          rating_imdb: safeTrim(item.rating || item.rating_imdb),
          cmd: host + '/movie/' + encodeURIComponent(user) + '/' + encodeURIComponent(pass) + '/' + item.stream_id + '.' + (item.container_extension || 'mp4'),
          sourceCmd: host + '/movie/' + encodeURIComponent(user) + '/' + encodeURIComponent(pass) + '/' + item.stream_id + '.' + (item.container_extension || 'mp4'),
          id: String(item.stream_id)
        });
      });
    }

    var seriesCats = await fetchCats('get_series_categories');
    var seriesList = await fetchList('get_series');
    if (Array.isArray(seriesList)) {
      seriesList.forEach(function (item) {
        var category = seriesCats[item.category_id] || 'Genel';
        if (!result.series[category]) {
          result.series[category] = [];
        }
        result.series[category].push({
          name: item.name,
          logo: pickItemImage(item),
          description: pickItemPlot(item),
          actors: safeTrim(item.cast || item.actors),
          director: safeTrim(item.director),
          genres_str: safeTrim(item.genre || item.genres_str),
          year: safeTrim(item.releaseDate || item.releasedate || item.year),
          cmd: '',
          id: String(item.series_id)
        });
      });
    }

    res.json({
      data: result,
      meta: buildXtreamAccountMeta(loginData)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function parseM3uExtinfAttributes(line) {
  var attrs = {};
  var pattern = /([A-Za-z0-9_-]+)=("[^"]*"|'[^']*'|[^\s,]+)/g;
  var match;

  while ((match = pattern.exec(line)) !== null) {
    var key = String(match[1] || '').toLowerCase();
    var value = String(match[2] || '').trim();
    if ((value.charAt(0) === '"' && value.charAt(value.length - 1) === '"') ||
        (value.charAt(0) === '\'' && value.charAt(value.length - 1) === '\'')) {
      value = value.slice(1, -1);
    }
    attrs[key] = value;
  }

  return attrs;
}

function pickM3uAttribute(attrs, keys) {
  var selected = '';
  (keys || []).some(function (key) {
    var value = attrs && attrs[String(key).toLowerCase()];
    if (safeTrim(value)) {
      selected = safeTrim(value);
      return true;
    }
    return false;
  });
  return selected;
}

app.post('/api/m3u/parse', async function (req, res) {
  var content = req.body.content || '';
  var sourceUrl = req.body.url || '';

  try {
    if (sourceUrl) {
      var remoteRes = await fetch(sourceUrl, { timeout: 30000 });
      content = await remoteRes.text();
    }

    var lines = content.split(/\r?\n/);
    var result = { live: {}, movies: {}, series: {} };
    var current = null;

    lines.forEach(function (lineRaw) {
      var line = safeTrim(lineRaw);
      if (!line) {
        return;
      }

      if (line.indexOf('#EXTINF') === 0) {
        var attrs = parseM3uExtinfAttributes(line);
        var displayName = ((line.match(/,(.+)$/) || [])[1] || '').trim();
        current = {
          name: pickM3uAttribute(attrs, ['tvg-name', 'name', 'title']) || displayName,
          logo: pickM3uAttribute(attrs, ['tvg-logo', 'logo', 'cover', 'movie_image']),
          group: pickM3uAttribute(attrs, ['group-title', 'group', 'category']) || 'Genel',
          tvgType: pickM3uAttribute(attrs, ['tvg-type', 'type']).toLowerCase(),
          tvgId: pickM3uAttribute(attrs, ['tvg-id', 'tvgid', 'channel-id']),
          description: pickM3uAttribute(attrs, ['plot', 'description', 'desc']),
          year: pickM3uAttribute(attrs, ['year', 'release-date', 'releasedate']),
          attrs: attrs
        };
        return;
      }

      if (line.charAt(0) === '#' || !current) {
        return;
      }

      current.url = line;
      var lowerGroup = current.group.toLowerCase();
      var lowerUrl = current.url.toLowerCase();
      var bucket = 'live';

      if (
        current.tvgType === 'movie' ||
        lowerGroup.indexOf('movie') !== -1 ||
        lowerGroup.indexOf('film') !== -1 ||
        lowerGroup.indexOf('vod') !== -1 ||
        lowerUrl.indexOf('/movie/') !== -1
      ) {
        bucket = 'movies';
      } else if (
        current.tvgType === 'series' ||
        lowerGroup.indexOf('series') !== -1 ||
        lowerGroup.indexOf('serie') !== -1 ||
        lowerUrl.indexOf('/series/') !== -1
      ) {
        bucket = 'series';
      }

      if (!result[bucket][current.group]) {
        result[bucket][current.group] = [];
      }

      result[bucket][current.group].push({
        name: current.name,
        logo: current.logo,
        description: current.description,
        year: current.year,
        tvg_id: current.tvgId,
        cmd: current.url,
        sourceCmd: current.url,
        id: 'm3u-' + stableHashText([bucket, current.name, current.group, current.url].join('|'))
      });

      current = null;
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/playlist-revision', async function (req, res) {
  try {
    var summaries = await loadPlaylistSummaries();
    var revision = getPlaylistRevision(summaries);
    setNoCacheHeaders(res);
    res.json({ revision: revision });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/playlists', async function (req, res) {
  try {
    if (String(req.query.summary || '') === '1') {
      res.json(await loadPlaylistSummaries());
      return;
    }
    res.json(await loadPlaylists());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/playlists/groups', async function (req, res) {
  try {
    var playlists = await loadPlaylists();
    var result = (playlists || [])
      .filter(function (pl) { return pl && pl.data && pl.data.live; })
      .map(function (pl) {
        return {
          playlistId: safeTrim(pl.id),
          playlistName: safeTrim(pl.name) || safeTrim(pl.id),
          groups: Object.keys(pl.data.live || {}).filter(function (g) { return g; })
        };
      })
      .filter(function (pl) { return pl.groups.length > 0; });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/playlists/:id', async function (req, res) {
  try {
    var playlist = await loadPlaylistById(req.params.id);
    if (!playlist) {
      res.status(404).json({ error: 'Bulunamadi' });
      return;
    }
    res.json(playlist);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/playlists', async function (req, res) {
  try {
    var playlist = req.body || {};
    playlist.id = randomUUID();
    playlist.createdAt = new Date().toISOString();
    playlist.updatedAt = playlist.createdAt;
    await createPlaylistRecord(playlist);
    res.json(playlist);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/playlists/:id', async function (req, res) {
  try {
    var updated = await updatePlaylistRecord(req.params.id, Object.assign({}, req.body, {
      updatedAt: new Date().toISOString()
    }));

    if (!updated) {
      res.status(404).json({ error: 'Bulunamadi' });
      return;
    }

    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/playlists/:id/publish-tv', async function (req, res) {
  try {
    var targetId = req.params.id;
    var playlists = await loadPlaylists();
    var target = null;

    for (var index = 0; index < playlists.length; index += 1) {
      var playlist = playlists[index];
      var nextMeta = Object.assign({}, playlist.meta || {});
      var shouldPublish = playlist.id === targetId;

      if (shouldPublish) {
        target = playlist;
      }

      if (!!nextMeta.tvPublished === shouldPublish) {
        continue;
      }

      nextMeta.tvPublished = shouldPublish;
      nextMeta.tvPublishedAt = shouldPublish ? new Date().toISOString() : '';
      await updatePlaylistRecord(playlist.id, {
        meta: nextMeta,
        updatedAt: new Date().toISOString()
      });
    }

    if (!target) {
      res.status(404).json({ error: 'Bulunamadi' });
      return;
    }

    res.json({ ok: true, playlistId: targetId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/playlists/:id', async function (req, res) {
  try {
    await deletePlaylistRecord(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function buildNativeMimeType(streamUrl) {
  var targetUrl = safeTrim(streamUrl);
  if (/\.m3u8(?:[\?#]|$)/i.test(targetUrl)) {
    return 'application/x-mpegURL';
  }
  if (/\.ts(?:[\?#]|$)/i.test(targetUrl)) {
    return 'video/mp2t';
  }
  return 'video/mp4';
}

function buildNativePlayResponse(kind, streamId, baseUrl, credentials, item, options) {
  var seasonNumber = parsePositiveInt(options && options.seasonNumber, 0);
  var episodeNumber = parsePositiveInt(options && options.episodeNumber, 0);
  var routeKind = kind === 'movies' ? 'movie' : kind;
  var streamUrl = seasonNumber && episodeNumber && kind === 'series'
    ? buildLocalSeriesEpisodeUrl(baseUrl, credentials.username, credentials.password, streamId, seasonNumber, episodeNumber)
    : buildLocalStreamUrl(baseUrl, routeKind, credentials.username, credentials.password, streamId, item);

  return {
    url: streamUrl,
    mimeType: buildNativeMimeType(streamUrl),
    headers: {},
    subtitleTracks: []
  };
}

async function buildNativeDetailPayload(kind, streamId, baseUrl, credentials) {
  var found = await findStreamEntry(kind, streamId);

  if (!found) {
    return null;
  }

  var entry = buildNativeCatalogEntry(kind, found.playlist, found.groupName, found.item, streamId);
  var catalog = await collectNativeCatalog(kind);
  var seriesBundle = {
    seasons: [],
    castText: '',
    directorText: '',
    genreText: '',
    overview: '',
    posterUrl: '',
    releaseDate: ''
  };

  if (kind === 'series') {
    try {
      seriesBundle = await buildSeriesNativeSeasons(found, baseUrl, credentials, streamId);
    } catch (error) {
      seriesBundle = Object.assign({}, seriesBundle, {
        overview: cleanNativeText(found.item && found.item.description)
      });
    }
  }
  var castNames = parsePersonList(seriesBundle.castText || found.item.actors);
  var genres = entry.genres.length ? entry.genres : parseGenreList(seriesBundle.genreText);
  var directorName = entry.director || cleanNativeText(seriesBundle.directorText);
  var releaseDate = entry.releaseDate || cleanNativeText(seriesBundle.releaseDate);
  var overview = entry.overview || cleanNativeText(seriesBundle.overview);
  var posterUrl = entry.posterUrl || cleanNativeText(seriesBundle.posterUrl);

  return {
    id: entry.id,
    type: entry.type,
    title: entry.title,
    originalTitle: entry.originalTitle,
    overview: overview,
    posterUrl: posterUrl,
    backdropUrl: entry.backdropUrl || posterUrl,
    releaseDate: releaseDate,
    releaseYear: entry.year || extractYearValue(releaseDate),
    runtimeMinutes: entry.runtimeMinutes,
    durationText: entry.durationText,
    imdbRating: entry.imdbRating,
    tmdbRating: entry.tmdbRating,
    tmdbId: entry.tmdbId,
    genres: genres,
    categoryId: entry.categoryId,
    categoryName: entry.categoryName,
    playlistId: entry.playlistId,
    playlistName: entry.playlistName,
    sourceId: safeTrim(found.item && found.item.id),
    cast: castNames.map(createPersonSummary),
    crew: directorName
      ? [{
          personId: normalizeLookupToken(directorName).replace(/\s+/g, '-'),
          name: directorName,
          job: 'Director',
          photoUrl: ''
        }]
      : [],
    seasons: (seriesBundle.seasons || []).map(function (season) {
      return {
        id: season.id,
        seasonNumber: season.seasonNumber,
        title: season.title,
        overview: season.overview,
        posterUrl: season.posterUrl,
        episodeCount: season.episodeCount,
        episodes: (season.episodes || []).map(function (episode) {
          return {
            id: episode.id,
            seasonNumber: episode.seasonNumber,
            episodeNumber: episode.episodeNumber,
            title: episode.title,
            overview: episode.overview,
            posterUrl: episode.posterUrl,
            playUrl: episode.playUrl
          };
        })
      };
    }),
    localRecommendations: buildNativeRecommendations(entry, catalog.entries, 12),
    play: buildNativePlayResponse(kind, streamId, baseUrl, credentials, found.item, {})
  };
}

app.get('/api/tv/native/catalog', async function (req, res) {
  var auth = await authorizeNativeApi(req, res);
  if (!auth) {
    return;
  }

  var kind = normalizeNativeType(req.query.type);
  if (!kind) {
    res.status(400).json({ error: 'Gecersiz type' });
    return;
  }

  var requestedCategory = safeTrim(req.query.category);
  var query = normalizeLookupToken(req.query.q);
  var page = Math.max(1, parsePositiveInt(req.query.page, 1));
  var pageSize = Math.max(1, Math.min(250, parsePositiveInt(req.query.pageSize, 120)));
  var bundle = await collectNativeCatalog(kind);
  var filtered = bundle.entries.filter(function (entry) {
    if (requestedCategory && entry.categoryId !== requestedCategory) {
      return false;
    }
    if (query && entry._searchText.indexOf(query) === -1) {
      return false;
    }
    return true;
  });
  var startIndex = (page - 1) * pageSize;

  res.json({
    type: kind,
    categories: bundle.categories,
    items: filtered.slice(startIndex, startIndex + pageSize).map(serializeNativeCatalogItem),
    page: page,
    pageSize: pageSize,
    total: filtered.length,
    hasMore: startIndex + pageSize < filtered.length
  });
});

app.get('/api/tv/native/details/:type/:id', async function (req, res) {
  var auth = await authorizeNativeApi(req, res);
  if (!auth) {
    return;
  }

  var kind = normalizeNativeType(req.params.type);
  if (!kind) {
    res.status(400).json({ error: 'Gecersiz type' });
    return;
  }

  try {
    var details = await buildNativeDetailPayload(kind, safeTrim(req.params.id), auth.baseUrl, auth.credentials);
    if (!details) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json(details);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/tv/native/play', async function (req, res) {
  var auth = await authorizeNativeApi(req, res);
  if (!auth) {
    return;
  }

  var kind = normalizeNativeType(req.query.type);
  var streamId = safeTrim(req.query.id);
  if (!kind || !streamId) {
    res.status(400).json({ error: 'type ve id gerekli' });
    return;
  }

  var found = await findStreamEntry(kind, streamId);
  if (!found) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  res.json(
    buildNativePlayResponse(kind, streamId, auth.baseUrl, auth.credentials, found.item, {
      seasonNumber: req.query.season,
      episodeNumber: req.query.episode
    })
  );
});

app.get('/api/tv/native/search', async function (req, res) {
  var auth = await authorizeNativeApi(req, res);
  if (!auth) {
    return;
  }

  var query = normalizeLookupToken(req.query.q);
  if (!query) {
    res.json({ query: '', items: [] });
    return;
  }

  var kinds = ['live', 'movies', 'series'];
  var results = [];

  for (var index = 0; index < kinds.length; index += 1) {
    var bundle = await collectNativeCatalog(kinds[index]);
    bundle.entries.forEach(function (entry) {
      if (entry._searchText.indexOf(query) !== -1) {
        results.push(entry);
      }
    });
  }

  results.sort(function (left, right) {
    return left.title.localeCompare(right.title);
  });

  res.json({
    query: safeTrim(req.query.q),
    items: results.slice(0, 80).map(serializeNativeCatalogItem)
  });
});

app.get('/api/tv/native/person/:personId', async function (req, res) {
  var auth = await authorizeNativeApi(req, res);
  if (!auth) {
    return;
  }

  var personName = decodeURIComponent(safeTrim(req.params.personId)).replace(/-/g, ' ');
  var lookup = normalizeLookupToken(personName);
  if (!lookup) {
    res.status(400).json({ error: 'Gecersiz person id' });
    return;
  }

  var moviesCatalog = await collectNativeCatalog('movies');
  var seriesCatalog = await collectNativeCatalog('series');
  var filterByPerson = function (entry) {
    return (entry._actorsNormalized || []).some(function (value) {
      return value === lookup;
    });
  };
  var movieMatches = moviesCatalog.entries.filter(filterByPerson).slice(0, 40).map(serializeNativeCatalogItem);
  var seriesMatches = seriesCatalog.entries.filter(filterByPerson).slice(0, 40).map(serializeNativeCatalogItem);
  var resolvedName = personName;

  moviesCatalog.entries.concat(seriesCatalog.entries).some(function (entry) {
    var matchedIndex = (entry._actorsNormalized || []).indexOf(lookup);
    if (matchedIndex >= 0 && entry.actorNames && entry.actorNames[matchedIndex]) {
      resolvedName = entry.actorNames[matchedIndex];
      return true;
    }
    return false;
  });

  res.json({
    id: lookup.replace(/\s+/g, '-'),
    name: resolvedName,
    photoUrl: '',
    biography: '',
    localMovies: movieMatches,
    localSeries: seriesMatches
  });
});

app.get('/api/tv/native/recommendations/:type/:id', async function (req, res) {
  var auth = await authorizeNativeApi(req, res);
  if (!auth) {
    return;
  }

  var kind = normalizeNativeType(req.params.type);
  if (!kind) {
    res.status(400).json({ error: 'Gecersiz type' });
    return;
  }

  var bundle = await collectNativeCatalog(kind);
  var source = bundle.entries.find(function (entry) {
    return entry.id === safeTrim(req.params.id);
  });

  if (!source) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  res.json({
    sourceId: source.id,
    localRecommendations: buildNativeRecommendations(source, bundle.entries, 16)
  });
});

var xtreamApp = express();
xtreamApp.use(cors());
xtreamApp.get('/', function (req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end([
    '<!doctype html>',
    '<html lang="tr">',
    '<head>',
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
    '  <title>TV Sunucu</title>',
    '  <style>',
    '    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;padding:24px;line-height:1.5;}',
    '    code{background:#f3f4f6;padding:2px 6px;border-radius:6px;}',
    '    a{color:#2563eb;text-decoration:none;}a:hover{text-decoration:underline;}',
    '    .box{max-width:860px;margin:0 auto;} .muted{color:#6b7280;} .row{margin:10px 0;}',
    '  </style>',
    '</head>',
    '<body>',
    '  <div class="box">',
    '    <h1>TV Sunucu (Xtream/M3U)</h1>',
    '    <p class="muted">Bu port UI icin degil; TV uygulamalarinin cektigi Xtream/M3U endpointlerini sunar.</p>',
    '    <div class="row"><strong>Endpointler:</strong></div>',
    '    <div class="row"><code>/player_api.php?username=&lt;user&gt;&amp;password=&lt;pass&gt;</code></div>',
    '    <div class="row"><code>/get.php?username=&lt;user&gt;&amp;password=&lt;pass&gt;</code> (M3U)</div>',
    '    <div class="row"><code>/playlist.m3u</code> (opsiyonel: <code>?username=...&amp;password=...</code>)</div>',
    '    <div class="row muted">Not: Dashboard/Editor gibi arayuzler web portunda (genelde 3000) calisir.</div>',
    '  </div>',
    '</body>',
    '</html>'
  ].join('\n'));
});

xtreamApp.get('/health', function (req, res) {
  res.json({ status: 'ok' });
});

xtreamApp.get('/player_api.php', async function (req, res) {
  var credentials;
  try {
    credentials = await getServerCredentials();
  } catch (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  if (req.query.username !== credentials.username || req.query.password !== credentials.password) {
    res.json({ user_info: { auth: 0 } });
    return;
  }

  var catalog = await collectOutputData();
  var action = req.query.action || '';
  var baseUrl = getServerBaseUrl(req);

  if (action === 'get_live_categories') {
    res.json(catalog.liveCategories);
    return;
  }
  if (action === 'get_vod_categories') {
    res.json(catalog.movieCategories);
    return;
  }
  if (action === 'get_series_categories') {
    res.json(catalog.seriesCategories);
    return;
  }
  if (action === 'get_live_streams') {
    res.json(catalog.liveStreams.map(function (item) {
      return Object.assign({}, item, {
        direct_source: buildLocalStreamUrl(baseUrl, 'live', credentials.username, credentials.password, item.output_id, item)
      });
    }));
    return;
  }
  if (action === 'get_vod_streams') {
    res.json(catalog.movieStreams.map(function (item) {
      return Object.assign({}, item, {
        direct_source: buildLocalStreamUrl(baseUrl, 'movie', credentials.username, credentials.password, item.output_id, item)
      });
    }));
    return;
  }
  if (action === 'get_series') {
    res.json(catalog.seriesStreams.map(function (item) {
      return Object.assign({}, item, {
        direct_source: buildLocalStreamUrl(baseUrl, 'series', credentials.username, credentials.password, item.output_id, item)
      });
    }));
    return;
  }
  if (action === 'get_vod_info') {
    var vodId = safeTrim(req.query.vod_id || req.query.stream_id);
    var foundVod = await findStreamEntry('movies', vodId);

    if (!foundVod) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    var vodItem = foundVod.item || {};
    var vodImage = pickItemImage(vodItem);
    var vodStreamUrl = buildLocalStreamUrl(baseUrl, 'movie', credentials.username, credentials.password, vodId, vodItem);
    res.json({
      info: {
        name: safeTrim(vodItem.name),
        movie_image: vodImage,
        cover_big: vodImage,
        plot: pickItemPlot(vodItem),
        cast: safeTrim(vodItem.actors || vodItem.cast),
        director: safeTrim(vodItem.director),
        genre: safeTrim(vodItem.genres_str || vodItem.genre),
        releasedate: safeTrim(vodItem.year || vodItem.releaseDate),
        rating: safeTrim(vodItem.rating_imdb || vodItem.rating),
        duration: safeTrim(vodItem.time),
        backdrop_path: vodImage ? [vodImage] : []
      },
      movie_data: {
        stream_id: parseInt(vodId, 10),
        name: safeTrim(vodItem.name),
        added: safeTrim(vodItem.added),
        category_id: '',
        container_extension: streamExtension('movies', vodItem),
        custom_sid: '',
        direct_source: vodStreamUrl
      }
    });
    return;
  }
  if (action === 'get_series_info') {
    var seriesId = safeTrim(req.query.series_id);
    var foundSeries = await findStreamEntry('series', seriesId);

    if (!foundSeries) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    var seriesItem = foundSeries.item || {};
    var seasons = [];
    var episodes = {};
    var itemImage = pickItemImage(seriesItem);
    var info = {
      name: safeTrim(seriesItem.name),
      cover: itemImage,
      plot: pickItemPlot(seriesItem),
      cast: safeTrim(seriesItem.actors),
      director: safeTrim(seriesItem.director),
      genre: safeTrim(seriesItem.genres_str),
      releaseDate: safeTrim(seriesItem.year)
    };

    var sourceType = safeTrim(seriesItem.sourceType) || safeTrim(foundSeries.playlist && foundSeries.playlist.type);
    var sourceMeta = seriesItem && seriesItem.sourceMeta ? seriesItem.sourceMeta : (foundSeries.playlist && foundSeries.playlist.meta);

    if (sourceType === 'stalker' && sourceMeta && sourceMeta.url && sourceMeta.mac && safeTrim(seriesItem.id)) {
      try {
        var seasonItems = await fetchStalkerSeriesSeasons(sourceMeta.url, sourceMeta.mac, seriesItem.id);
        seasons = seasonItems.map(function (seasonItem, seasonIndex) {
          var seasonNumber = getSeriesSeasonNumber(seasonItem) || (seasonIndex + 1);
          var seasonName = safeTrim(seasonItem.name) || ('Season ' + seasonNumber);
          var seasonEpisodes = Array.isArray(seasonItem.series) ? seasonItem.series : [];
          if (!info.plot) {
            info.plot = pickItemPlot(seasonItem);
          }
          if (!info.cover) {
            info.cover = pickItemImage(seasonItem);
          }
          if (!info.cast) {
            info.cast = safeTrim(seasonItem.actors);
          }
          if (!info.director) {
            info.director = safeTrim(seasonItem.director);
          }
          if (!info.genre) {
            info.genre = safeTrim(seasonItem.genres_str);
          }
          if (!info.releaseDate) {
            info.releaseDate = safeTrim(seasonItem.year);
          }

          episodes[String(seasonNumber)] = seasonEpisodes.map(function (episodeValue) {
            var episodeNumber = parseInt(episodeValue, 10) || 1;
            return {
              id: seriesId + '-s' + seasonNumber + '-e' + episodeNumber,
              episode_num: episodeNumber,
              title: seasonName + ' - Episode ' + episodeNumber,
              container_extension: 'mp4',
              added: '',
              custom_sid: '',
              direct_source: buildLocalSeriesEpisodeUrl(baseUrl, credentials.username, credentials.password, seriesId, seasonNumber, episodeNumber),
              info: {
                plot: pickItemPlot(seasonItem),
                movie_image: pickItemImage(seasonItem) || info.cover
              }
            };
          });

          return {
            air_date: '',
            episode_count: seasonEpisodes.length,
            id: String(seasonNumber),
            name: seasonName,
            overview: pickItemPlot(seasonItem),
            season_number: seasonNumber,
            cover: pickItemImage(seasonItem) || info.cover,
            cover_big: pickItemImage(seasonItem) || info.cover
          };
        });
      } catch (error) {
        info.plot = info.plot || error.message;
      }
    } else if (sourceType === 'xtream' && sourceMeta && safeTrim(seriesItem.id)) {
      try {
        var xtreamSeriesInfo = await fetchXtreamSeriesInfo(sourceMeta, seriesItem.id);
        var remoteInfo = xtreamSeriesInfo && xtreamSeriesInfo.info ? xtreamSeriesInfo.info : {};
        info.name = pickFirstNonEmptyText(remoteInfo, ['name', 'title']) || info.name;
        info.cover = pickItemImage(remoteInfo) || info.cover;
        info.plot = pickItemPlot(remoteInfo) || info.plot;
        info.cast = safeTrim(remoteInfo.cast || remoteInfo.actors) || info.cast;
        info.director = safeTrim(remoteInfo.director) || info.director;
        info.genre = safeTrim(remoteInfo.genre || remoteInfo.genres_str) || info.genre;
        info.releaseDate = safeTrim(remoteInfo.releaseDate || remoteInfo.releasedate || remoteInfo.year) || info.releaseDate;

        var seasonByNumber = {};
        if (Array.isArray(xtreamSeriesInfo.seasons)) {
          xtreamSeriesInfo.seasons.forEach(function (seasonValue, seasonIndex) {
            var seasonNumber = parsePositiveInt(seasonValue.season_number || seasonValue.number || seasonValue.id, seasonIndex + 1);
            seasonByNumber[String(seasonNumber)] = {
              air_date: safeTrim(seasonValue.air_date),
              episode_count: 0,
              id: safeTrim(seasonValue.id) || String(seasonNumber),
              name: safeTrim(seasonValue.name) || ('Season ' + seasonNumber),
              overview: pickItemPlot(seasonValue),
              season_number: seasonNumber,
              cover: pickItemImage(seasonValue) || info.cover,
              cover_big: pickItemImage(seasonValue) || info.cover
            };
          });
        }

        flattenXtreamEpisodes(xtreamSeriesInfo).forEach(function (entry) {
          var episodeItem = entry.episode || {};
          var seasonNumber = getXtreamEpisodeSeasonNumber(entry);
          var episodeNumber = getXtreamEpisodeNumber(entry);
          var seasonKey = String(seasonNumber);
          var episodeImage = pickItemImage(episodeItem) || info.cover;
          if (!episodes[seasonKey]) {
            episodes[seasonKey] = [];
          }
          episodes[seasonKey].push({
            id: seriesId + '-s' + seasonNumber + '-e' + episodeNumber,
            episode_num: episodeNumber,
            title: safeTrim(episodeItem.title || episodeItem.name) || ('Episode ' + episodeNumber),
            container_extension: safeTrim(episodeItem.container_extension) || 'mp4',
            added: safeTrim(episodeItem.added),
            custom_sid: safeTrim(episodeItem.custom_sid),
            direct_source: buildLocalSeriesEpisodeUrl(baseUrl, credentials.username, credentials.password, seriesId, seasonNumber, episodeNumber),
            info: Object.assign({}, episodeItem.info && typeof episodeItem.info === 'object' ? episodeItem.info : {}, {
              plot: pickItemPlot(episodeItem.info || episodeItem) || info.plot,
              movie_image: episodeImage
            })
          });

          if (!seasonByNumber[seasonKey]) {
            seasonByNumber[seasonKey] = {
              air_date: '',
              episode_count: 0,
              id: seasonKey,
              name: 'Season ' + seasonNumber,
              overview: info.plot,
              season_number: seasonNumber,
              cover: info.cover,
              cover_big: info.cover
            };
          }
          seasonByNumber[seasonKey].episode_count += 1;
        });

        seasons = Object.keys(seasonByNumber)
          .sort(function (left, right) { return parseInt(left, 10) - parseInt(right, 10); })
          .map(function (seasonKey) { return seasonByNumber[seasonKey]; });
      } catch (error) {
        info.plot = info.plot || error.message;
      }
    }

    if (!Object.keys(episodes).length && safeTrim(seriesItem.sourceCmd || seriesItem.cmd)) {
      seasons = [{
        air_date: '',
        episode_count: 1,
        id: '1',
        name: 'Season 1',
        overview: info.plot,
        season_number: 1,
        cover: info.cover,
        cover_big: info.cover
      }];
      episodes['1'] = [{
        id: seriesId + '-s1-e1',
        episode_num: 1,
        title: safeTrim(seriesItem.name) || 'Episode 1',
        container_extension: streamExtension('series', seriesItem),
        added: '',
        custom_sid: '',
        direct_source: buildLocalSeriesEpisodeUrl(baseUrl, credentials.username, credentials.password, seriesId, 1, 1),
        info: {
          plot: info.plot,
          movie_image: info.cover
        }
      }];
    }

    res.json({
      info: info,
      seasons: seasons,
      episodes: episodes
    });
    return;
  }

  res.json({
    user_info: {
      username: credentials.username,
      password: credentials.password,
      message: 'Welcome',
      auth: 1,
      status: 'Active',
      exp_date: '9999999999',
      is_trial: '0',
      active_cons: '1',
      created_at: '0',
      max_connections: '10',
      allowed_output_formats: ['ts', 'm3u8', 'mp4']
    },
    server_info: {
      url: req.hostname,
      port: ENABLE_TV_SERVER ? String(XTREAM_PORT) : '',
      https_port: ENABLE_TV_SERVER ? String(XTREAM_PORT) : '',
      server_protocol: req.protocol,
      rtmp_port: '8935',
      timezone: 'Europe/Istanbul',
      timestamp_now: Math.floor(Date.now() / 1000),
      time_now: new Date().toISOString()
    }
  });
});

xtreamApp.get('/live/:user/:pass/:id', async function (req, res) {
  var streamId = String(req.params.id || '').replace(/\.[^.]+$/, '');
  var found = await findStreamEntry('live', streamId);

  if (!found) {
    res.status(404).send('Not found');
    return;
  }

  // Loop channels are already local HLS output.
  // NOTE: Some IPTV clients (notably Kodi/PVR IPTV Simple) are unreliable with HTTP redirects + relative
  // segment paths. Serve the HLS playlist directly and rewrite segment URIs as absolute URLs.
  var originalUrl = getOriginalPlaybackUrl(found.item);
  if (originalUrl && isYouTubeUrl(originalUrl)) {
    try {
      var liveResult = await resolveYouTubeStream({ url: originalUrl });
      if (!liveResult || !liveResult.streamUrl || liveResult.playerMode === 'iframe') {
        return res.status(503).send('YouTube stream could not be resolved');
      }
      await deliverResolvedStream(req, res, liveResult);
    } catch (liveErr) {
      console.warn('[live/yt] resolve hata:', liveErr && liveErr.message);
      if (!res.headersSent) {
        res.status(503).send('YouTube stream could not be resolved');
      }
    }
    return;
  }

  try {
    var resolved = await resolvePlaylistItemStream(found.playlist, 'live', found.item);
    await deliverResolvedStream(req, res, resolved);
  } catch (error) {
    res.status(500).send(error.message);
  }
});

xtreamApp.get('/movie/:user/:pass/:id', async function (req, res) {
  var streamId = String(req.params.id || '').replace(/\.[^.]+$/, '');
  var found = await findStreamEntry('movies', streamId);

  if (!found) {
    res.status(404).send('Not found');
    return;
  }

  var originalUrl = getOriginalPlaybackUrl(found.item);
  if (originalUrl && isYouTubeUrl(originalUrl)) {
    try {
      var resolved = await resolveYouTubeStream(found.item);
      if (!resolved || !resolved.streamUrl || resolved.playerMode === 'iframe') {
        return res.status(503).send('YouTube stream could not be resolved');
      }
      await deliverResolvedStream(req, res, resolved);
    } catch (error) {
      res.status(503).send('YouTube stream could not be resolved');
    }
    return;
  }

  try {
    var resolved = await resolvePlaylistItemStream(found.playlist, 'movies', found.item);
    await deliverResolvedStream(req, res, resolved);
  } catch (error) {
    res.status(500).send(error.message);
  }
});

xtreamApp.get('/series/:user/:pass/:id', async function (req, res) {
  var seriesToken = String(req.params.id || '').replace(/\.[^.]+$/, '');
  var seriesMatch = seriesToken.match(/^(.+?)(?:-s(\d+)-e(\d+))?$/);
  var streamId = seriesMatch ? seriesMatch[1] : seriesToken;
  var requestedSeasonNumber = seriesMatch && seriesMatch[2] ? parseInt(seriesMatch[2], 10) : 0;
  var requestedEpisodeNumber = seriesMatch && seriesMatch[3] ? parseInt(seriesMatch[3], 10) : 0;
  var found = await findStreamEntry('series', streamId);

  if (!found) {
    res.status(404).send('Not found');
    return;
  }

  var originalUrl = getOriginalPlaybackUrl(found.item);
  if (originalUrl && isYouTubeUrl(originalUrl)) {
    try {
      var resolved = await resolveYouTubeStream(found.item);
      if (!resolved || !resolved.streamUrl || resolved.playerMode === 'iframe') {
        return res.status(503).send('YouTube stream could not be resolved');
      }
      await deliverResolvedStream(req, res, resolved);
    } catch (error) {
      res.status(503).send('YouTube stream could not be resolved');
    }
    return;
  }

  try {
    var resolved = await resolvePlaylistItemStream(found.playlist, 'series', found.item, {
      preferredSeasonNumber: requestedSeasonNumber,
      preferredEpisodeNumber: requestedEpisodeNumber
    });
    await deliverResolvedStream(req, res, resolved);
  } catch (error) {
    res.status(500).send(error.message);
  }
});

async function buildTvPlaylistText(baseUrl, credentials) {
  var lists = getTvOutputPlaylists(await loadPlaylists());
  var lines = ['#EXTM3U'];
  var streamBaseStatus = getStreamBaseUrlStatus();
  var shouldIncludeOutputItem = createOutputDeduper();

  lists.forEach(function (playlist) {
    if (!playlist || !playlist.data) {
      return;
    }

    ['live', 'movies', 'series'].forEach(function (kind) {
      Object.keys(playlist.data[kind] || {}).forEach(function (groupName) {
        if (isPlaylistCategoryHidden(playlist, kind, groupName)) {
          return;
        }

        (playlist.data[kind][groupName] || []).forEach(function (item, index) {
          if (!shouldIncludeOutputItem(kind, playlist, item)) {
            return;
          }

          var outputId = makeOutputId(kind, item, index, playlist.id);
          var streamPath = kind === 'movies' ? 'movie' : kind;
          var streamUrl = buildLocalStreamUrl(baseUrl, streamPath, credentials.username, credentials.password, outputId, item);
          var imageUrl = pickItemImage(item);
          lines.push(
            '#EXTINF:-1 tvg-name="' +
              (item.name || '') +
              '" tvg-logo="' +
              imageUrl +
              '" tvg-type="' +
              (kind === 'movies' ? 'movie' : kind === 'series' ? 'series' : 'live') +
              '" group-title="' +
              groupName +
              '",' +
              (item.name || '')
          );
          lines.push(streamUrl);
        });
      });
    });
  });

  return lines.join('\n');
}

xtreamApp.get('/get.php', async function (req, res) {
  var credentials;
  try {
    credentials = await getServerCredentials();
  } catch (error) {
    res.status(500).send(error.message);
    return;
  }

  if (req.query.username !== credentials.username || req.query.password !== credentials.password) {
    res.status(401).send('Unauthorized');
    return;
  }

  var baseUrl = getServerBaseUrl(req);
  setNoCacheHeaders(res);
  res.setHeader('Content-Type', 'application/x-mpegurl');
  try {
    res.send(await buildTvPlaylistText(baseUrl, credentials));
  } catch (error) {
    res.status(500).send(error && error.message ? error.message : 'Playlist build failed');
  }
});

xtreamApp.get('/playlist.m3u', async function (req, res) {
  var credentials;
  try {
    credentials = await getServerCredentials();
  } catch (error) {
    res.status(500).send(error.message);
    return;
  }

  var providedUser = safeTrim(req.query.username);
  var providedPass = safeTrim(req.query.password);
  if (
    (providedUser || providedPass) &&
    (providedUser !== credentials.username || providedPass !== credentials.password)
  ) {
    res.status(401).send('Unauthorized');
    return;
  }

  setNoCacheHeaders(res);
  res.setHeader('Content-Type', 'application/x-mpegurl');
  try {
    res.send(await buildTvPlaylistText(getServerBaseUrl(req), credentials));
  } catch (error) {
    res.status(500).send(error && error.message ? error.message : 'Playlist build failed');
  }
});

xtreamApp.get('/playlist-latest.m3u', async function (req, res) {
  var credentials;
  try {
    credentials = await getServerCredentials();
  } catch (error) {
    res.status(500).send(error.message);
    return;
  }

  var providedUser = safeTrim(req.query.username);
  var providedPass = safeTrim(req.query.password);
  if (
    (providedUser || providedPass) &&
    (providedUser !== credentials.username || providedPass !== credentials.password)
  ) {
    res.status(401).send('Unauthorized');
    return;
  }

  try {
    var revision = getPlaylistRevision(await loadPlaylistSummaries());
    setNoCacheHeaders(res);
    var target = '/playlist.m3u?v=' + encodeURIComponent(revision);
    if (providedUser || providedPass) {
      target +=
        '&username=' +
        encodeURIComponent(providedUser) +
        '&password=' +
        encodeURIComponent(providedPass);
    }
    res.redirect(302, target);
  } catch (error) {
    res.status(500).send(error.message);
  }
});

app.get('/api/server-info', function (req, res) {
  Promise.all([getServerCredentials(), loadPlaylistSummaries()])
    .then(function (results) {
      var config = results[0];
      var lists = results[1] || [];
      var explicitPublishedLists = (lists || []).filter(isPlaylistPublishedToTv);
      var publishedLists = explicitPublishedLists.length ? explicitPublishedLists : lists;

      res.json({
        enabled: true,
        separatePort: ENABLE_TV_SERVER,
        deliveryMode: TV_DELIVERY_MODE,
        port: XTREAM_PORT,
        username: config.username,
        password: config.password,
        storage: storage.isDatabase ? 'database' : 'file',
        storageMode: storage.mode || (storage.isDatabase ? 'database' : 'file'),
        hasDatabase: !!DATABASE_CONNECTION_STRING && !FORCE_FILE_STORAGE,
        readOnly: !!STORAGE_READONLY_REASON,
        readOnlyReason: STORAGE_READONLY_REASON,
        storageFallbackReason: storage.fallbackReason || '',
        databaseProvider: getDatabaseProviderLabel(DATABASE_CONNECTION_STRING),
        databaseHost: getConnectionHost(DATABASE_CONNECTION_STRING),
        canTriggerLocalDeploy: !process.env.VERCEL,
        lastLocalDeploy: LAST_VERCEL_DEPLOY,
        deployInProgress: VERCEL_DEPLOY_IN_PROGRESS,
        linkedVercelProject: readLocalVercelProjectInfo(),
        sharingMode: explicitPublishedLists.length ? 'selected' : 'all',
        publishedPlaylists: publishedLists.map(function (playlist) {
          return {
            id: playlist.id,
            name: playlist.name,
            type: playlist.type
          };
        })
      });
    })
    .catch(function (error) {
      res.status(500).json({ error: error.message });
    });
});

app.post('/api/cache/clear', function(req, res) {
  try {
    invalidatePlaylistCaches();
    invalidateServerConfigCache();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/playlists/sync-all', async function(req, res) {
  try {
    invalidatePlaylistCaches();
    await loadPlaylists({ force: true });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/server-config', async function (req, res) {
  try {
    var current = await getServerCredentials();
    var nextConfig = await saveServerCredentials({
      username: req.body.username ? safeTrim(req.body.username) : current.username,
      password: req.body.password ? safeTrim(req.body.password) : current.password
    });
    res.json({
      ok: true,
      enabled: true,
      separatePort: ENABLE_TV_SERVER,
      deliveryMode: TV_DELIVERY_MODE,
      username: nextConfig.username,
      password: nextConfig.password
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/deploy/vercel', async function (req, res) {
  if (process.env.VERCEL) {
    res.status(400).json({ error: 'Vercel deploy butonu sadece yerel calismada kullanilir.' });
    return;
  }

  if (VERCEL_DEPLOY_IN_PROGRESS) {
    res.status(409).json({ error: 'Vercel deploy zaten calisiyor.' });
    return;
  }

  VERCEL_DEPLOY_IN_PROGRESS = true;

  try {
    var result = await runLocalVercelDeploy();
    LAST_VERCEL_DEPLOY = {
      at: new Date().toISOString(),
      deploymentUrl: result.deploymentUrl
    };
    res.json({
      ok: true,
      deploymentUrl: result.deploymentUrl,
      output: result.stdout || result.stderr || 'Deploy tamamlandi.'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    VERCEL_DEPLOY_IN_PROGRESS = false;
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ─── Global YouTube proxy stream (Codex mantigi: her istek = taze yt-dlp URL) ───
app.options('/api/yt-stream', function(req, res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Range, Content-Type');
  res.sendStatus(204);
});

app.get('/api/yt-stream', async function(req, res) {
  var id = String(req.query.id || '').trim();
  var quality = String(req.query.quality || 'best[height<=720][ext=mp4]/best[height<=720]/best');

  if (!id) return res.status(400).json({ error: 'id parametresi gerekli' });

  res.set('Access-Control-Allow-Origin', '*');

  var ytCmd = resolveYouTubeCommand();
  if (!ytCmd) return res.status(503).json({ error: 'yt-dlp bulunamadi' });

  try {
    var streamUrl = await new Promise(function(resolve, reject) {
      var cp = require('child_process');
      var args = (ytCmd.argsPrefix || []).concat([
        '--no-check-certificate', '--geo-bypass', '--no-playlist',
        '-f', quality, '-g', '--',
        'https://www.youtube.com/watch?v=' + id
      ]);
      var proc = cp.spawn(ytCmd.command, args, { windowsHide: true });
      var out = '', err = '';
      proc.stdout.on('data', function(d) { out += d.toString(); });
      proc.stderr.on('data', function(d) { err += d.toString(); });
      proc.on('close', function(code) {
        var lines = out.trim().split('\n').filter(Boolean);
        if (lines[0]) resolve(lines[0].trim());
        else reject(new Error('yt-dlp basarisiz (kod ' + code + '): ' + err.substring(0, 100)));
      });
      proc.on('error', reject);
    });

    var upstreamHeaders = { 'User-Agent': 'Mozilla/5.0' };
    await proxyRemoteStream(req, res, streamUrl, upstreamHeaders);
  } catch (e) {
    console.error('[yt-stream] id=' + id + ':', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Stream alinamadi: ' + e.message });
  }
});

app.get('/api/yt-info', async function(req, res) {
  var id = String(req.query.id || '').trim();
  if (!id) return res.status(400).json({ error: 'id gerekli' });

  res.set('Access-Control-Allow-Origin', '*');

  var ytCmd = resolveYouTubeCommand();
  if (!ytCmd) return res.status(503).json({ error: 'yt-dlp bulunamadi' });

  try {
    var info = await new Promise(function(resolve, reject) {
      var cp = require('child_process');
      var args = (ytCmd.argsPrefix || []).concat([
        '--dump-json', '--no-playlist', '--',
        'https://www.youtube.com/watch?v=' + id
      ]);
      var proc = cp.spawn(ytCmd.command, args, { windowsHide: true });
      var out = '';
      proc.stdout.on('data', function(d) { out += d.toString(); });
      proc.on('close', function() {
        try { resolve(JSON.parse(out)); } catch (e) { reject(new Error('JSON parse hatasi')); }
      });
      proc.on('error', reject);
    });
    res.json({
      id: id,
      title: info.title,
      uploader: info.uploader,
      duration: info.duration,
      thumbnail: info.thumbnail,
      isLive: info.is_live || false
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── YouTube Proxy Channel System ─────────────────────────────────────────────

var ytChannels = require('./lib/yt-channels');
ytChannels.configureStorage(storage);

function decodeProxySegmentParam(value) {
  try {
    return Buffer.from(String(value || ''), 'base64url').toString('utf8');
  } catch (error) {
    return '';
  }
}

async function resolveYouTubeProxyVideoId(proxyId) {
  var id = safeTrim(proxyId);
  var directVideoId = ytStream.extractVideoId(id);

  if (directVideoId && /^yt_[A-Za-z0-9_-]{11}$/.test(id)) {
    return directVideoId;
  }

  var channels = await ytChannels.getChannels();
  var channel = channels && channels[id];
  return safeTrim(channel && channel.videoId);
}

async function handleYouTubeProxyRoute(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');

  var rawU = req.query && (Array.isArray(req.query.u) ? req.query.u[0] : req.query.u);
  var rawUrl = req.query && (Array.isArray(req.query.url) ? req.query.url[0] : req.query.url);
  var segmentUrl = safeTrim(rawUrl || (rawU ? decodeProxySegmentParam(rawU) : ''));

  if (req.method === 'HEAD') {
    res.setHeader('Content-Type', segmentUrl ? 'video/MP2T' : 'application/vnd.apple.mpegurl; charset=utf-8');
    return res.status(200).end();
  }

  if (segmentUrl) {
    return proxyRemoteStream(req, res, segmentUrl, {
      'User-Agent': 'Mozilla/5.0',
      Accept: '*/*'
    });
  }

  var videoId = await resolveYouTubeProxyVideoId(req.params && req.params.id);
  if (!videoId) {
    return res.status(404).send('Kanal bulunamadi');
  }

  var resolved = await resolveYouTubeStream({
    url: 'https://www.youtube.com/watch?v=' + videoId
  });
  if (!resolved || !resolved.streamUrl || resolved.playerMode === 'iframe') {
    return res.status(503).send('YouTube stream could not be resolved');
  }

  return deliverResolvedStream(req, res, resolved);
}

function normalizeYouTubeLiveTitle(title, videoId) {
  return safeTrim(title) || ('YouTube ' + safeTrim(videoId));
}

function buildYouTubeLiveItem(videoId, title, originalUrl, logo) {
  var proxyPath = buildYouTubeProxyPath(videoId);
  return {
    id: 'yt_' + videoId,
    name: normalizeYouTubeLiveTitle(title, videoId),
    logo: safeTrim(logo),
    cmd: proxyPath,
    sourceCmd: proxyPath,
    sourceType: 'external',
    sourceMeta: {
      originalUrl: safeTrim(originalUrl) || ('https://www.youtube.com/watch?v=' + videoId),
      providerLabel: 'YouTube Live',
      videoId: videoId
    }
  };
}

async function addYouTubeToLiveTv(options) {
  var url = safeTrim(options && options.url);
  var videoId = ytStream.extractVideoId(url);
  if (!videoId) {
    throw new Error('Gecersiz YouTube linki');
  }

  var playlistName = safeTrim(process.env.YOUTUBE_LIVE_PLAYLIST_NAME) || 'Bizim Kanallar';
  var groupName = safeTrim(process.env.YOUTUBE_LIVE_GROUP_NAME) || 'Bizim Kanallar';
  var title = normalizeYouTubeLiveTitle(options && options.title, videoId);
  var item = buildYouTubeLiveItem(videoId, title, url, options && options.logo);
  var playlists = await loadPlaylists({ force: true });
  var playlist = (playlists || []).find(function (candidate) {
    return safeTrim(candidate && candidate.name).toLowerCase() === playlistName.toLowerCase() &&
      isCuratedOutputPlaylist(candidate);
  });
  var now = new Date().toISOString();

  if (!playlist) {
    playlist = {
      id: randomUUID(),
      name: playlistName,
      type: 'custom',
      data: { live: {}, movies: {}, series: {} },
      meta: {
        playlistBucket: 'curated',
        tvPublished: true,
        tvPublishedAt: now
      },
      createdAt: now,
      updatedAt: now
    };
  }

  playlist.data = playlist.data || { live: {}, movies: {}, series: {} };
  playlist.data.live = playlist.data.live || {};
  playlist.data.movies = playlist.data.movies || {};
  playlist.data.series = playlist.data.series || {};
  var groupItems = playlist.data.live[groupName] || [];
  var existingIndex = groupItems.findIndex(function (candidate) {
    return safeTrim(candidate && candidate.id) === item.id ||
      safeTrim(candidate && candidate.sourceMeta && candidate.sourceMeta.videoId) === videoId ||
      safeTrim(candidate && (candidate.cmd || candidate.sourceCmd)).indexOf('yt_' + videoId) !== -1;
  });

  if (existingIndex >= 0) {
    groupItems[existingIndex] = Object.assign({}, groupItems[existingIndex], item);
  } else {
    groupItems.push(item);
  }

  playlist.data.live[groupName] = groupItems;
  playlist.meta = Object.assign({}, playlist.meta || {}, {
    playlistBucket: 'curated',
    tvPublished: true,
    tvPublishedAt: (playlist.meta && playlist.meta.tvPublishedAt) || now
  });
  playlist.updatedAt = now;

  var saved = await (playlist.createdAt === now
    ? createPlaylistRecord(playlist)
    : updatePlaylistRecord(playlist.id, {
        name: playlist.name,
        type: playlist.type,
        data: playlist.data,
        meta: playlist.meta,
        updatedAt: playlist.updatedAt
      }));

  await ytChannels.addChannel(url || ('https://www.youtube.com/watch?v=' + videoId), videoId, title);

  return {
    ok: true,
    id: item.id,
    videoId: videoId,
    title: title,
    playlistId: saved && saved.id || playlist.id,
    playlistName: playlist.name,
    groupName: groupName,
    liveUrlPath: item.cmd
  };
}

// GET /yt-channels sayfası zaten yukarıda tanımlı

app.all('/proxy', function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS, PROPFIND');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.status(req.method === 'OPTIONS' || req.method === 'PROPFIND' ? 204 : 404).end();
});

app.all('/proxy/', function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS, PROPFIND');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.status(req.method === 'OPTIONS' || req.method === 'PROPFIND' ? 204 : 404).end();
});

app.options('/proxy/:id', function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.status(200).end();
});

app.get('/proxy/:id', async function(req, res) {
  try {
    await handleYouTubeProxyRoute(req, res);
  } catch (error) {
    console.error('[yt-proxy]', error && error.message);
    if (!res.headersSent) {
      res.status(503).send('YouTube stream could not be resolved');
    }
  }
});

app.head('/proxy/:id', async function(req, res) {
  try {
    await handleYouTubeProxyRoute(req, res);
  } catch (error) {
    if (!res.headersSent) {
      res.status(503).end();
    }
  }
});

app.all('/proxy/:id', function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS, PROPFIND');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.status(req.method === 'OPTIONS' || req.method === 'PROPFIND' ? 204 : 405).end();
});

app.get('/api/yt-channels', async function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    var channels = await ytChannels.getChannels();
    var list = Object.keys(channels).map(function(id) {
      return Object.assign({ id: id }, channels[id]);
    }).sort(function(a, b) {
      return (b.createdAt || '').localeCompare(a.createdAt || '');
    });
    res.json({ channels: list });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/youtube/live-tv', async function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    var result = await addYouTubeToLiveTv({
      url: (req.body && req.body.url) || req.query.url,
      title: (req.body && req.body.title) || req.query.title,
      logo: (req.body && req.body.logo) || req.query.logo
    });
    var proto = String(req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http'));
    var host = String(req.headers['x-forwarded-host'] || req.headers.host || ('localhost:' + PORT));
    result.proxyUrl = proto + '://' + host + '/proxy/' + result.id;
    result.liveUrl = proto + '://' + host + result.liveUrlPath;
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/yt-channels', async function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  var url = safeTrim((req.body && req.body.url) || req.query.url);
  var title = safeTrim((req.body && req.body.title) || req.query.title);
  if (!url) return res.status(400).json({ error: 'url gerekli' });
  var videoId = ytStream.extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Gecersiz YouTube linki' });
  try {
    var added = await addYouTubeToLiveTv({
      url: url,
      title: title,
      logo: (req.body && req.body.logo) || req.query.logo
    });
    var proto = String(req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http'));
    var host = String(req.headers['x-forwarded-host'] || req.headers.host || ('localhost:' + PORT));
    var proxyUrl = proto + '://' + host + '/proxy/' + added.id;
    res.json(Object.assign({}, added, {
      proxyUrl: proxyUrl,
      liveUrl: proto + '://' + host + added.liveUrlPath,
      videoId: videoId
    }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.options('/api/yt-channels', function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.status(200).end();
});

app.delete('/api/yt-channels/:id', async function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    await ytChannels.deleteChannel(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

app.use(xtreamApp);

if (require.main === module) {
  function startAll() {
    // Ensure the UI bundles exist and are up-to-date when running locally.
    ensureTsxBundles();

    if (process.env.ENABLE_YOUTUBE_PROXY !== '0') {
      startYouTubeProxy();
    }

    var standaloneTvServer = null;
    var standaloneTvServerActive = ENABLE_TV_SERVER;

    if (ENABLE_TV_SERVER && XTREAM_PORT !== PORT) {
      standaloneTvServer = xtreamApp.listen(XTREAM_PORT, function () {
        console.log('[TV Sunucu] http://localhost:' + XTREAM_PORT);
      });

      standaloneTvServer.on('error', function (error) {
        if (error && error.code === 'EADDRINUSE') {
          standaloneTvServerActive = false;
          console.warn('[TV]  port ' + XTREAM_PORT + ' zaten kullanimda. Ayrik TV sunucusu atlandi; endpointler web sunucusu uzerinden calismaya devam edecek.');
          return;
        }
        if (error && error.code === 'EACCES') {
          standaloneTvServerActive = false;
          console.warn('[TV]  port ' + XTREAM_PORT + ' icin yetki yok (EACCES). Ayrik TV sunucusu kapatildi; endpointler web sunucusu uzerinden calismaya devam edecek.');
          return;
        }
        throw error;
      });
    } else if (ENABLE_TV_SERVER && XTREAM_PORT === PORT) {
      standaloneTvServerActive = false;
      console.warn('[TV]  XTREAM_PORT (' + XTREAM_PORT + ') == PORT (' + PORT + '). Ayrik TV sunucusu atlandi; endpointler web sunucusu uzerinden calismaya devam edecek.');
    }

    var webServer = app.listen(PORT, function () {
      console.log('[Build] compat-bypass-active 2026-04-09');
      console.log('[Web] http://localhost:' + PORT);
      console.log('[TV] delivery mode: ' + TV_DELIVERY_MODE);
      if (ENABLE_TV_SERVER) {
        console.log('[TV]  ' + (standaloneTvServerActive ? ('http://localhost:' + XTREAM_PORT) : ('http://localhost:' + PORT + ' (web icinde)')));
      } else {
        console.log('[TV]  disabled');
      }

      if (process.env.ENABLE_YOUTUBE_PROXY !== '0') {
        var proxyPort = Math.max(1, Number(process.env.YOUTUBE_PROXY_PORT || 5000) || 5000);
        console.log('[YouTube Proxy] http://127.0.0.1:' + proxyPort);
      } else {
        console.log('[YouTube Proxy] disabled');
      }

      console.log('[Health] http://127.0.0.1:' + PORT + '/api/health');
    });

    webServer.on('error', function (error) {
      if (error && error.code === 'EADDRINUSE') {
        console.error('[Web] port ' + PORT + ' zaten kullanimda. Calisan baska bir instance olabilir. Once onu kapat veya .env icinde PORT degerini degistir.');
        stopYouTubeProxy();
        if (standaloneTvServer && standaloneTvServer.close) {
          try { standaloneTvServer.close(); } catch (_) {}
        }
        process.exit(1);
        return;
      }
      if (error && error.code === 'EACCES') {
        console.error('[Web] port ' + PORT + ' icin yetki yok (EACCES). Farkli bir PORT sec veya yonetici olarak calistir.');
        stopYouTubeProxy();
        if (standaloneTvServer && standaloneTvServer.close) {
          try { standaloneTvServer.close(); } catch (_) {}
        }
        process.exit(1);
        return;
      }
      throw error;
    });
  }

  // If another instance is already running on the same port, don't crash; just report it.
  isLocalPortListening(PORT, function (inUse) {
    if (!inUse) {
      startAll();
      return;
    }

    probeLocalJsonEndpoint(PORT, '/api/health', 600, function (payload) {
      if (payload && payload.status === 'ok' && Number(payload.webPort) === PORT) {
        console.log('[Web] zaten calisiyor: http://localhost:' + PORT);
        if (payload.tvServerEnabled) {
          console.log('[TV]  ' + (payload.separatePort ? ('http://localhost:' + payload.tvPort) : ('http://localhost:' + payload.webPort + ' (web icinde)')));
        } else {
          console.log('[TV]  disabled');
        }
        if (payload.youtubeProxyEnabled) {
          console.log('[YouTube Proxy] http://127.0.0.1:' + payload.youtubeProxyPort);
        } else {
          console.log('[YouTube Proxy] disabled');
        }
        console.log('[Health] http://127.0.0.1:' + PORT + '/api/health');
        process.exit(0);
        return;
      }

      console.error('[Web] port ' + PORT + ' baska bir uygulama tarafindan kullaniliyor. .env icinde PORT degerini degistir veya o uygulamayi kapat.');
      process.exit(1);
    });
  });
}

module.exports = app;
