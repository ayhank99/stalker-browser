require('../env-loader');
var path = require('path');
var createStorage = require('../storage').createStorage;

var DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
var DATA_FILE = process.env.DATA_FILE
  ? path.resolve(process.env.DATA_FILE)
  : path.join(DATA_DIR, 'playlists.json');
var SETTINGS_FILE = process.env.SETTINGS_FILE
  ? path.resolve(process.env.SETTINGS_FILE)
  : path.join(DATA_DIR, 'server-config.json');
var DEFAULT_XTREAM_USER = String(process.env.XTREAM_USER || 'admin').trim() || 'admin';
var DEFAULT_XTREAM_PASS = String(process.env.XTREAM_PASS || 'admin').trim() || 'admin';
var FORCE_FILE_STORAGE = process.env.STORAGE_MODE === 'file' || process.env.FORCE_FILE_STORAGE === '1';
var COMPACT_VERSION = 1;

async function main() {
  var storage = createStorage({
    playlistFile: DATA_FILE,
    settingsFile: SETTINGS_FILE,
    defaultUser: DEFAULT_XTREAM_USER,
    defaultPass: DEFAULT_XTREAM_PASS,
    connectionString: process.env.DATABASE_URL,
    forceFileStorage: FORCE_FILE_STORAGE
  });

  if (!storage.isDatabase) {
    throw new Error('Veritabani modu aktif degil. DATABASE_URL ve STORAGE_MODE ayarlarini kontrol et.');
  }

  var summaries = await storage.listPlaylistSummaries();
  var targets = summaries.filter(function (playlist) {
    var version = Number(playlist && playlist.meta && playlist.meta.payloadCompactVersion) || 0;
    return version < COMPACT_VERSION;
  });

  console.log('[Compact] Playlists:', summaries.length);
  console.log('[Compact] Targets:', targets.length);

  for (var index = 0; index < targets.length; index += 1) {
    var summary = targets[index];
    console.log('[Compact] Processing ' + (index + 1) + '/' + targets.length + ': ' + summary.name + ' (' + summary.id + ')');
    var full = await storage.getPlaylist(summary.id);
    if (!full) {
      console.log('[Compact] Skipped missing playlist:', summary.id);
      continue;
    }
    await storage.updatePlaylist(full.id, {
      name: full.name,
      data: full.data,
      meta: full.meta || {},
      createdAt: full.createdAt,
      updatedAt: full.updatedAt
    });
  }

  console.log('[Compact] Done');
}

main().catch(function (error) {
  console.error('[Compact] Failed:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
