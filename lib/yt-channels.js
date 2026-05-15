const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');

// Vercel'de /tmp kullan (yazilabilir, ama gecici)
const DATA_FILE = process.env.YT_CHANNELS_FILE ||
  (process.env.VERCEL ? '/tmp/yt-channels.json' : path.join(DATA_DIR, 'yt-channels.json'));
const BUNDLED_DATA_FILE = path.join(DATA_DIR, 'yt-channels.json');
const STORAGE_KEY = 'yt_channels';
let appStorage = null;

function configureStorage(storage) {
  appStorage = storage || null;
}

function ensureDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readFile() {
  try {
    let filePath = DATA_FILE;
    if (process.env.VERCEL && !fs.existsSync(filePath) && fs.existsSync(BUNDLED_DATA_FILE)) {
      filePath = BUNDLED_DATA_FILE;
    }
    if (!fs.existsSync(filePath)) return {};
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) || {};
  } catch (e) {
    console.error('[yt-channels] Read error:', e.message);
    return {};
  }
}

function writeFile(channels) {
  ensureDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify(channels || {}, null, 2));
}

async function getChannels() {
  if (appStorage && appStorage.isDatabase) {
    try {
      const stored = await appStorage.getAppSetting(STORAGE_KEY);
      if (stored && typeof stored === 'object' && !Array.isArray(stored)) return stored;
    } catch (e) {
      console.warn('[yt-channels] DB read error:', e.message);
    }
  }
  return readFile();
}

async function addChannel(url, videoId, title) {
  const channels = await getChannels();
  const id = 'yt_' + videoId;
  const existing = channels[id] || {};
  channels[id] = {
    url,
    videoId,
    title: title || existing.title || '',
    createdAt: existing.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  if (appStorage && appStorage.isDatabase) {
    try {
      await appStorage.setAppSetting(STORAGE_KEY, channels);
    } catch (e) {
      console.warn('[yt-channels] DB write error:', e.message);
    }
  }
  writeFile(channels);
  return id;
}

async function deleteChannel(id) {
  const channels = await getChannels();
  if (channels[id]) {
    delete channels[id];
    if (appStorage && appStorage.isDatabase) {
      try {
        await appStorage.setAppSetting(STORAGE_KEY, channels);
      } catch (e) {
        console.warn('[yt-channels] DB delete error:', e.message);
      }
    }
    writeFile(channels);
  }
}

module.exports = { configureStorage, getChannels, addChannel, deleteChannel };
