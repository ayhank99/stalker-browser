import {
  initShell,
  setStatus,
  setRight,
  loadPlaylists,
  getPlaylist,
  buildChannelDB,
  buildVisibleChannels,
  channelCount,
  escapeHtml,
  escapeAttr,
  safeUpperPair,
  resolveChannel,
  openPlayer,
  copyText,
  downloadTextFile
} from './app-core.js'

let playlistSummaries = []
let playlists = []
let channelDB = { live: {}, movies: {}, series: {} }
let activeCat = 'live'
let activeSub = '__all__'
let visible = []
let rebuildToken = 0
const playlistCache = Object.create(null)

function renderSourceFilter() {
  const select = document.getElementById('source-filter')
  const currentValue = select.value
  let html = '<option value="__all__">Tum Listeler</option>'
  playlistSummaries.forEach(function(pl) {
    html += '<option value="' + escapeAttr(pl.id) + '">' + escapeHtml(pl.name) + '</option>'
  })
  select.innerHTML = html
  if (currentValue && Array.from(select.options).some(function(option) { return option.value === currentValue })) {
    select.value = currentValue
  } else if (playlistSummaries[0]) {
    select.value = playlistSummaries[0].id
  }
}

async function loadSelectedPlaylists() {
  const selectedId = document.getElementById('source-filter').value || '__all__'

  if (selectedId === '__all__') {
    const missing = playlistSummaries.filter(function(playlist) {
      return !playlistCache[playlist.id]
    })
    if (missing.length) {
      const loaded = await Promise.all(missing.map(function(playlist) {
        return getPlaylist(playlist.id)
      }))
      loaded.forEach(function(playlist) {
        playlistCache[playlist.id] = playlist
      })
    }
    return playlistSummaries
      .map(function(playlist) { return playlistCache[playlist.id] || null })
      .filter(Boolean)
  }

  if (!playlistCache[selectedId]) {
    playlistCache[selectedId] = await getPlaylist(selectedId)
  }
  return playlistCache[selectedId] ? [playlistCache[selectedId]] : []
}

async function rebuildChannelDB() {
  const selectedId = document.getElementById('source-filter').value || '__all__'
  const token = ++rebuildToken
  setStatus(selectedId === '__all__' ? 'Tum listeler yukleniyor...' : 'Playlist yukleniyor...')
  const loadedPlaylists = await loadSelectedPlaylists()
  if (token !== rebuildToken) return
  playlists = loadedPlaylists
  channelDB = buildChannelDB(playlists, selectedId)
  document.getElementById('cnt-live').textContent = channelCount(channelDB, 'live')
  document.getElementById('cnt-movies').textContent = channelCount(channelDB, 'movies')
  document.getElementById('cnt-series').textContent = channelCount(channelDB, 'series')
  renderSubcats()
  renderChannels()
  setStatus(selectedId === '__all__' ? 'Tum listeler hazir' : 'Kanallar hazir')
}

function renderSubcats() {
  const groups = channelDB[activeCat] || {}
  const total = Object.values(groups).reduce(function(sum, items) { return sum + items.length }, 0)
  let html = '<button class="sub-item ' + (activeSub === '__all__' ? 'active' : '') + '" type="button" data-group="__all__"><span>Tumu</span><span class="sub-cnt">' + total + '</span></button>'
  Object.keys(groups).sort().forEach(function(group) {
    html += '<button class="sub-item ' + (activeSub === group ? 'active' : '') + '" type="button" data-group="' + escapeAttr(group) + '"><span>' + escapeHtml(group) + '</span><span class="sub-cnt">' + groups[group].length + '</span></button>'
  })
  document.getElementById('subcat-list').innerHTML = html
}

function renderChannels() {
  const query = document.getElementById('search-box').value
  visible = buildVisibleChannels(channelDB, activeCat, activeSub, query)

  const catLabel = activeCat === 'live' ? 'Live TV' : activeCat === 'movies' ? 'Movies' : 'Series'
  const groupLabel = activeSub === '__all__' ? 'Tumu' : activeSub
  document.getElementById('ch-title').textContent = catLabel + ' • ' + groupLabel + ' • ' + visible.length + ' icerik'

  const list = document.getElementById('ch-list')
  if (!visible.length) {
    list.innerHTML = '<div class="empty">Kanal bulunamadi</div>'
    setRight('0 icerik')
    return
  }

  const tagClass = activeCat === 'live' ? 't-live' : activeCat === 'movies' ? 't-movies' : 't-series'
  const tagLabel = activeCat === 'live' ? 'LIVE' : activeCat === 'movies' ? 'MOVIE' : 'SERIES'

  list.innerHTML = visible.map(function(item, index) {
    const logoHtml = item.logo
      ? '<img class="ch-logo" src="' + escapeAttr(item.logo) + '" onerror="this.outerHTML=\'<div class=&quot;ch-logo-ph&quot;>' + safeUpperPair(item.name) + '</div>\'">'
      : '<div class="ch-logo-ph">' + safeUpperPair(item.name) + '</div>'

    return (
      '<div class="ch-row">' +
        '<div class="ch-num">' + (index + 1) + '</div>' +
        '<div class="logo-slot">' + logoHtml + '</div>' +
        '<div class="main-slot">' +
          '<div class="ch-name">' + escapeHtml(item.name) + '</div>' +
          '<div class="ch-meta">' + escapeHtml(item.subcat) + ' • ' + escapeHtml(item._sourceName || '') + '</div>' +
        '</div>' +
        '<span class="tag ' + tagClass + '">' + tagLabel + '</span>' +
        '<div class="action-btns">' +
          '<button class="play-btn" type="button" data-action="play" data-index="' + index + '">Oynat</button>' +
          '<button class="copy-btn" type="button" data-action="copy" data-index="' + index + '">Kopyala</button>' +
        '</div>' +
      '</div>'
    )
  }).join('')

  setRight(visible.length + ' icerik')
}

function selectCat(kind) {
  activeCat = kind
  activeSub = '__all__'
  ;['live', 'movies', 'series'].forEach(function(name) {
    document.getElementById('btn-' + name).classList.toggle('active', name === kind)
  })
  renderSubcats()
  renderChannels()
}

async function handleChannelAction(event) {
  const button = event.target.closest('button[data-action]')
  if (!button) return

  const index = Number(button.getAttribute('data-index'))
  const item = visible[index]
  if (!item) return

  if (button.getAttribute('data-action') === 'copy') {
    button.textContent = '...'
    try {
      const resolved = await resolveChannel(item, activeCat)
      await copyText(resolved.streamUrl)
      button.textContent = 'Kopyalandi'
      button.classList.add('ok')
      setStatus('URL kopyalandi')
      window.setTimeout(function() {
        button.textContent = 'Kopyala'
        button.classList.remove('ok')
      }, 1600)
    } catch (error) {
      button.textContent = 'Hata'
      setStatus('Kopyalama hatasi: ' + error.message)
      window.setTimeout(function() { button.textContent = 'Kopyala' }, 1600)
    }
    return
  }

  button.textContent = '...'
  button.classList.add('loading')
  setStatus('URL cozuluyor: ' + item.name)
  try {
    const resolved = await resolveChannel(item, activeCat)
    const opened = openPlayer(resolved.streamUrl, resolved.mac, resolved.headers, item.name, {
      sourceType: item._sourceType || '',
      portalUrl: item._sourceType === 'stalker' && item._sourceMeta ? (item._sourceMeta.url || '') : '',
      resolveCmd: item._sourceType === 'stalker' ? String(item.sourceCmd || item.cmd || '').trim() : '',
      sourceId: item.id || '',
      streamType: activeCat,
      sourceMeta: item._sourceMeta || {}
    })
    setStatus(opened ? 'Player popup acildi: ' + item.name : 'Player yeni sekmede acildi')
  } catch (error) {
    button.classList.add('error')
    setStatus('Oynatma hatasi: ' + error.message)
  } finally {
    button.textContent = 'Oynat'
    button.classList.remove('loading')
    window.setTimeout(function() { button.classList.remove('error') }, 1500)
  }
}

function exportVisibleAsM3U() {
  const lines = ['#EXTM3U']
  visible.forEach(function(item) {
    lines.push('#EXTINF:-1 tvg-name="' + (item.name || '') + '" tvg-logo="' + (item.logo || '') + '" group-title="' + (item.subcat || '') + '",' + (item.name || ''))
    lines.push(item.cmd || '')
  })

  downloadTextFile(
    lines.join('\n'),
    activeCat + '_' + (activeSub === '__all__' ? 'all' : activeSub).replace(/[^a-z0-9]+/gi, '_') + '.m3u',
    'application/x-mpegurl'
  )
  setStatus(visible.length + ' kanal M3U olarak indirildi')
}

async function copyAllVisibleUrls() {
  const output = visible.map(function(item) {
    return (item.name || '') + ' | ' + (item.cmd || '')
  }).join('\n')

  await copyText(output)
  setStatus(visible.length + ' URL kopyalandi')
}

async function bootstrap() {
  initShell('channels')
  setStatus('Kanallar yukleniyor...')

  document.getElementById('source-filter').addEventListener('change', function() {
    rebuildChannelDB().catch(function(error) {
      setStatus('Kanal yukleme hatasi: ' + error.message)
    })
  })
  document.getElementById('search-box').addEventListener('input', renderChannels)
  document.getElementById('btn-live').addEventListener('click', function() { selectCat('live') })
  document.getElementById('btn-movies').addEventListener('click', function() { selectCat('movies') })
  document.getElementById('btn-series').addEventListener('click', function() { selectCat('series') })
  document.getElementById('subcat-list').addEventListener('click', function(event) {
    const button = event.target.closest('button[data-group]')
    if (!button) return
    activeSub = button.getAttribute('data-group')
    renderSubcats()
    renderChannels()
  })
  document.getElementById('ch-list').addEventListener('click', handleChannelAction)
  document.getElementById('btn-export-m3u').addEventListener('click', exportVisibleAsM3U)
  document.getElementById('btn-copy-all').addEventListener('click', function() {
    copyAllVisibleUrls().catch(function(error) {
      setStatus('Kopyalama hatasi: ' + error.message)
    })
  })

  try {
    playlistSummaries = await loadPlaylists({ summary: true })
    renderSourceFilter()
    if (!playlistSummaries.length) {
      rebuildChannelDB()
      setStatus('Kanallar hazir')
      return
    }
    await rebuildChannelDB()
  } catch (error) {
    setStatus('Kanal yukleme hatasi: ' + error.message)
  }
}

bootstrap()
