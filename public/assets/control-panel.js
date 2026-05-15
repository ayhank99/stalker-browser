import {
  initShell,
  setProgress,
  setStatus,
  setRight,
  loadPlaylists,
  summarizePlaylists,
  sourceVisual,
  typeLabel,
  countChannels,
  escapeHtml,
  escapeAttr,
  addStalkerPlaylist,
  addXtreamPlaylist,
  addM3UPlaylist,
  addExternalPlaylist,
  deletePlaylist,
  refreshPlaylistData,
  formatPlaylistExpiry,
  formatLastSyncText,
  formatNextSyncText,
  formatSyncIntervalLabel,
  SYNC_INTERVAL_OPTIONS,
  updatePlaylistSyncInterval,
  startAutoSync
} from './app-core.js'

let playlists = []

function isManualPlaylist(playlist) {
  return !!(playlist && (playlist.type === 'custom' || playlist.type === 'external'))
}

function formatConnectionRows(playlist) {
  const meta = playlist && playlist.meta ? playlist.meta : {}
  if (!playlist) return ''

  if (playlist.type === 'stalker') {
    return (
      '<div class="source-detail-row source-detail-row-code"><span>Portal</span><strong>' + escapeHtml(String(meta.url || 'Belirsiz')) + '</strong></div>' +
      '<div class="source-detail-row source-detail-row-code"><span>MAC</span><strong>' + escapeHtml(String(meta.mac || 'Belirsiz')) + '</strong></div>'
    )
  }

  if (playlist.type === 'xtream') {
    return (
      '<div class="source-detail-row source-detail-row-code"><span>Sunucu</span><strong>' + escapeHtml(String(meta.host || 'Belirsiz')) + '</strong></div>' +
      '<div class="source-detail-row source-detail-row-code"><span>Kullanici</span><strong>' + escapeHtml(String(meta.username || 'Belirsiz')) + '</strong></div>' +
      '<div class="source-detail-row source-detail-row-code"><span>Sifre</span><strong>' + escapeHtml(String(meta.password || 'Belirsiz')) + '</strong></div>'
    )
  }

  if (playlist.type === 'm3u') {
    return '<div class="source-detail-row source-detail-row-code"><span>Kaynak</span><strong>' + escapeHtml(String(meta.url || meta.sourceName || 'Belirsiz')) + '</strong></div>'
  }

  if (playlist.type === 'external') {
    return (
      '<div class="source-detail-row source-detail-row-code"><span>Stream</span><strong>' + escapeHtml(String(meta.sourceUrl || 'Belirsiz')) + '</strong></div>' +
      '<div class="source-detail-row"><span>Etiket</span><strong>' + escapeHtml(String(meta.providerLabel || 'Manuel kaynak')) + '</strong></div>'
    )
  }

  if (playlist.type === 'custom') {
    return '<div class="source-detail-row"><span>Playlist Tipi</span><strong>Kurgu / Manuel</strong></div>'
  }

  return ''
}

function statsToDom(stats) {
  document.getElementById('quick-live').textContent = stats.live
  document.getElementById('quick-movies').textContent = stats.movies
  document.getElementById('quick-series').textContent = stats.series
  document.getElementById('quick-lists').textContent = stats.lists
  setRight(stats.lists + ' liste')
}

function renderSyncSelect(playlist) {
  if (isManualPlaylist(playlist)) {
    return '<div class="muted">Manuel playlist</div>'
  }
  const currentValue = playlist && playlist.meta ? Number(playlist.meta.syncIntervalMs) || 0 : 0
  return (
    '<select class="source-sync-select" data-action="sync" data-id="' + escapeAttr(playlist.id) + '">' +
      SYNC_INTERVAL_OPTIONS.map(function(option) {
        return '<option value="' + option.value + '"' + (option.value === currentValue ? ' selected' : '') + '>' + escapeHtml(option.label) + '</option>'
      }).join('') +
    '</select>'
  )
}

function renderSourceList() {
  const list = document.getElementById('source-list')
  if (!playlists.length) {
    list.innerHTML = '<div class="empty">Henuz liste eklenmemis</div>'
    return
  }

  list.innerHTML = playlists.map(function(pl) {
    const visual = sourceVisual(pl.type)
    const isCustom = isManualPlaylist(pl)
    const planLine = pl.meta && pl.meta.planName
      ? '<div class="source-detail-row"><span>Plan</span><strong>' + escapeHtml(pl.meta.planName) + '</strong></div>'
      : ''
    const statusLine = pl.meta && pl.meta.accountStatus
      ? '<div class="source-detail-row"><span>Durum</span><strong>' + escapeHtml(pl.meta.accountStatus) + '</strong></div>'
      : ''
    const errorLine = pl.meta && pl.meta.lastSyncError
      ? '<div class="source-detail-row source-detail-row-danger"><span>Hata</span><strong>' + escapeHtml(pl.meta.lastSyncError) + '</strong></div>'
      : ''
    const connectionLines = formatConnectionRows(pl)

    return (
      '<div class="source-card">' +
        '<div class="source-icon ' + visual.cls + '">' + visual.icon + '</div>' +
        '<div class="source-info">' +
          '<div class="source-name">' + escapeHtml(pl.name) + '</div>' +
          '<div class="source-meta">' + escapeHtml(typeLabel(pl.type)) + ' | ' + countChannels(pl) + ' icerik</div>' +
          '<div class="source-detail-list">' +
            '<div class="source-detail-row"><span>Bitis</span><strong>' + escapeHtml(formatPlaylistExpiry(pl.meta)) + '</strong></div>' +
            '<div class="source-detail-row"><span>Son sync</span><strong>' + escapeHtml(formatLastSyncText(pl)) + '</strong></div>' +
            '<div class="source-detail-row"><span>Sonraki</span><strong>' + escapeHtml(formatNextSyncText(pl)) + '</strong></div>' +
            '<div class="source-detail-row"><span>Oto sync</span><strong>' + escapeHtml(isCustom ? 'Manuel' : formatSyncIntervalLabel(pl.meta && pl.meta.syncIntervalMs)) + '</strong></div>' +
            connectionLines +
            planLine +
            statusLine +
            errorLine +
          '</div>' +
          '<div class="source-sync-row">' +
            '<label>Sync periyodu</label>' +
            renderSyncSelect(pl) +
          '</div>' +
        '</div>' +
        '<div class="source-actions">' +
          (isCustom ? '' : '<button class="icon-btn" type="button" data-action="refresh" data-id="' + escapeAttr(pl.id) + '" title="Yenile">&#8635;</button>') +
          '<button class="icon-btn danger" type="button" data-action="delete" data-id="' + escapeAttr(pl.id) + '" title="Sil">&#10005;</button>' +
        '</div>' +
      '</div>'
    )
  }).join('')
}

function renderAll() {
  statsToDom(summarizePlaylists(playlists))
  renderSourceList()
}

async function reload() {
  playlists = await loadPlaylists({ summary: true })
  renderAll()
}

function setInlineStatus(id, text, color) {
  const el = document.getElementById(id)
  el.textContent = text || ''
  if (color) el.style.color = color
}

async function handleAddStalker() {
  const statusId = 's-status'
  try {
    setInlineStatus(statusId, 'Baglaniliyor...', 'var(--warning)')
    const result = await addStalkerPlaylist({
      url: document.getElementById('s-url').value,
      mac: document.getElementById('s-mac').value,
      name: document.getElementById('s-name').value,
      onProgress: function(update) {
        setInlineStatus(statusId, update.message || '', 'var(--warning)')
        if (update.progress != null) setProgress(update.progress)
      }
    })
    playlists.push(result.playlist)
    renderAll()
    setInlineStatus(statusId, 'Tamamlandi: ' + countChannels(result.data) + ' icerik', 'var(--success)')
    setStatus('Stalker liste eklendi: ' + result.playlist.name)
  } catch (error) {
    setInlineStatus(statusId, 'Hata: ' + error.message, 'var(--danger)')
    setStatus('Stalker hatasi: ' + error.message)
  }
}

async function handleAddXtream() {
  const statusId = 'x-status'
  try {
    setInlineStatus(statusId, 'Baglaniliyor...', 'var(--warning)')
    const result = await addXtreamPlaylist({
      host: document.getElementById('x-host').value,
      username: document.getElementById('x-user').value,
      password: document.getElementById('x-pass').value,
      name: document.getElementById('x-name').value,
      onProgress: function(update) {
        setInlineStatus(statusId, update.message || '', 'var(--warning)')
      }
    })
    playlists.push(result.playlist)
    renderAll()
    setInlineStatus(statusId, 'Tamamlandi: ' + countChannels(result.data) + ' icerik', 'var(--success)')
    setStatus('Xtream liste eklendi: ' + result.playlist.name)
  } catch (error) {
    setInlineStatus(statusId, 'Hata: ' + error.message, 'var(--danger)')
    setStatus('Xtream hatasi: ' + error.message)
  }
}

async function handleAddM3U() {
  const statusId = 'm-status'
  try {
    setInlineStatus(statusId, 'Isleniyor...', 'var(--warning)')
    const result = await addM3UPlaylist({
      url: document.getElementById('m-url').value,
      file: document.getElementById('m-file').files[0],
      name: document.getElementById('m-name').value,
      onProgress: function(update) {
        setInlineStatus(statusId, update.message || '', 'var(--warning)')
      }
    })
    playlists.push(result.playlist)
    renderAll()
    setInlineStatus(statusId, 'Tamamlandi: ' + countChannels(result.data) + ' icerik', 'var(--success)')
    setStatus('M3U liste eklendi: ' + result.playlist.name)
  } catch (error) {
    setInlineStatus(statusId, 'Hata: ' + error.message, 'var(--danger)')
    setStatus('M3U hatasi: ' + error.message)
  }
}

async function handleAddExternal() {
  const statusId = 'e-status'
  try {
    setInlineStatus(statusId, 'Veritabani icin hazirlaniyor...', 'var(--warning)')
    const result = await addExternalPlaylist({
      name: document.getElementById('e-name').value,
      kind: document.getElementById('e-kind').value,
      group: document.getElementById('e-group').value,
      itemName: document.getElementById('e-item-name').value,
      streamUrl: document.getElementById('e-url').value,
      logo: document.getElementById('e-logo').value,
      providerLabel: document.getElementById('e-provider').value,
      onProgress: function(update) {
        setInlineStatus(statusId, update.message || '', 'var(--warning)')
        if (update.progress != null) setProgress(update.progress)
      }
    })
    playlists.push(result.playlist)
    renderAll()
    setInlineStatus(statusId, 'Kaydedildi: ' + countChannels(result.data) + ' icerik', 'var(--success)')
    setStatus('Harici kaynak eklendi: ' + result.playlist.name)
  } catch (error) {
    setInlineStatus(statusId, 'Hata: ' + error.message, 'var(--danger)')
    setStatus('Harici kaynak hatasi: ' + error.message)
  }
}

async function handleListAction(event) {
  const button = event.target.closest('button[data-action]')
  if (!button) return

  const id = button.getAttribute('data-id')
  const action = button.getAttribute('data-action')
  const playlist = playlists.find(function(pl) { return pl.id === id })
  if (!playlist) return

  if (action === 'delete') {
    if (!window.confirm('Bu listeyi silmek istiyor musunuz?')) return
    try {
      await deletePlaylist(id)
      playlists = playlists.filter(function(pl) { return pl.id !== id })
      renderAll()
      setStatus('Liste silindi: ' + playlist.name)
    } catch (error) {
      setStatus('Silme hatasi: ' + error.message)
    }
    return
  }

  if (action === 'refresh') {
    if (isManualPlaylist(playlist)) {
      setStatus('Manuel playlist editor veya kontrol panel uzerinden yonetilir')
      return
    }
    button.disabled = true
    setStatus('Yenileniyor: ' + playlist.name)
    try {
      const updatedPlaylist = await refreshPlaylistData(playlist, function(update) {
        if (update.message) setStatus(update.message)
        if (update.progress != null) setProgress(update.progress)
      })
      Object.assign(playlist, updatedPlaylist)
      renderAll()
      setStatus('Yenilendi: ' + playlist.name)
    } catch (error) {
      setStatus('Yenileme hatasi: ' + error.message)
    } finally {
      button.disabled = false
    }
  }
}

async function handleListChange(event) {
  const select = event.target.closest('select[data-action="sync"]')
  if (!select) return

  const id = select.getAttribute('data-id')
  const playlist = playlists.find(function(pl) { return pl.id === id })
  if (!playlist) return
  if (playlist.type === 'custom') {
    setStatus('Kurgu playlistte oto sync yok')
    renderAll()
    return
  }

  try {
    const updatedPlaylist = await updatePlaylistSyncInterval(playlist, Number(select.value))
    Object.assign(playlist, updatedPlaylist)
    renderAll()
    setStatus('Sync araligi kaydedildi: ' + playlist.name)
  } catch (error) {
    setStatus('Sync ayari kaydedilemedi: ' + error.message)
  }
}

async function bootstrap() {
  initShell('control')
  setStatus('Kontrol paneli yukleniyor...')
  setProgress(5)

  document.getElementById('btn-add-stalker').addEventListener('click', handleAddStalker)
  document.getElementById('btn-add-xtream').addEventListener('click', handleAddXtream)
  document.getElementById('btn-add-m3u').addEventListener('click', handleAddM3U)
  document.getElementById('btn-add-external').addEventListener('click', handleAddExternal)
  document.getElementById('source-list').addEventListener('click', handleListAction)
  document.getElementById('source-list').addEventListener('change', handleListChange)

  try {
    await reload()
    startAutoSync({
      getPlaylists: function() { return playlists },
      onStatus: function(message) { setStatus(message) },
      onProgress: function(update) {
        if (update && update.progress != null) setProgress(update.progress)
      },
      onPlaylistsChanged: function() {
        renderAll()
      }
    })
    setProgress(100)
    setStatus('Kontrol paneli hazir')
  } catch (error) {
    setStatus('Yukleme hatasi: ' + error.message)
  }
}

bootstrap()
