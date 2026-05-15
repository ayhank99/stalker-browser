require('../env-loader');

var fs = require('fs');
var path = require('path');
var createStorage = require('../storage').createStorage;

var rootDir = path.resolve(__dirname, '..');
var dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(rootDir, 'data');
var playlistFile = process.env.DATA_FILE
  ? path.resolve(process.env.DATA_FILE)
  : path.join(dataDir, 'playlists.json');
var settingsFile = process.env.SETTINGS_FILE
  ? path.resolve(process.env.SETTINGS_FILE)
  : path.join(dataDir, 'server-config.json');
var databaseUrl = String(process.env.DATABASE_URL || '').trim();

function readJson(filePath, fallbackValue) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return fallbackValue;
  }
}

async function main() {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL gerekli');
  }

  var playlists = readJson(playlistFile, []);
  var settings = readJson(settingsFile, {});
  var storage = createStorage({
    connectionString: databaseUrl,
    playlistFile: playlistFile,
    settingsFile: settingsFile,
    defaultUser: String(process.env.XTREAM_USER || 'admin').trim() || 'admin',
    defaultPass: String(process.env.XTREAM_PASS || 'admin').trim() || 'admin'
  });

  for (var index = 0; index < playlists.length; index += 1) {
    var playlist = playlists[index];
    var updated = await storage.updatePlaylist(playlist.id, playlist);
    if (!updated) {
      await storage.createPlaylist(playlist);
    }
  }

  await storage.saveServerConfig(settings || {});
  console.log('Migrated playlists:', playlists.length);
}

main().catch(function(error) {
  console.error(error.message || error);
  process.exit(1);
});
