import {
  api,
  initShell,
  setStatus,
  setRight,
  loadPlaylists,
  getPlaylistCounts,
  getServerInfo,
  saveServerConfig,
  formatConnectionInfo,
  buildM3uLink,
  copyText
} from './app-core.js'

function getSharedPlaylists(playlists) {
  const available = (playlists || []).filter(Boolean)
  const explicit = available.filter(function(playlist) {
    return !!(playlist && playlist.meta && playlist.meta.tvPublished)
  })
  return explicit.length ? explicit : available
}

function summarizeTvOutput(playlists) {
  const shared = getSharedPlaylists(playlists)
  const stats = { live: 0, movies: 0, series: 0, lists: shared.length }

  ;(shared || []).forEach(function(playlist) {
    const counts = getPlaylistCounts(playlist)
    stats.live += counts.live
    stats.movies += counts.movies
    stats.series += counts.series
  })

  return stats
}

function renderPublishedPlaylists(playlists) {
  const container = document.getElementById('sv-published-list')
  const copy = document.getElementById('sv-sharing-copy')
  const shared = getSharedPlaylists(playlists)
  const explicit = (playlists || []).some(function(playlist) {
    return !!(playlist && playlist.meta && playlist.meta.tvPublished)
  })

  copy.textContent = explicit
    ? 'Sadece asagidaki playlistler TV sunucusuna paylasiliyor. Editor modulu icinden istedigin playlisti TV\'ye yayinlayabilirsin.'
    : 'Henuz ozel yayin secimi yapilmamis. Bu durumda tum playlistler TV sunucusunda paylasilir.'

  if (!shared.length) {
    container.innerHTML = '<div class="empty">Paylasilan playlist yok</div>'
    return
  }

  container.innerHTML = shared.map(function(playlist) {
    return '<span class="editor-tag">' + playlist.name + ' (' + playlist.type + ')</span>'
  }).join('')
}

function renderPublishedPlaylistsFromInfo(info, fallbackPlaylists) {
  if (info && Array.isArray(info.publishedPlaylists) && info.publishedPlaylists.length) {
    document.getElementById('sv-sharing-copy').textContent = info.sharingMode === 'selected'
      ? 'Sadece asagidaki playlistler TV sunucusuna paylasiliyor. Editor modulu icinden TV\'ye Yayinla ile bunu degistirebilirsin.'
      : 'Henuz ozel yayin secimi yapilmamis. Bu durumda tum playlistler TV sunucusunda paylasilir.'
    document.getElementById('sv-published-list').innerHTML = info.publishedPlaylists.map(function(playlist) {
      return '<span class="editor-tag">' + playlist.name + ' (' + playlist.type + ')</span>'
    }).join('')
    return
  }

  renderPublishedPlaylists(fallbackPlaylists)
}

function renderDeployState(info) {
  const button = document.getElementById('btn-deploy-vercel')
  const copy = document.getElementById('sv-deploy-copy')
  const status = document.getElementById('sv-deploy-status')

  if (!info || !info.canTriggerLocalDeploy) {
    button.disabled = true
    copy.textContent = 'Bu buton sadece yerel calismada kullanilir. Vercel uzerindeki site kendi kendine local kodunu deploy edemez.'
    status.textContent = info && info.lastLocalDeploy && info.lastLocalDeploy.deploymentUrl
      ? 'Son local deploy: ' + info.lastLocalDeploy.deploymentUrl
      : 'Bu deployment Vercel uzerinden acik.'
    return
  }

  button.disabled = false
  copy.textContent = 'Kod degisikliklerini PowerShell acmadan production Vercel deployment olarak gonderebilirsin. Playlist icerik degisiklikleri icin normalde buna gerek yoktur.'
  status.textContent = info.lastLocalDeploy && info.lastLocalDeploy.deploymentUrl
    ? 'Son local deploy: ' + info.lastLocalDeploy.deploymentUrl
    : 'Hazir'
}

function renderStats(playlists) {
  const stats = summarizeTvOutput(playlists)
  document.getElementById('sv-live').textContent = stats.live
  document.getElementById('sv-mov').textContent = stats.movies
  document.getElementById('sv-ser').textContent = stats.series
  document.getElementById('sv-lists').textContent = stats.lists
  setRight(stats.lists + ' liste')
}

async function loadServer() {
  const info = await getServerInfo()
  document.getElementById('sv-user').value = info.username
  document.getElementById('sv-pass').value = info.password
  document.getElementById('conn-info').innerHTML = formatConnectionInfo(info)
  document.getElementById('m3u-link').textContent = buildM3uLink(info)
  document.getElementById('sv-storage').textContent = info.storage === 'database'
    ? 'Neon / Postgres'
    : info.storageMode === 'readonly-file'
      ? 'Salt okunur dosya'
      : 'Dosya'
  document.getElementById('sv-mode').textContent = info.deliveryMode === 'redirect' ? 'Bulut / Redirect' : 'Ayrik TV Sunucu'
  const readOnly = !!info.readOnly || info.storageMode === 'readonly-file'
  document.getElementById('btn-copy-m3u').disabled = false
  document.getElementById('btn-save-server').disabled = readOnly
  document.getElementById('sv-user').disabled = readOnly
  document.getElementById('sv-pass').disabled = readOnly
  renderDeployState(info)
  return info
}

async function bootstrap() {
  initShell('server')
  setStatus('TV sunucusu yukleniyor...')

  document.getElementById('btn-save-server').addEventListener('click', async function() {
    try {
      await saveServerConfig(
        document.getElementById('sv-user').value.trim(),
        document.getElementById('sv-pass').value.trim()
      )
      await loadServer()
      setStatus('Sunucu ayarlari kaydedildi')
    } catch (error) {
      setStatus('Sunucu ayar hatasi: ' + error.message)
    }
  })

  document.getElementById('btn-copy-m3u').addEventListener('click', async function() {
    try {
      await copyText(document.getElementById('m3u-link').textContent)
      setStatus('M3U linki kopyalandi')
    } catch (error) {
      setStatus('Kopyalama hatasi: ' + error.message)
    }
  })

  document.getElementById('m3u-link').addEventListener('click', async function() {
    try {
      await copyText(document.getElementById('m3u-link').textContent)
      setStatus('M3U linki kopyalandi')
    } catch (error) {
      setStatus('Kopyalama hatasi: ' + error.message)
    }
  })

  document.getElementById('btn-deploy-vercel').addEventListener('click', async function() {
    const button = document.getElementById('btn-deploy-vercel')
    const statusBox = document.getElementById('sv-deploy-status')
    button.disabled = true
    statusBox.textContent = 'Vercel deploy baslatiliyor...'
    try {
      const result = await api('/api/deploy/vercel', {})
      statusBox.textContent = result.deploymentUrl
        ? ('Deploy tamamlandi: ' + result.deploymentUrl)
        : (result.output || 'Deploy tamamlandi')
      setStatus('Vercel production deploy tamamlandi')
    } catch (error) {
      statusBox.textContent = 'Deploy hatasi: ' + error.message
      setStatus('Vercel deploy hatasi: ' + error.message)
    } finally {
      const info = await loadServer().catch(function() { return null })
      if (!info || info.canTriggerLocalDeploy) button.disabled = false
    }
  })

  try {
    const playlists = await loadPlaylists({ summary: true })
    renderStats(playlists)
    const info = await loadServer()
    renderPublishedPlaylistsFromInfo(info, playlists)
    setStatus(info.deliveryMode === 'redirect' ? 'Bulut TV modu hazir' : 'TV sunucusu hazir')
  } catch (error) {
    setStatus('TV sunucusu hatasi: ' + error.message)
  }
}

bootstrap()
