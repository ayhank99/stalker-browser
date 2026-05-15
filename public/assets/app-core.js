export const API_BASE = window.location.origin

let playerPopup = null
let autoSyncTimer = null
let autoSyncOptions = null
const autoSyncRunningIds = new Set()
const STALKER_ACCOUNT_REQUESTS = [
  { type: 'account_info', action: 'get_main_info', JsHttpRequest: '1-xml' },
  { type: 'stb', action: 'get_profile', JsHttpRequest: '1-xml' },
  { type: 'stb', action: 'do_auth', JsHttpRequest: '1-xml' }
]

export const SYNC_INTERVAL_OPTIONS = [
  { value: 0, label: 'Kapali' },
  { value: 60 * 60 * 1000, label: '1 saat' },
  { value: 2 * 60 * 60 * 1000, label: '2 saat' },
  { value: 12 * 60 * 60 * 1000, label: '12 saat' },
  { value: 24 * 60 * 60 * 1000, label: '24 saat' },
  { value: 7 * 24 * 60 * 60 * 1000, label: '1 hafta' }
]

function firstText(source, keys) {
  for (const key of keys || []) {
    const value = source && source[key]
    if (value == null) continue
    const text = String(value).trim()
    if (text) return text
  }
  return ''
}

function pickStalkerImage(item) {
  return firstText(item, ['logo', 'stream_icon', 'cover', 'cover_big', 'movie_image', 'screenshot_uri', 'screenshot_url', 'pic', 'poster'])
}

function buildStalkerPlaylistItem(item) {
  const source = item && typeof item === 'object' ? item : {}
  const next = {
    name: source.name || source.title || 'Isimsiz',
    cmd: source.cmd || '',
    sourceCmd: source.cmd || '',
    logo: pickStalkerImage(source),
    id: String(source.id || source.stream_id || source.series_id || '')
  }

  ;[
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
  ].forEach(function(key) {
    const value = source[key]
    if (value == null) return
    if (typeof value === 'string' && !value.trim()) return
    next[key] = Array.isArray(value) ? value.slice() : value
  })

  return next
}

export function byId(id) {
  return document.getElementById(id)
}

export function setProgress(value) {
  const fill = byId('pbar')
  if (!fill) return
  fill.style.width = Math.max(0, Math.min(100, Number(value) || 0)) + '%'
}

export function setStatus(text) {
  const el = byId('status-left')
  if (el) el.textContent = text || 'Hazir'
}

export function setRight(text) {
  const el = byId('status-right')
  if (el) el.textContent = text || ''
}

export function updateServerBadge(active, message) {
  const badge = byId('server-badge')
  if (!badge) return
  badge.classList.toggle('off', !active)
  badge.textContent = message || (active ? 'Sunucu Aktif' : 'Sunucu Pasif')
}

export async function requestJson(url, options) {
  const response = await fetch(url, options)
  const text = await response.text()
  let data = {}
  if (text) {
    try {
      data = JSON.parse(text)
    } catch (error) {
      throw new Error(text.slice(0, 200))
    }
  }
  if (!response.ok) {
    throw new Error(data.error || ('HTTP ' + response.status))
  }
  return data
}

export function api(endpoint, body) {
  return requestJson(API_BASE + endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  })
}

export function apiGet(endpoint) {
  return requestJson(API_BASE + endpoint)
}

export function apiPut(endpoint, body) {
  return requestJson(API_BASE + endpoint, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  })
}

export function apiDelete(endpoint) {
  return requestJson(API_BASE + endpoint, { method: 'DELETE' })
}

export function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function escapeAttr(text) {
  return escapeHtml(text)
}

export function escapeJsSingleQuoted(text) {
  return String(text == null ? '' : text)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
}

export function safeUpperPair(name) {
  return String(name || '?').replace(/\s+/g, '').substring(0, 2).toUpperCase() || '??'
}

export function emptyPlaylistCounts() {
  return { live: 0, movies: 0, series: 0, total: 0 }
}

export function getPlaylistCounts(value) {
  if (!value) return emptyPlaylistCounts()

  if (value.counts && typeof value.counts === 'object') {
    return {
      live: Math.max(0, Number(value.counts.live) || 0),
      movies: Math.max(0, Number(value.counts.movies) || 0),
      series: Math.max(0, Number(value.counts.series) || 0),
      total: Math.max(0, Number(value.counts.total) || 0)
    }
  }

  const data = value.data && typeof value.data === 'object'
    ? value.data
    : value
  const counts = emptyPlaylistCounts()
  ;['live', 'movies', 'series'].forEach(function(kind) {
    Object.values((data && data[kind]) || {}).forEach(function(items) {
      const size = Array.isArray(items) ? items.length : 0
      counts[kind] += size
      counts.total += size
    })
  })
  return counts
}

export function countChannels(value) {
  return getPlaylistCounts(value).total
}

export function summarizePlaylists(playlists) {
  const totals = emptyPlaylistCounts()

  ;(playlists || []).forEach(function(pl) {
    const counts = getPlaylistCounts(pl)
    totals.live += counts.live
    totals.movies += counts.movies
    totals.series += counts.series
    totals.total += counts.total
  })

  return {
    live: totals.live,
    movies: totals.movies,
    series: totals.series,
    lists: (playlists || []).length
  }
}

export function sourceVisual(type) {
  if (type === 'stalker') return { icon: 'S', cls: 'ic-stalker', label: 'Stalker' }
  if (type === 'xtream') return { icon: 'X', cls: 'ic-xtream', label: 'Xtream' }
  if (type === 'external') return { icon: 'E', cls: 'ic-external', label: 'Harici Video' }
  if (type === 'custom') return { icon: 'C', cls: 'ic-custom', label: 'Kurgu' }
  return { icon: 'M', cls: 'ic-m3u', label: 'M3U' }
}

export function typeLabel(type) {
  return sourceVisual(type).label
}

function cleanObject(source) {
  const output = {}
  Object.keys(source || {}).forEach(function(key) {
    const value = source[key]
    if (value == null) return
    if (typeof value === 'string' && !value.trim()) return
    output[key] = typeof value === 'string' ? value.trim() : value
  })
  return output
}

function pickFirstValue(source, keys) {
  for (const key of keys) {
    const value = source && source[key]
    if (value == null) continue
    if (typeof value === 'string' && !value.trim()) continue
    return value
  }
  return ''
}

function parseMaybeDateMs(value) {
  if (value == null || value === '') return 0
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.getTime() : 0
  }

  const text = String(value).trim()
  if (!text || text === '0' || text.toLowerCase() === 'null' || text.toLowerCase() === 'undefined') {
    return 0
  }

  if (/^\d+$/.test(text)) {
    const numeric = Number(text)
    if (!Number.isFinite(numeric) || numeric <= 0) return 0
    if (text.length >= 13) return numeric
    if (text.length >= 10) return numeric * 1000
    return 0
  }

  const parsed = Date.parse(text.replace(/\//g, '-'))
  return Number.isFinite(parsed) ? parsed : 0
}

function toIsoStringOrEmpty(value) {
  const ms = parseMaybeDateMs(value)
  return ms ? new Date(ms).toISOString() : ''
}

export function normalizePlaylistMeta(meta) {
  const normalized = Object.assign({}, meta || {})
  normalized.syncIntervalMs = Math.max(0, Number(normalized.syncIntervalMs) || 0)

  normalized.expireAt = toIsoStringOrEmpty(
    normalized.expireAt ||
    normalized.expireDate ||
    normalized.exp_date ||
    normalized.tariff_expired_date ||
    normalized.expireRaw
  )

  normalized.lastSyncedAt = toIsoStringOrEmpty(normalized.lastSyncedAt)
  normalized.lastSyncAttemptAt = toIsoStringOrEmpty(normalized.lastSyncAttemptAt)
  normalized.syncConfiguredAt = toIsoStringOrEmpty(normalized.syncConfiguredAt)

  if (normalized.expireRaw != null) normalized.expireRaw = String(normalized.expireRaw || '').trim()
  if (normalized.accountStatus != null) normalized.accountStatus = String(normalized.accountStatus || '').trim()
  if (normalized.planName != null) normalized.planName = String(normalized.planName || '').trim()
  if (normalized.lastSyncError != null) normalized.lastSyncError = String(normalized.lastSyncError || '').trim()

  return normalized
}

export function normalizePlaylistRecord(playlist) {
  const normalized = Object.assign({}, playlist || {})
  normalized.meta = normalizePlaylistMeta(normalized.meta)
  return normalized
}

function mergePlaylistMeta(existingMeta, patchMeta) {
  const merged = Object.assign({}, existingMeta || {})
  Object.keys(patchMeta || {}).forEach(function(key) {
    if (patchMeta[key] !== undefined) {
      merged[key] = patchMeta[key]
    }
  })
  return normalizePlaylistMeta(merged)
}

function formatRelativeTime(value) {
  const ms = parseMaybeDateMs(value)
  if (!ms) return ''

  const diff = ms - Date.now()
  const abs = Math.abs(diff)
  if (abs < 60 * 1000) return diff >= 0 ? 'simdi' : 'az once'

  const units = [
    { size: 7 * 24 * 60 * 60 * 1000, label: 'hafta' },
    { size: 24 * 60 * 60 * 1000, label: 'gun' },
    { size: 60 * 60 * 1000, label: 'saat' },
    { size: 60 * 1000, label: 'dk' }
  ]

  for (const unit of units) {
    if (abs >= unit.size) {
      const amount = Math.round(abs / unit.size)
      return amount + ' ' + unit.label + (diff >= 0 ? ' sonra' : ' once')
    }
  }

  return diff >= 0 ? 'simdi' : 'az once'
}

export function formatDateTime(value) {
  const ms = parseMaybeDateMs(value)
  if (!ms) return 'Belirsiz'
  return new Date(ms).toLocaleString('tr-TR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function extractStalkerAccountMeta(response) {
  const payload = response && response.js && typeof response.js === 'object' ? response.js : response
  if (!payload || typeof payload !== 'object') return {}

  const expireRaw = pickFirstValue(payload, [
    'tariff_expired_date',
    'expire_billing_date',
    'expire_date',
    'exp_date',
    'end_date',
    'date_end',
    'active_till',
    'expires_at'
  ])
  const expireAt = toIsoStringOrEmpty(expireRaw)
  const accountStatus = pickFirstValue(payload, ['status', 'account_status', 'tariff_status'])
  const planName = pickFirstValue(payload, ['tariff_plan', 'tariff_plan_name', 'plan'])

  return cleanObject({
    expireAt: expireAt || '',
    expireRaw: expireRaw || '',
    accountStatus: accountStatus || '',
    planName: planName || ''
  })
}

async function fetchStalkerAccountMeta(url, mac) {
  for (const params of STALKER_ACCOUNT_REQUESTS) {
    try {
      const response = await api('/api/stalker', {
        portalUrl: url,
        mac: mac,
        params: params
      })
      const meta = extractStalkerAccountMeta(response)
      if (Object.keys(meta).length) return meta
    } catch (error) {
    }
  }
  return {}
}

export function formatPlaylistExpiry(meta) {
  const normalized = normalizePlaylistMeta(meta)
  if (normalized.expireAt) {
    const relative = formatRelativeTime(normalized.expireAt)
    return relative
      ? formatDateTime(normalized.expireAt) + ' (' + relative + ')'
      : formatDateTime(normalized.expireAt)
  }
  if (normalized.expireRaw) return normalized.expireRaw
  return 'Belirsiz'
}

export function getSyncIntervalMs(meta) {
  return Math.max(0, Number((meta || {}).syncIntervalMs) || 0)
}

export function formatSyncIntervalLabel(intervalMs) {
  const numeric = Math.max(0, Number(intervalMs) || 0)
  const found = SYNC_INTERVAL_OPTIONS.find(function(option) {
    return option.value === numeric
  })
  return found ? found.label : 'Kapali'
}

function getPlaylistSyncReferenceMs(playlist) {
  const meta = normalizePlaylistMeta((playlist || {}).meta)
  return parseMaybeDateMs(meta.lastSyncAttemptAt) ||
    parseMaybeDateMs(meta.lastSyncedAt)
}

function getPlaylistNextSyncMs(playlist) {
  const intervalMs = getSyncIntervalMs((playlist || {}).meta)
  if (!intervalMs) return 0
  const referenceMs = getPlaylistSyncReferenceMs(playlist)
  return referenceMs ? referenceMs + intervalMs : Date.now()
}

export function formatLastSyncText(playlist) {
  const meta = normalizePlaylistMeta((playlist || {}).meta)
  if (meta.lastSyncedAt) {
    return formatDateTime(meta.lastSyncedAt) + ' (' + formatRelativeTime(meta.lastSyncedAt) + ')'
  }
  if (meta.lastSyncAttemptAt) {
    return 'Denendi: ' + formatDateTime(meta.lastSyncAttemptAt)
  }
  return 'Henuz yok'
}

export function formatNextSyncText(playlist) {
  const nextSyncMs = getPlaylistNextSyncMs(playlist)
  if (!nextSyncMs) return 'Kapali'
  return formatDateTime(nextSyncMs) + ' (' + formatRelativeTime(nextSyncMs) + ')'
}

export async function pingServerInfo() {
  try {
    const info = await apiGet('/api/server-info')
    updateServerBadge(true, info && info.deliveryMode === 'redirect' ? 'Bulut Aktif' : 'Sunucu Aktif')
    return true
  } catch (error) {
    updateServerBadge(false, 'Sunucu Hatasi')
    return false
  }
}

export function initShell(activeNav) {
  document.querySelectorAll('[data-nav]').forEach(function(link) {
    link.classList.toggle('active', link.getAttribute('data-nav') === activeNav)
  })

  window.addEventListener('beforeunload', function() {
    stopAutoSync()
    closePlayer()
  })

  return pingServerInfo()
}

export function getExtensionFromUrl(url) {
  try {
    const pathname = new URL(url).pathname
    const match = pathname.match(/\.([a-z0-9]+)$/i)
    return match ? match[1].toLowerCase() : ''
  } catch (error) {
    return ''
  }
}

export function inferStreamKind(url, contentType) {
  const ct = String(contentType || '').toLowerCase()
  const ext = getExtensionFromUrl(url)

  if (ct.includes('application/vnd.apple.mpegurl') || ct.includes('application/x-mpegurl') || ext === 'm3u8' || ext === 'm3u') return 'hls'
  if (
    ct.includes('video/mp2t') ||
    ct.includes('application/mp2t') ||
    ['mpegts', 'm2ts', 'mts', 'mpg', 'mpeg', 'ts'].includes(ext) ||
    /\/play\/live\.php/i.test(String(url || '')) ||
    /\/live\/play\//i.test(String(url || ''))
  ) return 'mpegts'
  if (ct.includes('audio/')) return 'audio'
  if (ct.includes('video/')) return 'video'
  return 'unknown'
}

export function shouldResolveStalkerCmd(cmd) {
  const value = String(cmd || '').trim()
  if (!value) return true
  if (/^(?:ffmpeg|ffrt|auto|mpegts)\s+/i.test(value)) return true
  if (value.includes('localhost') || value.includes('127.0.0.1')) return true
  if (value.charAt(0) === '/') return true
  return false
}

export function shouldPreferCompatibilityPlayer(url, headers) {
  const lowerUrl = String(url || '').toLowerCase()
  const userAgent = String((headers || {})['User-Agent'] || (headers || {})['user-agent'] || '').trim().toLowerCase()
  const xUserAgent = String((headers || {})['X-User-Agent'] || (headers || {})['x-user-agent'] || '').trim().toLowerCase()
  const icyMetaData = String((headers || {})['Icy-MetaData'] || (headers || {})['icy-metadata'] || '').trim()
  return /\/play\/live\.php/i.test(lowerUrl) ||
    /\/live\/play\//i.test(lowerUrl) ||
    icyMetaData === '1' ||
    userAgent === 'ksplayer' ||
    xUserAgent.includes('mag250')
}

export function closePlayer() {
  if (playerPopup && !playerPopup.closed) {
    try { playerPopup.close() } catch (error) {}
  }
  playerPopup = null
}

export function openPlayer(realUrl, mac, headers, name, options) {
  closePlayer()

  let playerUrl = API_BASE + '/player.html?url=' + encodeURIComponent(realUrl) + '&name=' + encodeURIComponent(name || 'IPTV Stream')
  if (mac) playerUrl += '&mac=' + encodeURIComponent(mac)
  if (headers && Object.keys(headers).length) {
    playerUrl += '&headers=' + encodeURIComponent(JSON.stringify(headers))
  }
  if (options && options.sourceType) playerUrl += '&sourceType=' + encodeURIComponent(options.sourceType)
  if (options && options.portalUrl) playerUrl += '&portalUrl=' + encodeURIComponent(options.portalUrl)
  if (options && options.resolveCmd) playerUrl += '&resolveCmd=' + encodeURIComponent(options.resolveCmd)
  if (options && options.sourceId) playerUrl += '&sourceId=' + encodeURIComponent(options.sourceId)
  if (options && options.streamType) playerUrl += '&streamType=' + encodeURIComponent(options.streamType)
  if (options && options.sourceMeta) playerUrl += '&sourceMeta=' + encodeURIComponent(JSON.stringify(options.sourceMeta))

  const popupWidth = Math.min(1440, Math.max(980, Math.floor(window.screen.availWidth * 0.82)))
  const popupHeight = Math.min(900, Math.max(620, Math.floor(window.screen.availHeight * 0.82)))
  const popupLeft = Math.max(0, Math.floor((window.screen.availWidth - popupWidth) / 2))
  const popupTop = Math.max(0, Math.floor((window.screen.availHeight - popupHeight) / 2))
  const features = [
    'popup=yes',
    'width=' + popupWidth,
    'height=' + popupHeight,
    'left=' + popupLeft,
    'top=' + popupTop,
    'resizable=yes',
    'scrollbars=no',
    'toolbar=no',
    'menubar=no',
    'location=no',
    'status=no'
  ].join(',')

  playerPopup = window.open(playerUrl, 'iptv_player_popup', features)
  if (playerPopup && !playerPopup.closed) {
    try { playerPopup.focus() } catch (error) {}
    return true
  }

  playerPopup = null
  window.open(playerUrl, '_blank')
  return false
}

export async function copyText(text) {
  await navigator.clipboard.writeText(String(text || ''))
}

export function downloadTextFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType || 'text/plain;charset=utf-8' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = filename
  link.click()
  URL.revokeObjectURL(link.href)
}

export function readFileAsText(file) {
  return new Promise(function(resolve, reject) {
    const reader = new FileReader()
    reader.onload = function(event) { resolve(event.target.result) }
    reader.onerror = function() { reject(new Error('Dosya okunamadi')) }
    reader.readAsText(file)
  })
}

export function buildChannelDB(playlists, filterId) {
  const db = { live: {}, movies: {}, series: {} }
  const sourceLists = filterId && filterId !== '__all__'
    ? (playlists || []).filter(function(pl) { return pl.id === filterId })
    : (playlists || [])

  sourceLists.forEach(function(pl) {
    if (!pl || !pl.data) return
    ;['live', 'movies', 'series'].forEach(function(kind) {
      Object.keys(pl.data[kind] || {}).forEach(function(group) {
        if (!db[kind][group]) db[kind][group] = []
        ;(pl.data[kind][group] || []).forEach(function(item) {
          db[kind][group].push(Object.assign({}, item, {
            _sourceId: item && item.sourcePlaylistId ? item.sourcePlaylistId : pl.id,
            _sourceName: item && item.sourcePlaylistName ? item.sourcePlaylistName : pl.name,
            _sourceType: item && item.sourceType ? item.sourceType : pl.type,
            _sourceMeta: item && item.sourceMeta ? item.sourceMeta : (pl.meta || {})
          }))
        })
      })
    })
  })

  return db
}

export function buildVisibleChannels(channelDB, activeCat, activeSub, query) {
  let items = []
  if (activeSub === '__all__') {
    Object.keys(channelDB[activeCat] || {}).forEach(function(group) {
      ;(channelDB[activeCat][group] || []).forEach(function(item) {
        items.push(Object.assign({}, item, { subcat: group }))
      })
    })
  } else {
    ;(channelDB[activeCat][activeSub] || []).forEach(function(item) {
      items.push(Object.assign({}, item, { subcat: activeSub }))
    })
  }

  const normalizedQuery = String(query || '').trim().toLowerCase()
  if (normalizedQuery) {
    items = items.filter(function(item) {
      return String(item.name || '').toLowerCase().includes(normalizedQuery)
    })
  }
  return items
}

export function channelCount(channelDB, kind) {
  return Object.values(channelDB[kind] || {}).reduce(function(sum, items) {
    return sum + items.length
  }, 0)
}

export async function loadPlaylists(options) {
  const summary = !!(options && options.summary)
  const playlists = await apiGet(summary ? '/api/playlists?summary=1' : '/api/playlists')
  return Array.isArray(playlists) ? playlists.map(normalizePlaylistRecord) : []
}

export async function getPlaylist(id) {
  return normalizePlaylistRecord(await apiGet('/api/playlists/' + encodeURIComponent(id)))
}

export async function createPlaylist(payload) {
  return normalizePlaylistRecord(await api('/api/playlists', payload))
}

export async function updatePlaylist(id, payload) {
  return normalizePlaylistRecord(await apiPut('/api/playlists/' + encodeURIComponent(id), payload))
}

export async function deletePlaylist(id) {
  return apiDelete('/api/playlists/' + encodeURIComponent(id))
}

async function fetchStalkerAll(url, mac, progressCallback) {
  const result = { live: {}, movies: {}, series: {} }

  function notify(message, progress) {
    if (typeof progressCallback === 'function') {
      progressCallback({ message, progress })
    }
  }

  function apiS(params) {
    return api('/api/stalker', { portalUrl: url, mac: mac, params: params })
  }

  function fetchPaged(type, action, extra, bucket) {
    return new Promise(function(resolve) {
      let page = 1

      function next() {
        apiS(Object.assign({
          type: type,
          action: action,
          p: page,
          JsHttpRequest: '1-xml'
        }, extra || {}))
          .then(function(response) {
            const items = response && response.js && response.js.data ? response.js.data : []
            const pageSize = response && response.js && response.js.max_page_items ? response.js.max_page_items : 14

            items.forEach(function(item) {
              bucket.push(buildStalkerPlaylistItem(item))
            })

            if (items.length >= pageSize && page < 15) {
              page += 1
              next()
            } else {
              resolve()
            }
          })
          .catch(function() {
            resolve()
          })
      }

      next()
    })
  }

  const genresRes = await apiS({ type: 'itv', action: 'get_genres', JsHttpRequest: '1-xml' })
  const genres = (genresRes.js || []).filter(function(item) { return item.id !== '*' })

  for (let index = 0; index < genres.length; index += 1) {
    const genre = genres[index]
    const name = genre.title || 'Genel'
    result.live[name] = []
    notify('Live: ' + name, 15 + Math.round(((index + 1) / Math.max(genres.length, 1)) * 20))
    await fetchPaged('itv', 'get_ordered_list', { genre: genre.id }, result.live[name])
  }

  const categoriesRes = await apiS({ type: 'vod', action: 'get_categories', JsHttpRequest: '1-xml' })
  const movieCategories = (categoriesRes.js || []).filter(function(item) { return item.id !== '*' })

  for (let index = 0; index < movieCategories.length; index += 1) {
    const category = movieCategories[index]
    const name = category.title || 'Genel'
    result.movies[name] = []
    notify('Movies: ' + name, 35 + Math.round(((index + 1) / Math.max(movieCategories.length, 1)) * 20))
    await fetchPaged('vod', 'get_ordered_list', { category: category.id }, result.movies[name])
  }

  const seriesRes = await apiS({ type: 'series', action: 'get_categories', JsHttpRequest: '1-xml' })
  const seriesCategories = (seriesRes.js || []).filter(function(item) { return item.id !== '*' })

  for (let index = 0; index < seriesCategories.length; index += 1) {
    const category = seriesCategories[index]
    const name = category.title || 'Genel'
    result.series[name] = []
    notify('Series: ' + name, 58 + Math.round(((index + 1) / Math.max(seriesCategories.length, 1)) * 32))
    await fetchPaged('series', 'get_ordered_list', { category: category.id }, result.series[name])
  }

  return result
}

export async function addStalkerPlaylist(options) {
  const url = String(options.url || '').trim().replace(/\/+$/, '')
  const mac = String(options.mac || '').trim()
  const name = String(options.name || '').trim() || 'Stalker Liste'

  if (!url || !mac) {
    throw new Error('Portal URL ve MAC gerekli')
  }

  setProgress(5)
  if (options.onProgress) options.onProgress({ message: 'Baglaniliyor...', progress: 5 })
  await api('/api/stalker', {
    portalUrl: url,
    mac: mac,
    params: { type: 'stb', action: 'handshake', JsHttpRequest: '1-xml' }
  })

  const syncStamp = new Date().toISOString()
  const [data, accountMeta] = await Promise.all([
    fetchStalkerAll(url, mac, options.onProgress),
    fetchStalkerAccountMeta(url, mac)
  ])
  setProgress(80)
  const playlist = await createPlaylist({
    name: name,
    type: 'stalker',
    meta: mergePlaylistMeta({ url: url, mac: mac }, Object.assign({}, accountMeta, {
      lastSyncedAt: syncStamp,
      lastSyncAttemptAt: syncStamp
    })),
    data: data
  })
  setProgress(100)
  return { playlist, data }
}

export async function addXtreamPlaylist(options) {
  const host = String(options.host || '').trim().replace(/\/+$/, '')
  const username = String(options.username || '').trim()
  const password = String(options.password || '').trim()
  const name = String(options.name || '').trim() || 'Xtream Liste'

  if (!host || !username || !password) {
    throw new Error('Tum Xtream alanlari gerekli')
  }

  setProgress(12)
  if (options.onProgress) options.onProgress({ message: 'Baglaniliyor...', progress: 12 })
  const response = await api('/api/xtream/fetch', {
    host: host,
    username: username,
    password: password
  })
  const data = response && response.data ? response.data : response
  const remoteMeta = response && response.meta ? response.meta : {}
  const syncStamp = new Date().toISOString()
  setProgress(75)
  const playlist = await createPlaylist({
    name: name,
    type: 'xtream',
    meta: mergePlaylistMeta({ host: host, username: username, password: password }, Object.assign({}, remoteMeta, {
      lastSyncedAt: syncStamp,
      lastSyncAttemptAt: syncStamp
    })),
    data: data
  })
  setProgress(100)
  return { playlist, data }
}

export async function addM3UPlaylist(options) {
  const url = String(options.url || '').trim()
  const file = options.file || null
  const name = String(options.name || '').trim() || 'M3U Liste'

  if (!url && !file) {
    throw new Error('M3U URL veya dosya gerekli')
  }

  setProgress(10)
  if (options.onProgress) options.onProgress({ message: 'Isleniyor...', progress: 10 })

  let data
  if (file) {
    const content = await readFileAsText(file)
    data = await api('/api/m3u/parse', { content: content })
  } else {
    data = await api('/api/m3u/parse', { url: url })
  }

  setProgress(80)
  const syncStamp = new Date().toISOString()
  const playlist = await createPlaylist({
    name: name,
    type: 'm3u',
    meta: mergePlaylistMeta({ url: url, sourceName: file ? file.name : '' }, {
      lastSyncedAt: syncStamp,
      lastSyncAttemptAt: syncStamp
    }),
    data: data
  })
  setProgress(100)
  return { playlist, data }
}

export async function addExternalPlaylist(options) {
  const playlistName = String(options.name || '').trim() || 'Harici Video Listesi'
  const kind = ['live', 'movies', 'series'].includes(String(options.kind || '').trim())
    ? String(options.kind || '').trim()
    : 'movies'
  const group = String(options.group || '').trim() || 'Genel'
  const itemName = String(options.itemName || '').trim() || 'Harici Video'
  const streamUrl = String(options.streamUrl || '').trim()
  const logo = String(options.logo || '').trim()
  const providerLabel = String(options.providerLabel || '').trim()

  if (!streamUrl) {
    throw new Error('Stream URL gerekli')
  }

  setProgress(18)
  if (options.onProgress) {
    options.onProgress({ message: 'Harici kaynak veritabani icin hazirlaniyor...', progress: 18 })
  }

  const data = emptyData()
  data[kind][group] = [{
    id: String(Date.now()),
    name: itemName,
    logo: logo,
    cmd: streamUrl,
    sourceCmd: streamUrl,
    sourceType: 'external',
    sourceMeta: cleanObject({
      providerLabel: providerLabel,
      originalUrl: streamUrl
    })
  }]

  const syncStamp = new Date().toISOString()
  const playlist = await createPlaylist({
    name: playlistName,
    type: 'external',
    meta: mergePlaylistMeta({
      providerLabel: providerLabel,
      sourceUrl: streamUrl,
      sourceName: itemName,
      createdManually: true
    }, {
      lastSyncedAt: syncStamp,
      lastSyncAttemptAt: syncStamp
    }),
    data: data
  })

  setProgress(100)
  return { playlist, data }
}

export async function refreshPlaylistData(playlist, onProgress) {
  if (!playlist) throw new Error('Liste bulunamadi')
  if (playlist.type === 'custom' || playlist.type === 'external') {
    throw new Error('Manuel playlist kaynak sync ile yenilenmez. Bu liste editor veya kontrol panel uzerinden yonetilir.')
  }

  let data
  let remoteMeta = {}
  if (playlist.type === 'stalker') {
    if (onProgress) onProgress({ message: 'Baglanti yenileniyor...', progress: 10 })
    await api('/api/stalker', {
      portalUrl: playlist.meta.url,
      mac: playlist.meta.mac,
      params: { type: 'stb', action: 'handshake', JsHttpRequest: '1-xml' }
    })
    const response = await Promise.all([
      fetchStalkerAll(playlist.meta.url, playlist.meta.mac, onProgress),
      fetchStalkerAccountMeta(playlist.meta.url, playlist.meta.mac)
    ])
    data = response[0]
    remoteMeta = response[1]
  } else if (playlist.type === 'xtream') {
    if (onProgress) onProgress({ message: 'Xtream yenileniyor...', progress: 35 })
    const response = await api('/api/xtream/fetch', {
      host: playlist.meta.host,
      username: playlist.meta.username,
      password: playlist.meta.password
    })
    data = response && response.data ? response.data : response
    remoteMeta = response && response.meta ? response.meta : {}
  } else {
    if (!playlist.meta || !playlist.meta.url) throw new Error('M3U URL bulunamadi')
    if (onProgress) onProgress({ message: 'M3U yenileniyor...', progress: 35 })
    data = await api('/api/m3u/parse', { url: playlist.meta.url })
  }

  const syncStamp = new Date().toISOString()
  const nextMeta = mergePlaylistMeta(playlist.meta, Object.assign({}, remoteMeta, {
    lastSyncedAt: syncStamp,
    lastSyncAttemptAt: syncStamp,
    lastSyncError: ''
  }))
  const updatedPlaylist = await updatePlaylist(playlist.id, { data: data, meta: nextMeta })
  playlist.data = updatedPlaylist.data
  playlist.meta = updatedPlaylist.meta
  playlist.updatedAt = updatedPlaylist.updatedAt || playlist.updatedAt
  return updatedPlaylist
}

export async function updatePlaylistSyncInterval(playlist, intervalMs) {
  if (!playlist) throw new Error('Liste bulunamadi')

  const normalizedInterval = Math.max(0, Number(intervalMs) || 0)
  const nextMeta = mergePlaylistMeta(playlist.meta, {
    syncIntervalMs: normalizedInterval,
    syncConfiguredAt: new Date().toISOString()
  })
  const updatedPlaylist = await updatePlaylist(playlist.id, { meta: nextMeta })
  playlist.meta = updatedPlaylist.meta
  playlist.updatedAt = updatedPlaylist.updatedAt || playlist.updatedAt
  return updatedPlaylist
}

async function runAutoSyncCycle() {
  if (!autoSyncOptions || typeof autoSyncOptions.getPlaylists !== 'function') return

  const playlists = autoSyncOptions.getPlaylists() || []
  let changed = false

  for (const playlist of playlists) {
    const intervalMs = getSyncIntervalMs((playlist || {}).meta)
    const nextSyncMs = getPlaylistNextSyncMs(playlist)
    if (!intervalMs || !nextSyncMs || Date.now() < nextSyncMs || autoSyncRunningIds.has(playlist.id)) {
      continue
    }

    autoSyncRunningIds.add(playlist.id)
    try {
      if (typeof autoSyncOptions.onStatus === 'function') {
        autoSyncOptions.onStatus('Oto sync: ' + playlist.name)
      }
      await refreshPlaylistData(playlist, autoSyncOptions.onProgress)
      changed = true
      if (typeof autoSyncOptions.onSynced === 'function') {
        autoSyncOptions.onSynced(playlist)
      }
    } catch (error) {
      const failedMeta = mergePlaylistMeta(playlist.meta, {
        lastSyncAttemptAt: new Date().toISOString(),
        lastSyncError: error.message
      })
      const updatedPlaylist = await updatePlaylist(playlist.id, { meta: failedMeta })
      playlist.meta = updatedPlaylist.meta
      playlist.updatedAt = updatedPlaylist.updatedAt || playlist.updatedAt
      changed = true
      if (typeof autoSyncOptions.onError === 'function') {
        autoSyncOptions.onError(playlist, error)
      }
    } finally {
      autoSyncRunningIds.delete(playlist.id)
    }
  }

  if (changed && typeof autoSyncOptions.onPlaylistsChanged === 'function') {
    autoSyncOptions.onPlaylistsChanged(playlists)
  }
}

export function startAutoSync(options) {
  autoSyncOptions = options || {}
  if (autoSyncTimer) {
    window.clearInterval(autoSyncTimer)
  }
  autoSyncTimer = window.setInterval(runAutoSyncCycle, 60 * 1000)
  runAutoSyncCycle()
}

export function stopAutoSync() {
  if (autoSyncTimer) {
    window.clearInterval(autoSyncTimer)
  }
  autoSyncTimer = null
  autoSyncOptions = null
  autoSyncRunningIds.clear()
}

export async function resolveChannel(item, type) {
  if (!item) throw new Error('Kanal bulunamadi')

  const cmd = item._sourceType === 'stalker'
    ? String(item.sourceCmd || item.cmd || '').trim()
    : String(item.cmd || '').trim()
  const itemId = String(item.id || '').trim()

  // YouTube URL kontrolü - sourceMeta'dan kontrol et
  const sourceMeta = item._sourceMeta || {}
  const originalUrl = sourceMeta.originalUrl || cmd
  
  if (originalUrl && (originalUrl.includes('youtube.com') || originalUrl.includes('youtu.be'))) {
    const data = await apiGet('/api/youtube/resolve?url=' + encodeURIComponent(originalUrl))
    const proxied = API_BASE + '/stream?url=' + encodeURIComponent(data.streamUrl)
    return {
      streamUrl: proxied,
      mac: '',
      headers: {}
    }
  }

  const needsResolve =
    (item._sourceType === 'stalker' && (type !== 'live' || shouldResolveStalkerCmd(cmd))) ||
    (item._sourceType === 'xtream' && type === 'series')

  if (!needsResolve) {
    return {
      streamUrl: cmd,
      mac: item._sourceType === 'stalker' ? (item._sourceMeta.mac || '') : '',
      headers: {}
    }
  }

  const data = await api('/api/resolve', {
    portalUrl: item._sourceMeta.url,
    mac: item._sourceMeta.mac,
    cmd: cmd,
    itemId: itemId,
    type: type,
    sourceType: item._sourceType || '',
    sourceMeta: item._sourceMeta || {}
  })

  return {
    streamUrl: data.streamUrl,
    mac: item._sourceMeta.mac || '',
    headers: data.playbackHeaders || {}
  }
}

export async function getServerInfo() {
  return apiGet('/api/server-info')
}

export async function saveServerConfig(username, password) {
  return api('/api/server-config', { username: username, password: password })
}

export function buildTvBaseUrl(info) {
  if (!info) return ''
  if (info.separatePort === false) return window.location.origin
  return window.location.protocol + '//' + window.location.hostname + ':' + info.port
}

export function buildM3uLink(info) {
  const tvBase = buildTvBaseUrl(info)
  if (!tvBase) return 'TV sunucusu kullanilamiyor.'
  return tvBase + '/playlist.m3u?username=' + encodeURIComponent(info.username) + '&password=' + encodeURIComponent(info.password)
}

export function formatConnectionInfo(info) {
  const tvBase = buildTvBaseUrl(info)
  if (!tvBase) return '<span class="k">Durum    :</span> TV sunucusu kullanilamiyor'
  return (
    '<span class="k">Sunucu   :</span> ' + escapeHtml(tvBase) + '\n' +
    '<span class="k">Mod      :</span> ' + escapeHtml(info.deliveryMode === 'redirect' ? 'Bulut / Redirect' : 'Ayrı TV Sunucu') + '\n' +
    '<span class="k">Kullanici:</span> ' + escapeHtml(info.username) + '\n' +
    '<span class="k">Sifre    :</span> ' + escapeHtml(info.password) + '\n' +
    '<span class="k">Portal   :</span> ' + escapeHtml(tvBase + '/player_api.php')
  )
}
