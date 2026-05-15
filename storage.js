var fs = require('fs');
var path = require('path');
var Pool = require('pg').Pool;

function normalizeServerConfig(value, fallbackUser, fallbackPass) {
  var config = value && typeof value === 'object' ? value : {};
  return {
    username: String(config.username || fallbackUser || 'admin').trim() || 'admin',
    password: String(config.password || fallbackPass || 'admin').trim() || 'admin'
  };
}

function extractConnectionHost(connectionString) {
  try {
    var parsed = new URL(String(connectionString || '').trim());
    return parsed.hostname || '';
  } catch (error) {
    return '';
  }
}

function normalizeStorageError(error, connectionString) {
  if (!error) {
    return new Error('Veritabani baglantisi kurulamadi.');
  }

  var message = String(error.message || '');
  var code = String(error.code || '').toUpperCase();
  var host = extractConnectionHost(connectionString) || ((message.match(/ENOTFOUND\s+([^\s]+)/i) || [])[1] || '').trim();

  if (/data transfer quota/i.test(message) || /exceeded the data transfer quota/i.test(message)) {
    return new Error('Veritabani veri transfer kotasi asildi. Gecici olarak yerel dosya depolamasi kullanilacak.');
  }

  if (code === 'ENOTFOUND' || /ENOTFOUND/i.test(message)) {
    return new Error(
      'Veritabani hostu cozulmedi' +
      (host ? ': ' + host : '') +
      '. DATABASE_URL degerini Supabase/Neon baglanti ekranindaki tam postgresql://... adresi ile guncelle.'
    );
  }

  if (code === 'ECONNREFUSED' || /ECONNREFUSED/i.test(message)) {
    return new Error(
      'Veritabani baglantisi reddedildi' +
      (host ? ': ' + host : '') +
      '. Postgres hostu, portu veya SSL ayarini kontrol et.'
    );
  }

  if (/password authentication failed/i.test(message)) {
    return new Error('Veritabani kullanici adi veya sifre hatali. DATABASE_URL degerini Supabase/Neon bilgileriyle guncelle.');
  }

  return error;
}

function validateConnectionString(connectionString) {
  var value = String(connectionString || '').trim();
  if (!value) {
    throw new Error('DATABASE_URL yok. Yerel dosya depolamasi kullanilacak.');
  }

  if (!/^postgres(?:ql)?:\/\//i.test(value)) {
    throw new Error('DATABASE_URL gecersiz. Yerel dosya depolamasi kullanilacak.');
  }

  try {
    var parsed = new URL(value);
    if (!parsed.hostname) {
      throw new Error('DATABASE_URL icinde host eksik.');
    }
  } catch (error) {
    throw new Error('DATABASE_URL gecersiz. Yerel dosya depolamasi kullanilacak.');
  }
}

function safeTrim(value) {
  return String(value == null ? '' : value).trim();
}

function isCuratedPlaylist(playlist) {
  return !!(
    playlist &&
    (
      playlist.type === 'custom' ||
      playlist.type === 'playlist' ||
      (playlist.meta && playlist.meta.playlistBucket === 'curated')
    )
  );
}

function getBucketName(playlist) {
  return isCuratedPlaylist(playlist) ? 'curated_playlists' : 'source_playlists';
}

function attachBucket(payload, bucketName) {
  var bucket = bucketName === 'curated_playlists' ? 'curated' : 'source';
  var playlist = Object.assign({}, payload || {});
  playlist.meta = Object.assign({}, playlist.meta || {}, {
    playlistBucket: bucket
  });
  return playlist;
}

function cloneJson(value) {
  if (value == null) {
    return value;
  }
  return JSON.parse(JSON.stringify(value));
}

function ensureParentDir(filePath) {
  var directory = path.dirname(String(filePath || ''));
  if (directory && !fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

function readJsonFile(filePath, fallbackValue) {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return cloneJson(fallbackValue);
    }

    var raw = fs.readFileSync(filePath, 'utf8');
    if (!String(raw || '').trim()) {
      return cloneJson(fallbackValue);
    }

    return JSON.parse(raw);
  } catch (error) {
    return cloneJson(fallbackValue);
  }
}

function writeJsonFile(filePath, value) {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
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

function toIsoDateOrEmpty(value) {
  var ms = parseDateValueMs(value);
  return ms ? new Date(ms).toISOString() : '';
}

function toIsoDateOrNow(value) {
  return toIsoDateOrEmpty(value) || new Date().toISOString();
}

function createEmptyData() {
  return {
    live: {},
    movies: {},
    series: {}
  };
}

var PLAYLIST_PAYLOAD_COMPACT_VERSION = 1;

function normalizeMediaType(value) {
  var text = safeTrim(value).toLowerCase();
  if (text === 'vod' || text === 'movie') {
    return 'movies';
  }
  if (text === 'tv' || text === 'live') {
    return 'live';
  }
  if (text === 'series' || text === 'movies' || text === 'live') {
    return text;
  }
  return '';
}

function normalizePlaylistData(data) {
  var result = createEmptyData();

  ['live', 'movies', 'series'].forEach(function (kind) {
    var groups = data && data[kind] && typeof data[kind] === 'object' ? data[kind] : {};
    Object.keys(groups).forEach(function (groupName) {
      var items = Array.isArray(groups[groupName]) ? groups[groupName] : [];
      result[kind][groupName] = items.map(function (item) {
        return cloneJson(item || {});
      });
    });
  });

  return result;
}

function countPlaylistItems(data) {
  var total = 0;
  ['live', 'movies', 'series'].forEach(function (kind) {
    Object.keys((data && data[kind]) || {}).forEach(function (groupName) {
      total += (((data && data[kind]) || {})[groupName] || []).length;
    });
  });
  return total;
}

function countPlaylistItemsByKind(data) {
  var result = { live: 0, movies: 0, series: 0, total: 0 };
  ['live', 'movies', 'series'].forEach(function (kind) {
    Object.keys((data && data[kind]) || {}).forEach(function (groupName) {
      var amount = (((data && data[kind]) || {})[groupName] || []).length;
      result[kind] += amount;
      result.total += amount;
    });
  });
  return result;
}

function assignCompactField(target, key, value) {
  if (value == null) {
    return;
  }
  if (typeof value === 'string') {
    var text = safeTrim(value);
    if (!text) {
      return;
    }
    target[key] = text;
    return;
  }
  if (Array.isArray(value)) {
    if (!value.length) {
      return;
    }
    target[key] = cloneJson(value);
    return;
  }
  if (typeof value === 'object') {
    if (!Object.keys(value).length) {
      return;
    }
    target[key] = cloneJson(value);
    return;
  }
  target[key] = value;
}

function compactSourceMeta(value) {
  var meta = value && typeof value === 'object' ? value : {};
  var result = {};

  [
    'url',
    'mac',
    'originalUrl',
    'providerLabel',
    'host',
    'username',
    'password',
    'userAgent',
    'referrer',
    'origin',
    'serialNumber',
    'deviceId1',
    'deviceId2',
    'signature1',
    'signature2',
    'token'
  ].forEach(function (key) {
    assignCompactField(result, key, meta[key]);
  });

  if (meta.accountInfo && typeof meta.accountInfo === 'object' && Object.keys(meta.accountInfo).length) {
    result.accountInfo = cloneJson(meta.accountInfo);
  }
  if (meta.headers && typeof meta.headers === 'object' && Object.keys(meta.headers).length) {
    result.headers = cloneJson(meta.headers);
  }

  return result;
}

function compactMetaEquivalent(left, right) {
  return JSON.stringify(compactSourceMeta(left)) === JSON.stringify(compactSourceMeta(right));
}

function compactPlaylistItem(item, playlistType, playlistMeta, playlistId, playlistName, isCurated) {
  var source = item && typeof item === 'object' ? item : {};
  var result = {};
  var sourceType = safeTrim(source.sourceType || playlistType);
  var sourcePlaylistId = safeTrim(source.sourcePlaylistId || playlistId);
  var sourcePlaylistName = safeTrim(source.sourcePlaylistName || playlistName);
  var compactMeta = compactSourceMeta(source.sourceMeta);

  [
    'id',
    'name',
    'logo',
    'stream_icon',
    'cover',
    'cover_big',
    'movie_image',
    'o_name',
    'old_name',
    'plot',
    'description',
    'overview',
    'comments',
    'actors',
    'cast',
    'director',
    'genre',
    'genres_str',
    'year',
    'releaseDate',
    'releasedate',
    'year_end',
    'screenshot_uri',
    'screenshot_url',
    'screenshots',
    'pic',
    'poster',
    'time',
    'duration',
    'rating_imdb',
    'rating',
    'rate',
    'tmdb_id',
    'tmdb',
    'added',
    'container_extension',
    'series',
    'xmltv_id',
    'tvg_id'
  ].forEach(function (key) {
    assignCompactField(result, key, source[key]);
  });

  var streamUrl = safeTrim(source.sourceCmd || source.cmd || source.direct_source);
  if (streamUrl) {
    result.cmd = streamUrl;
  }

  if (isCurated || sourceType !== safeTrim(playlistType)) {
    assignCompactField(result, 'sourceType', sourceType);
  }
  if (isCurated && sourcePlaylistId && sourcePlaylistId !== safeTrim(playlistId)) {
    assignCompactField(result, 'sourcePlaylistId', sourcePlaylistId);
  }
  if (isCurated && sourcePlaylistName && sourcePlaylistName !== safeTrim(playlistName)) {
    assignCompactField(result, 'sourcePlaylistName', sourcePlaylistName);
  }
  if (Object.keys(compactMeta).length && (isCurated || !compactMetaEquivalent(compactMeta, playlistMeta))) {
    result.sourceMeta = compactMeta;
  }

  return result;
}

function compactPlaylistData(data, playlistType, playlistMeta, playlistId, playlistName, isCurated) {
  var result = createEmptyData();

  ['live', 'movies', 'series'].forEach(function (kind) {
    var groups = data && data[kind] && typeof data[kind] === 'object' ? data[kind] : {};
    Object.keys(groups).forEach(function (groupName) {
      var items = Array.isArray(groups[groupName]) ? groups[groupName] : [];
      result[kind][groupName] = items.map(function (item) {
        return compactPlaylistItem(item, playlistType, playlistMeta, playlistId, playlistName, isCurated);
      });
    });
  });

  return result;
}

function createEmptyCounts() {
  return { live: 0, movies: 0, series: 0, total: 0 };
}

function countSummaryRows(categoryRows, hiddenCategories) {
  var counts = createEmptyCounts();
  var hidden = hiddenCategories && typeof hiddenCategories === 'object' ? hiddenCategories : {};

  (categoryRows || []).forEach(function (row) {
    var kind = normalizeMediaType(row.media_type);
    if (!kind) {
      return;
    }
    var groupName = safeTrim(row.name);
    if (hidden[kind] && hidden[kind][groupName]) {
      return;
    }
    var amount = Math.max(0, Number(row.item_count || 0) || 0);
    counts[kind] += amount;
    counts.total += amount;
  });

  return counts;
}

function normalizePlaylistRecord(playlist) {
  var next = Object.assign({}, playlist || {});
  next.id = safeTrim(next.id);
  next.name = safeTrim(next.name) || 'Playlist';
  next.type = safeTrim(next.type) || 'custom';
  next.data = normalizePlaylistData(next.data);
  next.meta = Object.assign({}, next.meta || {});
  if (next.counts && typeof next.counts === 'object') {
    next.counts = Object.assign(createEmptyCounts(), next.counts);
  }
  if (next.createdAt) {
    next.createdAt = toIsoDateOrEmpty(next.createdAt);
  }
  if (next.updatedAt) {
    next.updatedAt = toIsoDateOrEmpty(next.updatedAt);
  }
  return attachBucket(next, getBucketName(next));
}

function compactPlaylistRecord(playlist) {
  var normalized = normalizePlaylistRecord(playlist);
  var next = Object.assign({}, normalized);
  var meta = Object.assign({}, normalized.meta || {});
  var isCurated = isCuratedPlaylist(normalized);

  meta.payloadCompactVersion = PLAYLIST_PAYLOAD_COMPACT_VERSION;
  next.meta = meta;
  next.data = compactPlaylistData(
    normalized.data,
    normalized.type,
    meta,
    normalized.id,
    normalized.name,
    isCurated
  );
  next.counts = countPlaylistItemsByKind(next.data);
  return next;
}

function normalizePlaylistArray(playlists) {
  return (Array.isArray(playlists) ? playlists : [])
    .map(function (playlist) {
      return normalizePlaylistRecord(playlist);
    })
    .sort(function (left, right) {
      var leftMs = parseDateValueMs(left && left.createdAt);
      var rightMs = parseDateValueMs(right && right.createdAt);
      if (leftMs !== rightMs) {
        return leftMs - rightMs;
      }
      return safeTrim(left && left.id).localeCompare(safeTrim(right && right.id));
    });
}

function createFileStorage(options) {
  var playlistFile = options.playlistFile;
  var settingsFile = options.settingsFile;
  var defaultUser = options.defaultUser;
  var defaultPass = options.defaultPass;
  var readOnlyReason = options.readOnlyReason || '';
  var disableWrites = !!(options.disableWrites || process.env.VERCEL);
  var fileWriteBlockReason = readOnlyReason || (disableWrites
    ? 'Kaydetme kapali: bu ortamda yerel dosya sistemi yazilabilir degil.'
    : '');
  var cachedPlaylists = null;
  var cachedServerConfig = null;

  function readPlaylists() {
    if (cachedPlaylists) {
      return normalizePlaylistArray(cloneJson(cachedPlaylists));
    }

    cachedPlaylists = normalizePlaylistArray(readJsonFile(playlistFile, []));
    return normalizePlaylistArray(cloneJson(cachedPlaylists));
  }

  function writePlaylists(playlists) {
    cachedPlaylists = normalizePlaylistArray(playlists);
    if (!disableWrites) {
      writeJsonFile(playlistFile, cachedPlaylists);
    }
    return normalizePlaylistArray(cloneJson(cachedPlaylists));
  }

  function readServerConfig() {
    if (cachedServerConfig) {
      return normalizeServerConfig(cloneJson(cachedServerConfig), defaultUser, defaultPass);
    }

    cachedServerConfig = normalizeServerConfig(readJsonFile(settingsFile, {}), defaultUser, defaultPass);
    return normalizeServerConfig(cloneJson(cachedServerConfig), defaultUser, defaultPass);
  }

  function writeServerConfig(config) {
    var nextConfig = normalizeServerConfig(config, defaultUser, defaultPass);
    cachedServerConfig = cloneJson(nextConfig);
    if (!disableWrites) {
      writeJsonFile(settingsFile, nextConfig);
    }
    return normalizeServerConfig(cloneJson(cachedServerConfig), defaultUser, defaultPass);
  }

  return {
    isDatabase: false,
    mode: fileWriteBlockReason ? 'readonly-file' : 'file',
    fallbackReason: '',
    cachePlaylists: function (playlists) {
      writePlaylists(playlists || []);
    },
    cacheServerConfig: function (config) {
      writeServerConfig(config || {});
    },
    async getPlaylist(id) {
      return readPlaylists().find(function (playlist) {
        return playlist && playlist.id === id;
      }) || null;
    },
    async listPlaylistSummaries() {
      return readPlaylists().map(function (playlist) {
        var normalized = normalizePlaylistRecord(playlist);
        return normalizePlaylistRecord({
          id: normalized.id,
          name: normalized.name,
          type: normalized.type,
          meta: normalized.meta || {},
          counts: countPlaylistItemsByKind(normalized.data),
          createdAt: normalized.createdAt,
          updatedAt: normalized.updatedAt
        });
      });
    },
    async listPlaylists() {
      return readPlaylists();
    },
    async createPlaylist(playlist) {
      if (fileWriteBlockReason) throw new Error(fileWriteBlockReason);
      var playlists = readPlaylists();
      var nextPlaylist = normalizePlaylistRecord(playlist);
      var existingIndex = playlists.findIndex(function (item) { return item && item.id === nextPlaylist.id; });
      if (existingIndex >= 0) {
        playlists[existingIndex] = nextPlaylist;
      } else {
        playlists.push(nextPlaylist);
      }
      writePlaylists(playlists);
      return nextPlaylist;
    },
    async updatePlaylist(id, patch) {
      if (fileWriteBlockReason) throw new Error(fileWriteBlockReason);
      var playlists = readPlaylists();
      var index = playlists.findIndex(function (item) { return item && item.id === id; });
      if (index < 0) return null;
      var nextPlaylist = normalizePlaylistRecord(Object.assign({}, playlists[index], patch || {}, {
        updatedAt: patch && patch.updatedAt ? patch.updatedAt : new Date().toISOString()
      }));
      playlists[index] = nextPlaylist;
      writePlaylists(playlists);
      return nextPlaylist;
    },
    async deletePlaylist(id) {
      if (fileWriteBlockReason) throw new Error(fileWriteBlockReason);
      var playlists = readPlaylists();
      var nextPlaylists = playlists.filter(function (item) { return !item || item.id !== id; });
      if (nextPlaylists.length === playlists.length) return false;
      writePlaylists(nextPlaylists);
      return true;
    },
    async getServerConfig() {
      return readServerConfig();
    },
    async saveServerConfig(config) {
      if (fileWriteBlockReason) throw new Error(fileWriteBlockReason);
      return writeServerConfig(config);
    },
    async getAppSetting(key) {
      return null;
    },
    async setAppSetting(key, value) {
      // file storage cannot persist arbitrary app settings
    }
  };
}

function createDatabaseStorage(options) {
  var connectionString = options.connectionString;
  var defaultUser = options.defaultUser;
  var defaultPass = options.defaultPass;
  var readOnlyReason = options.readOnlyReason || '';

  validateConnectionString(connectionString);

  var pool = new Pool({
    connectionString: connectionString,
    ssl: /(?:\?|&)sslmode=disable(?:&|$)/i.test(connectionString) || /localhost|127\.0\.0\.1/i.test(connectionString)
      ? false
      : { rejectUnauthorized: false }
  });

  var initPromise = null;

  function query(sql, params) {
    return pool.query(sql, params).catch(function (error) {
      throw normalizeStorageError(error, connectionString);
    });
  }

  async function withTransaction(worker) {
    var client = await pool.connect().catch(function (error) {
      throw normalizeStorageError(error, connectionString);
    });

    try {
      await client.query('begin');
      var result = await worker(client);
      await client.query('commit');
      return result;
    } catch (error) {
      try {
        await client.query('rollback');
      } catch (rollbackError) {
      }
      throw normalizeStorageError(error, connectionString);
    } finally {
      client.release();
    }
  }

  function init() {
    if (!initPromise) {
      initPromise = query(
        [
          'create table if not exists playlists (',
          '  id text primary key,',
          '  title text not null,',
          '  type text not null,',
          '  payload_json jsonb not null default \'{}\'::jsonb,',
          '  filename text,',
          '  import_date timestamptz not null default now(),',
          '  last_usage timestamptz not null default now(),',
          '  count integer not null default 0,',
          '  url text,',
          '  user_agent text,',
          '  referrer text,',
          '  origin text,',
          '  file_path text,',
          '  auto_refresh boolean not null default false,',
          '  update_date bigint,',
          '  update_state integer,',
          '  position integer,',
          '  server_url text,',
          '  username text,',
          '  password text,',
          '  mac_address text,',
          '  portal_url text,',
          '  favorites_json jsonb not null default \'[]\'::jsonb,',
          '  recently_viewed_json jsonb not null default \'[]\'::jsonb,',
          '  is_full_stalker_portal boolean,',
          '  stalker_token text,',
          '  stalker_serial_number text,',
          '  stalker_device_id1 text,',
          '  stalker_device_id2 text,',
          '  stalker_signature1 text,',
          '  stalker_signature2 text,',
          '  stalker_account_info_json jsonb,',
          '  editor_catalog_id text,',
          '  editor_source_kind text,',
          '  editor_sync_state text,',
          '  editor_last_sync_at bigint,',
          '  sync_enabled boolean not null default true,',
          '  sync_interval_minutes integer not null default 60,',
          '  last_synced_at timestamptz,',
          '  next_sync_at timestamptz,',
          '  created_at timestamptz not null default now(),',
          '  updated_at timestamptz not null default now()',
          ');',
          'create table if not exists categories (',
          '  id bigserial primary key,',
          '  playlist_id text not null,',
          '  provider text not null,',
          '  media_type text not null,',
          '  remote_id text not null,',
          '  name text not null,',
          '  raw_json jsonb,',
          '  item_count integer not null default 0,',
          '  created_at timestamptz not null default now(),',
          '  updated_at timestamptz not null default now(),',
          '  unique (playlist_id, provider, media_type, remote_id)',
          ');',
          'create table if not exists channels (',
          '  id bigserial primary key,',
          '  playlist_id text not null,',
          '  provider text not null,',
          '  media_type text not null,',
          '  remote_id text not null,',
          '  category_remote_id text,',
          '  title text not null,',
          '  stream_url text,',
          '  logo_url text,',
          '  tvg_id text,',
          '  raw_json jsonb not null default \'{}\'::jsonb,',
          '  enabled boolean not null default true,',
          '  hidden boolean not null default false,',
          '  sort_order integer not null default 0,',
          '  sync_status text not null default \'synced\',',
          '  last_synced_at timestamptz,',
          '  created_at timestamptz not null default now(),',
          '  updated_at timestamptz not null default now(),',
          '  unique (playlist_id, provider, media_type, remote_id)',
          ');',
          'create table if not exists app_settings (',
          '  key text primary key,',
          '  value jsonb not null,',
          '  updated_at timestamptz not null default now()',
          ');'
        ].join('\n')
      );
    }

    return initPromise;
  }

  function buildDataFromRows(categoryRows, channelRows) {
    var data = createEmptyData();
    var categoryNames = {};

    (categoryRows || []).forEach(function (row) {
      var mediaType = normalizeMediaType(row.media_type);
      if (!mediaType) return;
      var remoteId = safeTrim(row.remote_id);
      var categoryName = safeTrim(row.name) || 'Genel';
      categoryNames[mediaType + '::' + remoteId] = categoryName;
      if (!data[mediaType][categoryName]) {
        data[mediaType][categoryName] = [];
      }
    });

    (channelRows || []).slice().sort(function (left, right) {
      var leftMedia = normalizeMediaType(left.media_type);
      var rightMedia = normalizeMediaType(right.media_type);
      if (leftMedia !== rightMedia) return leftMedia.localeCompare(rightMedia);
      var leftCategory = safeTrim(left.category_remote_id);
      var rightCategory = safeTrim(right.category_remote_id);
      if (leftCategory !== rightCategory) return leftCategory.localeCompare(rightCategory);
      var leftOrder = Number(left.sort_order || 0);
      var rightOrder = Number(right.sort_order || 0);
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return Number(left.id || 0) - Number(right.id || 0);
    }).forEach(function (row) {
      var mediaType = normalizeMediaType(row.media_type);
      if (!mediaType) return;
      var raw = row.raw_json && typeof row.raw_json === 'object' ? cloneJson(row.raw_json) : {};
      var categoryName = categoryNames[mediaType + '::' + safeTrim(row.category_remote_id)] || safeTrim(raw.groupName) || 'Genel';
      if (!data[mediaType][categoryName]) {
        data[mediaType][categoryName] = [];
      }

      var item = Object.assign({}, raw || {});
      item.id = safeTrim(item.id || raw.remote_id || row.remote_id) || safeTrim(row.remote_id);
      item.name = safeTrim(item.name || row.title) || 'Isimsiz';
      item.logo = safeTrim(item.logo || row.logo_url);
      var streamUrl = safeTrim(item.sourceCmd || item.cmd || item.direct_source || row.stream_url);
      if (streamUrl) {
        item.cmd = item.cmd || streamUrl;
        item.sourceCmd = item.sourceCmd || streamUrl;
      }
      item.sourceType = safeTrim(item.sourceType || row.provider);
      if (item.sourceMeta == null && raw.sourceMeta && typeof raw.sourceMeta === 'object') {
        item.sourceMeta = cloneJson(raw.sourceMeta);
      }
      data[mediaType][categoryName].push(item);
    });

    return data;
  }

  function buildPlaylistMeta(row, payload, playlistType) {
    var meta = Object.assign({}, payload && payload.meta && typeof payload.meta === 'object' ? payload.meta : {});

    if (!meta.syncIntervalMs && row.sync_interval_minutes != null) {
      meta.syncIntervalMs = Math.max(0, Number(row.sync_interval_minutes) || 0) * 60 * 1000;
    }
    if (!meta.lastSyncedAt && row.last_synced_at) {
      meta.lastSyncedAt = row.last_synced_at;
    }
    if (!meta.lastSyncAttemptAt && (row.last_synced_at || row.updated_at)) {
      meta.lastSyncAttemptAt = row.last_synced_at || row.updated_at;
    }
    if (!meta.playlistBucket) {
      meta.playlistBucket = getBucketName({ type: playlistType, meta: meta }) === 'curated_playlists' ? 'curated' : 'source';
    }

    if (playlistType === 'stalker') {
      meta.url = safeTrim(meta.url || row.portal_url || (payload && payload.portalUrl));
      meta.mac = safeTrim(meta.mac || row.mac_address || (payload && payload.macAddress));
      meta.serialNumber = safeTrim(meta.serialNumber || row.stalker_serial_number || (payload && payload.serialNumber));
      meta.deviceId1 = safeTrim(meta.deviceId1 || row.stalker_device_id1 || (payload && payload.deviceId1));
      meta.deviceId2 = safeTrim(meta.deviceId2 || row.stalker_device_id2 || (payload && payload.deviceId2));
      meta.signature1 = safeTrim(meta.signature1 || row.stalker_signature1 || (payload && payload.signature1));
      meta.signature2 = safeTrim(meta.signature2 || row.stalker_signature2 || (payload && payload.signature2));
      if (!meta.accountInfo && row.stalker_account_info_json && typeof row.stalker_account_info_json === 'object') {
        meta.accountInfo = cloneJson(row.stalker_account_info_json);
      }
    } else if (playlistType === 'xtream') {
      meta.host = safeTrim(meta.host || row.server_url || row.url || (payload && payload.host));
      meta.username = safeTrim(meta.username || row.username || (payload && payload.username));
      meta.password = safeTrim(meta.password || row.password || (payload && payload.password));
    } else if (playlistType === 'm3u') {
      meta.url = safeTrim(meta.url || row.url || (payload && payload.url));
      meta.userAgent = safeTrim(meta.userAgent || row.user_agent || (payload && payload.userAgent));
      meta.referrer = safeTrim(meta.referrer || row.referrer || (payload && payload.referrer));
      meta.origin = safeTrim(meta.origin || row.origin || (payload && payload.origin));
    } else if (playlistType === 'external') {
      meta.sourceUrl = safeTrim(meta.sourceUrl || row.url || (payload && payload.sourceUrl));
    }

    return meta;
  }

  function getPayloadData(payload) {
    return payload && payload.data && typeof payload.data === 'object'
      ? normalizePlaylistData(payload.data)
      : createEmptyData();
  }

  function rowHasEmbeddedPlaylistData(row) {
    var payload = row && row.payload_json && typeof row.payload_json === 'object' ? row.payload_json : null;
    return countPlaylistItems(getPayloadData(payload)) > 0;
  }

  function buildPlaylistRecord(row, categoryRows, channelRows) {
    var payload = row && row.payload_json && typeof row.payload_json === 'object' ? cloneJson(row.payload_json) : {};
    var playlistType = safeTrim((payload && payload.type) || row.type) || 'custom';
    var dataFromRows = buildDataFromRows(categoryRows, channelRows);
    var payloadData = getPayloadData(payload);
    var finalData = countPlaylistItems(payloadData) ? payloadData : dataFromRows;

    return compactPlaylistRecord({
      id: safeTrim((payload && (payload.id || payload._id)) || row.id),
      name: safeTrim((payload && (payload.name || payload.title)) || row.title) || 'Playlist',
      type: playlistType,
      data: finalData,
      meta: buildPlaylistMeta(row, payload, playlistType),
      createdAt: (payload && payload.createdAt) || row.created_at || row.import_date,
      updatedAt: (payload && payload.updatedAt) || row.updated_at || row.last_usage
    });
  }

  function buildPlaylistSummaryRecord(row, categoryRows) {
    var payloadMeta = row && row.payload_meta && typeof row.payload_meta === 'object'
      ? cloneJson(row.payload_meta)
      : {};
    var payload = row && row.payload_json && typeof row.payload_json === 'object'
      ? cloneJson(row.payload_json)
      : { meta: payloadMeta };
    var playlistType = safeTrim((payload && payload.type) || row.type) || 'custom';
    var meta = buildPlaylistMeta(row, payload, playlistType);
    var counts = countSummaryRows(categoryRows, meta.hiddenCategories);

    if (!counts.total && row && row.count != null) {
      counts.total = Math.max(0, Number(row.count || 0) || 0);
    }

    return normalizePlaylistRecord({
      id: safeTrim((payload && (payload.id || payload._id)) || row.id),
      name: safeTrim((payload && (payload.name || payload.title)) || row.title) || 'Playlist',
      type: playlistType,
      meta: meta,
      counts: counts,
      createdAt: (payload && payload.createdAt) || row.created_at || row.import_date,
      updatedAt: (payload && payload.updatedAt) || row.updated_at || row.last_usage
    });
  }

  function buildPlaylistRows(playlist) {
    var normalized = compactPlaylistRecord(playlist);
    var meta = normalized.meta || {};
    var createdAt = toIsoDateOrNow(normalized.createdAt);
    var updatedAt = toIsoDateOrNow(normalized.updatedAt || createdAt);
    var lastSyncedAt = toIsoDateOrEmpty(meta.lastSyncedAt);
    var lastSyncAttemptAt = toIsoDateOrEmpty(meta.lastSyncAttemptAt || meta.lastSyncedAt);
    var syncIntervalMs = Math.max(0, Number(meta.syncIntervalMs) || 0);
    var syncIntervalMinutes = Math.max(0, Math.round(syncIntervalMs / 60000));
    var payload = cloneJson(normalized);

    payload._id = payload._id || normalized.id;
    payload.title = payload.title || normalized.name;

    var playlistRow = {
      id: normalized.id,
      title: normalized.name,
      type: normalized.type,
      payload_json: JSON.stringify(payload),
      filename: null,
      import_date: createdAt,
      last_usage: updatedAt,
      count: countPlaylistItems(normalized.data),
      url: null,
      user_agent: null,
      referrer: null,
      origin: null,
      file_path: null,
      auto_refresh: syncIntervalMinutes > 0,
      update_date: parseDateValueMs(updatedAt) || null,
      update_state: null,
      position: null,
      server_url: null,
      username: null,
      password: null,
      mac_address: null,
      portal_url: null,
      favorites_json: JSON.stringify([]),
      recently_viewed_json: JSON.stringify([]),
      is_full_stalker_portal: null,
      stalker_token: null,
      stalker_serial_number: null,
      stalker_device_id1: null,
      stalker_device_id2: null,
      stalker_signature1: null,
      stalker_signature2: null,
      stalker_account_info_json: meta.accountInfo && typeof meta.accountInfo === 'object' ? JSON.stringify(meta.accountInfo) : null,
      editor_catalog_id: null,
      editor_source_kind: null,
      editor_sync_state: meta.lastSyncError ? 'error' : 'ready',
      editor_last_sync_at: parseDateValueMs(lastSyncAttemptAt) || null,
      sync_enabled: syncIntervalMinutes > 0,
      sync_interval_minutes: syncIntervalMinutes,
      last_synced_at: lastSyncedAt || null,
      next_sync_at: syncIntervalMinutes > 0 && lastSyncAttemptAt
        ? new Date(parseDateValueMs(lastSyncAttemptAt) + (syncIntervalMinutes * 60 * 1000)).toISOString()
        : null,
      created_at: createdAt,
      updated_at: updatedAt
    };

    if (normalized.type === 'stalker') {
      playlistRow.portal_url = safeTrim(meta.url);
      playlistRow.mac_address = safeTrim(meta.mac);
      playlistRow.is_full_stalker_portal = meta.isFullStalkerPortal == null ? null : !!meta.isFullStalkerPortal;
      playlistRow.stalker_token = safeTrim(meta.token);
      playlistRow.stalker_serial_number = safeTrim(meta.serialNumber);
      playlistRow.stalker_device_id1 = safeTrim(meta.deviceId1);
      playlistRow.stalker_device_id2 = safeTrim(meta.deviceId2);
      playlistRow.stalker_signature1 = safeTrim(meta.signature1);
      playlistRow.stalker_signature2 = safeTrim(meta.signature2);
    } else if (normalized.type === 'xtream') {
      playlistRow.server_url = safeTrim(meta.host);
      playlistRow.username = safeTrim(meta.username);
      playlistRow.password = safeTrim(meta.password);
    } else if (normalized.type === 'm3u') {
      playlistRow.url = safeTrim(meta.url);
      playlistRow.user_agent = safeTrim(meta.userAgent);
      playlistRow.referrer = safeTrim(meta.referrer);
      playlistRow.origin = safeTrim(meta.origin);
    } else if (normalized.type === 'external') {
      playlistRow.url = safeTrim(meta.sourceUrl || meta.url);
    }

    var categories = [];
    var channels = [];
    var categoryProvider = safeTrim(normalized.type) || 'custom';

    ['live', 'movies', 'series'].forEach(function (kind) {
      var groups = normalized.data[kind] || {};
      Object.keys(groups).forEach(function (groupName) {
        var items = Array.isArray(groups[groupName]) ? groups[groupName] : [];
        var categoryRemoteId = kind + '::' + groupName;

        categories.push({
          playlist_id: normalized.id,
          provider: categoryProvider,
          media_type: kind,
          remote_id: categoryRemoteId,
          name: groupName,
          raw_json: JSON.stringify({ name: groupName, itemCount: items.length }),
          item_count: items.length,
          created_at: createdAt,
          updated_at: updatedAt
        });

        items.forEach(function (item, index) {
          var nextItem = item && typeof item === 'object' ? cloneJson(item) : {};
          var provider = safeTrim(nextItem.sourceType || normalized.type) || 'custom';
          var itemId = safeTrim(nextItem.id) || ('item-' + index);
          var remoteId = kind + '::' + groupName + '::' + provider + '::' + index + '::' + itemId;
          var streamUrl = safeTrim(nextItem.sourceCmd || nextItem.cmd || nextItem.direct_source);
          var logoUrl = safeTrim(nextItem.logo || (nextItem.raw_json && nextItem.raw_json.logo));
          var tvgId = safeTrim(nextItem.tvg_id || nextItem.tvgId || (nextItem.raw_json && (nextItem.raw_json.xmltv_id || nextItem.raw_json.tvg_id)));

          channels.push({
            playlist_id: normalized.id,
            provider: provider,
            media_type: kind,
            remote_id: remoteId,
            category_remote_id: categoryRemoteId,
            title: safeTrim(nextItem.name) || 'Isimsiz',
            stream_url: streamUrl || null,
            logo_url: logoUrl || null,
            tvg_id: tvgId || null,
            raw_json: JSON.stringify(nextItem || {}),
            enabled: true,
            hidden: false,
            sort_order: index,
            sync_status: meta.lastSyncError ? 'error' : 'synced',
            last_synced_at: lastSyncedAt || null,
            created_at: createdAt,
            updated_at: updatedAt
          });
        });
      });
    });

    return { playlist: normalized, playlistRow: playlistRow, categories: categories, channels: channels };
  }

  async function fetchRowsByPlaylistIds(ids) {
    if (!ids.length) {
      return { categories: [], channels: [] };
    }

    var categoriesResult = await query(
      'select * from categories where playlist_id = any($1::text[]) order by media_type asc, name asc, id asc',
      [ids]
    );
    var channelsResult = await query(
      'select * from channels where playlist_id = any($1::text[]) order by media_type asc, category_remote_id asc, sort_order asc, id asc',
      [ids]
    );

    return {
      categories: categoriesResult.rows,
      channels: channelsResult.rows
    };
  }

  async function fetchCategorySummaryRows(ids) {
    if (!ids.length) {
      return [];
    }

    var categoriesResult = await query(
      'select playlist_id, media_type, name, item_count from categories where playlist_id = any($1::text[]) order by media_type asc, name asc',
      [ids]
    );

    return categoriesResult.rows;
  }

  async function findPlaylist(id) {
    await init();
    var playlistResult = await query('select * from playlists where id = $1', [id]);
    if (!playlistResult.rows.length) {
      return null;
    }

    var row = playlistResult.rows[0];
    var rows = rowHasEmbeddedPlaylistData(row)
      ? { categories: [], channels: [] }
      : await fetchRowsByPlaylistIds([id]);
    return buildPlaylistRecord(row, rows.categories, rows.channels);
  }

  async function insertRowsInBatches(client, tableName, columns, rows, batchSize) {
    if (!rows.length) {
      return;
    }

    var size = Math.max(1, Number(batchSize) || 250);
    for (var start = 0; start < rows.length; start += size) {
      var batch = rows.slice(start, start + size);
      var values = [];
      var placeholders = [];

      batch.forEach(function (row, rowIndex) {
        var rowPlaceholders = [];
        columns.forEach(function (columnName, columnIndex) {
          values.push(row[columnName]);
          rowPlaceholders.push('$' + String((rowIndex * columns.length) + columnIndex + 1));
        });
        placeholders.push('(' + rowPlaceholders.join(', ') + ')');
      });

      await client.query(
        'insert into ' + tableName + ' (' + columns.join(', ') + ') values ' + placeholders.join(', '),
        values
      );
    }
  }

  async function savePlaylist(playlist) {
    if (readOnlyReason) {
      throw new Error(readOnlyReason);
    }

    await init();
    var bundle = buildPlaylistRows(playlist);

    return withTransaction(async function (client) {
      await client.query(
        [
          'insert into playlists (',
          'id, title, type, payload_json, filename, import_date, last_usage, count, url, user_agent, referrer, origin, file_path, auto_refresh, update_date, update_state, position, server_url, username, password, mac_address, portal_url, favorites_json, recently_viewed_json, is_full_stalker_portal, stalker_token, stalker_serial_number, stalker_device_id1, stalker_device_id2, stalker_signature1, stalker_signature2, stalker_account_info_json, editor_catalog_id, editor_source_kind, editor_sync_state, editor_last_sync_at, sync_enabled, sync_interval_minutes, last_synced_at, next_sync_at, created_at, updated_at',
          ') values (',
          '$1, $2, $3, $4::jsonb, $5, $6::timestamptz, $7::timestamptz, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23::jsonb, $24::jsonb, $25, $26, $27, $28, $29, $30, $31, $32::jsonb, $33, $34, $35, $36, $37, $38, $39::timestamptz, $40::timestamptz, $41::timestamptz, $42::timestamptz',
          ') on conflict (id) do update set',
          'title = excluded.title,',
          'type = excluded.type,',
          'payload_json = excluded.payload_json,',
          'filename = excluded.filename,',
          'import_date = excluded.import_date,',
          'last_usage = excluded.last_usage,',
          'count = excluded.count,',
          'url = excluded.url,',
          'user_agent = excluded.user_agent,',
          'referrer = excluded.referrer,',
          'origin = excluded.origin,',
          'file_path = excluded.file_path,',
          'auto_refresh = excluded.auto_refresh,',
          'update_date = excluded.update_date,',
          'update_state = excluded.update_state,',
          'position = excluded.position,',
          'server_url = excluded.server_url,',
          'username = excluded.username,',
          'password = excluded.password,',
          'mac_address = excluded.mac_address,',
          'portal_url = excluded.portal_url,',
          'favorites_json = excluded.favorites_json,',
          'recently_viewed_json = excluded.recently_viewed_json,',
          'is_full_stalker_portal = excluded.is_full_stalker_portal,',
          'stalker_token = excluded.stalker_token,',
          'stalker_serial_number = excluded.stalker_serial_number,',
          'stalker_device_id1 = excluded.stalker_device_id1,',
          'stalker_device_id2 = excluded.stalker_device_id2,',
          'stalker_signature1 = excluded.stalker_signature1,',
          'stalker_signature2 = excluded.stalker_signature2,',
          'stalker_account_info_json = excluded.stalker_account_info_json,',
          'editor_catalog_id = excluded.editor_catalog_id,',
          'editor_source_kind = excluded.editor_source_kind,',
          'editor_sync_state = excluded.editor_sync_state,',
          'editor_last_sync_at = excluded.editor_last_sync_at,',
          'sync_enabled = excluded.sync_enabled,',
          'sync_interval_minutes = excluded.sync_interval_minutes,',
          'last_synced_at = excluded.last_synced_at,',
          'next_sync_at = excluded.next_sync_at,',
          'created_at = excluded.created_at,',
          'updated_at = excluded.updated_at'
        ].join(' '),
        [
          bundle.playlistRow.id,
          bundle.playlistRow.title,
          bundle.playlistRow.type,
          bundle.playlistRow.payload_json,
          bundle.playlistRow.filename,
          bundle.playlistRow.import_date,
          bundle.playlistRow.last_usage,
          bundle.playlistRow.count,
          bundle.playlistRow.url,
          bundle.playlistRow.user_agent,
          bundle.playlistRow.referrer,
          bundle.playlistRow.origin,
          bundle.playlistRow.file_path,
          bundle.playlistRow.auto_refresh,
          bundle.playlistRow.update_date,
          bundle.playlistRow.update_state,
          bundle.playlistRow.position,
          bundle.playlistRow.server_url,
          bundle.playlistRow.username,
          bundle.playlistRow.password,
          bundle.playlistRow.mac_address,
          bundle.playlistRow.portal_url,
          bundle.playlistRow.favorites_json,
          bundle.playlistRow.recently_viewed_json,
          bundle.playlistRow.is_full_stalker_portal,
          bundle.playlistRow.stalker_token,
          bundle.playlistRow.stalker_serial_number,
          bundle.playlistRow.stalker_device_id1,
          bundle.playlistRow.stalker_device_id2,
          bundle.playlistRow.stalker_signature1,
          bundle.playlistRow.stalker_signature2,
          bundle.playlistRow.stalker_account_info_json,
          bundle.playlistRow.editor_catalog_id,
          bundle.playlistRow.editor_source_kind,
          bundle.playlistRow.editor_sync_state,
          bundle.playlistRow.editor_last_sync_at,
          bundle.playlistRow.sync_enabled,
          bundle.playlistRow.sync_interval_minutes,
          bundle.playlistRow.last_synced_at,
          bundle.playlistRow.next_sync_at,
          bundle.playlistRow.created_at,
          bundle.playlistRow.updated_at
        ]
      );

      await client.query('delete from channels where playlist_id = $1', [bundle.playlist.id]);
      await client.query('delete from categories where playlist_id = $1', [bundle.playlist.id]);

      await insertRowsInBatches(
        client,
        'categories',
        ['playlist_id', 'provider', 'media_type', 'remote_id', 'name', 'raw_json', 'item_count', 'created_at', 'updated_at'],
        bundle.categories,
        250
      );
      await insertRowsInBatches(
        client,
        'channels',
        ['playlist_id', 'provider', 'media_type', 'remote_id', 'category_remote_id', 'title', 'stream_url', 'logo_url', 'tvg_id', 'raw_json', 'enabled', 'hidden', 'sort_order', 'sync_status', 'last_synced_at', 'created_at', 'updated_at'],
        bundle.channels,
        200
      );

      return bundle.playlist;
    });
  }

  return {
    isDatabase: true,
    mode: 'database',
    async getPlaylist(id) {
      return findPlaylist(id);
    },
    async listPlaylistSummaries() {
      await init();
      var playlistRows = await query(
        [
          'select',
          'id, title, type, count, url, user_agent, referrer, origin, server_url, username, password, mac_address, portal_url,',
          'stalker_serial_number, stalker_device_id1, stalker_device_id2, stalker_signature1, stalker_signature2, stalker_account_info_json,',
          'sync_interval_minutes, last_synced_at, created_at, updated_at, import_date, last_usage,',
          'payload_json -> \'meta\' as payload_meta',
          'from playlists',
          'order by created_at asc, import_date asc, id asc'
        ].join(' ')
      );
      var ids = playlistRows.rows.map(function (row) { return row.id; });
      var categoryRows = await fetchCategorySummaryRows(ids);
      var categoriesByPlaylist = {};

      categoryRows.forEach(function (row) {
        if (!categoriesByPlaylist[row.playlist_id]) categoriesByPlaylist[row.playlist_id] = [];
        categoriesByPlaylist[row.playlist_id].push(row);
      });

      return playlistRows.rows.map(function (row) {
        return buildPlaylistSummaryRecord(row, categoriesByPlaylist[row.id] || []);
      });
    },
    async listPlaylists() {
      await init();
      var playlistRows = await query('select * from playlists order by created_at asc, import_date asc, id asc');
      var idsNeedingExpandedRows = playlistRows.rows
        .filter(function (row) { return !rowHasEmbeddedPlaylistData(row); })
        .map(function (row) { return row.id; });
      var relatedRows = await fetchRowsByPlaylistIds(idsNeedingExpandedRows);
      var categoriesByPlaylist = {};
      var channelsByPlaylist = {};

      relatedRows.categories.forEach(function (row) {
        if (!categoriesByPlaylist[row.playlist_id]) categoriesByPlaylist[row.playlist_id] = [];
        categoriesByPlaylist[row.playlist_id].push(row);
      });
      relatedRows.channels.forEach(function (row) {
        if (!channelsByPlaylist[row.playlist_id]) channelsByPlaylist[row.playlist_id] = [];
        channelsByPlaylist[row.playlist_id].push(row);
      });

      return playlistRows.rows.map(function (row) {
        return buildPlaylistRecord(row, categoriesByPlaylist[row.id] || [], channelsByPlaylist[row.id] || []);
      });
    },
    async createPlaylist(playlist) {
      return savePlaylist(playlist);
    },
    async updatePlaylist(id, patch) {
      if (readOnlyReason) throw new Error(readOnlyReason);
      var existing = await findPlaylist(id);
      if (!existing) return null;
      var nextPlaylist = normalizePlaylistRecord(Object.assign({}, existing, patch || {}, {
        updatedAt: patch && patch.updatedAt ? patch.updatedAt : new Date().toISOString()
      }));
      return savePlaylist(nextPlaylist);
    },
    async deletePlaylist(id) {
      if (readOnlyReason) throw new Error(readOnlyReason);
      await init();
      return withTransaction(async function (client) {
        await client.query('delete from channels where playlist_id = $1', [id]);
        await client.query('delete from categories where playlist_id = $1', [id]);
        var result = await client.query('delete from playlists where id = $1', [id]);
        return result.rowCount > 0;
      });
    },
    async getServerConfig() {
      await init();
      var result = await query('select value from app_settings where key = $1', ['server_config']);
      if (!result.rows.length) {
        return normalizeServerConfig({}, defaultUser, defaultPass);
      }
      return normalizeServerConfig(result.rows[0].value || {}, defaultUser, defaultPass);
    },
    async saveServerConfig(config) {
      if (readOnlyReason) throw new Error(readOnlyReason);
      await init();
      var nextConfig = normalizeServerConfig(config, defaultUser, defaultPass);
      await query(
        [
          'insert into app_settings (key, value, updated_at)',
          'values ($1, $2::jsonb, now())',
          'on conflict (key) do update set value = excluded.value, updated_at = now()'
        ].join(' '),
        ['server_config', JSON.stringify(nextConfig)]
      );
      return nextConfig;
    },
    async getAppSetting(key) {
      await init();
      var result = await query('select value from app_settings where key = $1', [key]);
      if (!result.rows.length) return null;
      return result.rows[0].value;
    },
    async setAppSetting(key, value) {
      if (readOnlyReason) throw new Error(readOnlyReason);
      await init();
      await query(
        [
          'insert into app_settings (key, value, updated_at)',
          'values ($1, $2::jsonb, now())',
          'on conflict (key) do update set value = excluded.value, updated_at = now()'
        ].join(' '),
        [key, JSON.stringify(value)]
      );
    }
  };
}

function createHybridStorage(databaseStorage, fileStorage) {
  var fallbackReason = '';
  var usingFileFallback = false;

  function activateFallback(error) {
    if (usingFileFallback) {
      return;
    }
    usingFileFallback = true;
    fallbackReason = String((error && error.message) || 'Veritabani kullanilamadi.');
    console.log('[Storage] File fallback active:', fallbackReason);
  }

  async function call(methodName, args) {
    if (usingFileFallback) {
      return fileStorage[methodName].apply(fileStorage, args);
    }

    try {
      return await databaseStorage[methodName].apply(databaseStorage, args);
    } catch (error) {
      activateFallback(error);
      return fileStorage[methodName].apply(fileStorage, args);
    }
  }

  return {
    get isDatabase() {
      return !usingFileFallback;
    },
    get mode() {
      if (!usingFileFallback) return 'database';
      return fileStorage.mode === 'readonly-file' ? 'readonly-file' : 'file-fallback';
    },
    get fallbackReason() {
      return fallbackReason;
    },
    async getPlaylist(id) {
      return call('getPlaylist', arguments);
    },
    async listPlaylistSummaries() {
      return call('listPlaylistSummaries', arguments);
    },
    async listPlaylists() {
      var playlists = await call('listPlaylists', arguments);
      if (!usingFileFallback) {
        fileStorage.cachePlaylists(playlists);
      }
      return playlists;
    },
    async createPlaylist(playlist) {
      return call('createPlaylist', arguments);
    },
    async updatePlaylist(id, patch) {
      return call('updatePlaylist', arguments);
    },
    async deletePlaylist(id) {
      return call('deletePlaylist', arguments);
    },
    async getServerConfig() {
      var config = await call('getServerConfig', arguments);
      if (!usingFileFallback) {
        fileStorage.cacheServerConfig(config);
      }
      return config;
    },
    async saveServerConfig(config) {
      return call('saveServerConfig', arguments);
    },
    async getAppSetting(key) {
      return call('getAppSetting', arguments);
    },
    async setAppSetting(key, value) {
      return call('setAppSetting', arguments);
    }
  };
}

function createStorage(options) {
  var fileStorage = createFileStorage(options || {});
  var connectionString = safeTrim(options && options.connectionString);
  var forceFileStorage = !!(options && options.forceFileStorage);

  if (forceFileStorage) {
    return fileStorage;
  }

  try {
    var databaseStorage = createDatabaseStorage(options || {});
    return createHybridStorage(databaseStorage, fileStorage);
  } catch (error) {
    fileStorage.fallbackReason = String((error && error.message) || 'Veritabani kullanilamadi.');
    if (connectionString) {
      console.log('[Storage] File mode:', fileStorage.fallbackReason);
    }
    return fileStorage;
  }
}

module.exports = {
  createStorage: createStorage
};
