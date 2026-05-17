import {
  initShell,
  setStatus,
  setRight,
  loadPlaylists,
  summarizePlaylists,
  getServerInfo,
  countChannels,
  typeLabel,
  sourceVisual,
  escapeHtml,
  buildM3uLink,
  formatPlaylistExpiry,
  isPlaylistExpired,
  formatSyncIntervalLabel,
  formatLastSyncText,
  formatNextSyncText,
  startAutoSync
} from './app-core.js'

let playlists = []

// Animated number counter
function animateCount(el, target) {
  if (!el) return
  var start = parseInt(el.textContent.replace(/\D/g, '')) || 0
  if (start === target) { el.textContent = target.toLocaleString('tr-TR'); return }
  var duration = 700
  var startTime = null
  function easeOut(t) { return 1 - Math.pow(1 - t, 3) }
  function step(timestamp) {
    if (!startTime) startTime = timestamp
    var progress = Math.min((timestamp - startTime) / duration, 1)
    var current = Math.round(start + (target - start) * easeOut(progress))
    el.textContent = current.toLocaleString('tr-TR')
    if (progress < 1) requestAnimationFrame(step)
    else el.textContent = target.toLocaleString('tr-TR')
  }
  requestAnimationFrame(step)
}

function formatConnectionLines(playlist) {
  var meta = playlist && playlist.meta ? playlist.meta : {}
  if (!playlist) return ''

  if (playlist.type === 'stalker') {
    return (
      '<div class="list-mini-line list-mini-line-code"><span>Portal</span>' + escapeHtml(String(meta.url || 'Belirsiz')) + '</div>' +
      '<div class="list-mini-line list-mini-line-code"><span>MAC</span>' + escapeHtml(String(meta.mac || 'Belirsiz')) + '</div>'
    )
  }
  if (playlist.type === 'xtream') {
    return (
      '<div class="list-mini-line list-mini-line-code"><span>Sunucu</span>' + escapeHtml(String(meta.host || 'Belirsiz')) + '</div>' +
      '<div class="list-mini-line list-mini-line-code"><span>Kullanici</span>' + escapeHtml(String(meta.username || 'Belirsiz')) + '</div>'
    )
  }
  if (playlist.type === 'm3u') {
    return '<div class="list-mini-line list-mini-line-code"><span>Kaynak</span>' + escapeHtml(String(meta.url || meta.sourceName || 'Belirsiz')) + '</div>'
  }
  if (playlist.type === 'external') {
    return (
      '<div class="list-mini-line list-mini-line-code"><span>Stream</span>' + escapeHtml(String(meta.sourceUrl || 'Belirsiz')) + '</div>' +
      '<div class="list-mini-line"><span>Etiket</span>' + escapeHtml(String(meta.providerLabel || 'Manuel kaynak')) + '</div>'
    )
  }
  if (playlist.type === 'custom') {
    return '<div class="list-mini-line"><span>Tip</span>Kurgu / Manuel</div>'
  }
  return ''
}

function getTypeBadgeClass(type) {
  var map = { stalker: 'badge-source', xtream: 'badge-source', m3u: 'badge-source', external: 'badge-source', custom: 'badge-draft' }
  return map[type] || 'badge-draft'
}

function getPublishedBadge(pl) {
  if (pl.meta && pl.meta.tvPublished) return '<span class="playlist-status-badge badge-published">● TV Yayininda</span>'
  if (pl.meta && pl.meta.playlistBucket === 'curated') return '<span class="playlist-status-badge badge-draft">○ Kurgu Taslak</span>'
  return '<span class="playlist-status-badge ' + getTypeBadgeClass(pl.type) + '">' + escapeHtml(typeLabel(pl.type)) + '</span>'
}

function renderStats(items) {
  var stats = summarizePlaylists(items)
  animateCount(document.getElementById('dash-live'), stats.live)
  animateCount(document.getElementById('dash-movies'), stats.movies)
  animateCount(document.getElementById('dash-series'), stats.series)
  animateCount(document.getElementById('dash-lists'), stats.lists)
  // Mini pills in hero
  var hpLive = document.getElementById('hp-live')
  var hpMovies = document.getElementById('hp-movies')
  var hpSeries = document.getElementById('hp-series')
  var hpLists = document.getElementById('hp-lists')
  if (hpLive) hpLive.textContent = stats.live.toLocaleString('tr-TR')
  if (hpMovies) hpMovies.textContent = stats.movies.toLocaleString('tr-TR')
  if (hpSeries) hpSeries.textContent = stats.series.toLocaleString('tr-TR')
  if (hpLists) hpLists.textContent = stats.lists.toLocaleString('tr-TR')
  setRight(stats.lists + ' liste · ' + (stats.live + stats.movies + stats.series).toLocaleString('tr-TR') + ' icerik')
}

function renderRecentLists(items) {
  var container = document.getElementById('recent-lists')
  if (!items.length) {
    container.innerHTML = '<div class="empty">Henuz kayitli liste yok</div>'
    return
  }

  container.innerHTML = items
    .slice()
    .sort(function(a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')) })
    .map(function(pl) {
      var visual = sourceVisual(pl.type)
      var connectionLines = formatConnectionLines(pl)
      var syncError = pl.meta && pl.meta.lastSyncError
        ? '<div class="list-mini-line list-mini-alert"><span>Hata</span>' + escapeHtml(pl.meta.lastSyncError) + '</div>'
        : ''
      var cnt = countChannels(pl)
      var expired = isPlaylistExpired(pl.meta)
      var expiredBadge = expired
        ? '<span class="list-mini-expired-badge">&#9888; Sure Doldu</span>'
        : ''
      var expiryLineClass = expired ? ' list-mini-line--expired' : ''
      var itemClass = expired ? ' list-mini-item--expired' : ''

      return (
        '<div class="list-mini-item' + itemClass + '">' +
          '<div class="list-mini-copy">' +
            '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">' +
              '<div class="list-mini-title">' + escapeHtml(pl.name) + '</div>' +
              getPublishedBadge(pl) +
              expiredBadge +
            '</div>' +
            '<div class="list-mini-meta">' + cnt + ' icerik</div>' +
            '<div class="list-mini-lines">' +
              '<div class="list-mini-line' + expiryLineClass + '"><span>Bitis</span>' + escapeHtml(formatPlaylistExpiry(pl.meta)) + '</div>' +
              '<div class="list-mini-line"><span>Oto sync</span>' + escapeHtml(formatSyncIntervalLabel(pl.meta && pl.meta.syncIntervalMs)) + '</div>' +
              '<div class="list-mini-line"><span>Son sync</span>' + escapeHtml(formatLastSyncText(pl)) + '</div>' +
              '<div class="list-mini-line"><span>Sonraki</span>' + escapeHtml(formatNextSyncText(pl)) + '</div>' +
              connectionLines +
              syncError +
            '</div>' +
          '</div>' +
          '<div class="icon-badge ' + visual.cls + '">' + visual.icon + '</div>' +
        '</div>'
      )
    })
    .join('')
}

async function renderServerSummary() {
  var el = document.getElementById('server-summary')
  try {
    var info = await getServerInfo()
    var host = window.location.protocol + '//' + window.location.hostname
    var xtreamUrl = host + ':' + info.port
    var m3uLink = buildM3uLink(info)

    el.innerHTML = (
      '<div class="server-info-row"><span class="server-info-key">Depolama</span><span class="server-info-val">' + escapeHtml(String(info.storageMode || 'Dosya')) + '</span></div>' +
      '<div class="server-info-row"><span class="server-info-key">Xtream Cikis</span><span class="server-info-val">' + escapeHtml(xtreamUrl) + '</span></div>' +
      '<div class="server-info-row"><span class="server-info-key">M3U Linki</span><span class="server-info-val">' + escapeHtml(m3uLink) + '</span></div>' +
      '<div class="server-info-row"><span class="server-info-key">Platform</span><span class="server-info-val">' + escapeHtml(String(info.platform || '-')) + '</span></div>'
    )
  } catch (error) {
    el.innerHTML = '<div class="server-info-row"><span class="server-info-key">Hata</span><span class="server-info-val">' + escapeHtml(error.message) + '</span></div>'
  }
}

async function bootstrap() {
  initShell('dashboard')
  setStatus('Yukleniyor...')

  try {
    playlists = await loadPlaylists({ summary: true })
    renderStats(playlists)
    renderRecentLists(playlists)
    startAutoSync({
      getPlaylists: function() { return playlists },
      onStatus: function(message) { setStatus(message) },
      onPlaylistsChanged: function() {
        renderStats(playlists)
        renderRecentLists(playlists)
      }
    })
    await renderServerSummary()
    setStatus('Dashboard hazir · ' + new Date().toLocaleTimeString('tr-TR'))
  } catch (error) {
    setStatus('Dashboard hatasi: ' + error.message)
  }
}

bootstrap()
