import React, { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Shell } from './shared/shell'
import { PlaylistRecord, ServerInfo, countData, deployVercel, getPlaylists, getServerInfo, saveServerConfig } from './shared/api'

function shouldUseSeparatePort(info: ServerInfo) {
  const host = window.location.hostname.toLowerCase()
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host.endsWith('.local')
  return Boolean(info.separatePort && info.port && isLocal)
}

function buildM3uLink(info: ServerInfo) {
  const base = shouldUseSeparatePort(info)
    ? (window.location.protocol + '//' + window.location.hostname + ':' + String(info.port))
    : window.location.origin
  return base + '/playlist-latest.m3u?username=' + encodeURIComponent(info.username) + '&password=' + encodeURIComponent(info.password)
}

function buildDirectM3uLink(info: ServerInfo) {
  const base = shouldUseSeparatePort(info)
    ? (window.location.protocol + '//' + window.location.hostname + ':' + String(info.port))
    : window.location.origin
  return base + '/playlist.m3u?username=' + encodeURIComponent(info.username) + '&password=' + encodeURIComponent(info.password)
}

function TvServerApp() {
  const [info, setInfo] = useState<ServerInfo | null>(null)
  const [playlists, setPlaylists] = useState<PlaylistRecord[]>([])
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('admin')
  const [status, setStatus] = useState('Yukleniyor...')
  const [deploying, setDeploying] = useState(false)
  const [deployOutput, setDeployOutput] = useState('')

  async function refresh() {
    const [nextInfo, nextPlaylists] = await Promise.all([getServerInfo(), getPlaylists()])
    setInfo(nextInfo)
    setPlaylists(nextPlaylists)
    setUsername(nextInfo.username)
    setPassword(nextInfo.password)
  }

  useEffect(() => {
    refresh()
      .then(() => setStatus('TV sunucusu hazir'))
      .catch((error) => setStatus('Yukleme hatasi: ' + error.message))
  }, [])

  const published = useMemo(() => {
    const explicitIds = new Set((info?.publishedPlaylists || []).map((playlist) => playlist.id))
    if (explicitIds.size) {
      return playlists.filter((playlist) => explicitIds.has(playlist.id))
    }
    return playlists.filter((playlist) => playlist.meta?.tvPublished)
  }, [info, playlists])

  const totals = useMemo(() => {
    return published.reduce((acc, playlist) => {
      const counts = countData(playlist.data)
      acc.live += counts.live
      acc.movies += counts.movies
      acc.series += counts.series
      return acc
    }, { live: 0, movies: 0, series: 0 })
  }, [published])

  return (
    <Shell
      page="server"
      title="TV Sunucu Merkezi"
      subtitle="TV linki sadece yayina aldigin playlisti aktif veritabanindan okur. Playlist eksikse burada uyari gorursun; editor modulu uzerinden kurgu playlistini hazirlayip yayina alman gerekir."
      status={info?.deliveryMode === 'redirect' ? 'Bulut / Redirect' : 'Yerel / Proxy'}
    >
      <div className="studio-grid">
        <div className="card studio-panel">
          <div className="card-title">Sunucu Ayarlari</div>
          <div className="field">
            <label>Kullanici Adi</label>
            <input value={username} onChange={(event) => setUsername(event.target.value)} />
          </div>
          <div className="field">
            <label>Sifre</label>
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </div>
          <div className="btn-row">
            <button className="btn btn-primary" onClick={async () => {
              try {
                await saveServerConfig(username, password)
                await refresh()
                setStatus('Sunucu ayarlari kaydedildi')
              } catch (error: any) {
                setStatus('Kaydetme hatasi: ' + error.message)
              }
            }}>Kaydet</button>
            <button className="btn btn-gray" disabled={!info?.canTriggerLocalDeploy || deploying} onClick={async () => {
              try {
                setDeploying(true)
                setDeployOutput('')
                setStatus('Vercel deploy baslatiliyor...')
                const result = await deployVercel()
                setDeployOutput(result.output || result.deploymentUrl || 'Deploy tamamlandi')
                setStatus(result.deploymentUrl ? ('Deploy tamamlandi: ' + result.deploymentUrl) : 'Deploy tamamlandi')
                await refresh()
              } catch (error: any) {
                setDeployOutput(error.message || '')
                setStatus('Deploy hatasi: ' + error.message)
              } finally {
                setDeploying(false)
              }
            }}>
              {deploying ? 'Deploy Ediliyor...' : "Vercel'e Deploy Et"}
            </button>
          </div>
          <div className="studio-message">{status}</div>
          {info?.storageFallbackReason ? (
            <div className="studio-message" style={{ color: 'var(--warning)' }}>
              Depolama fallback: {info.storageFallbackReason}
            </div>
          ) : null}
          <div className="studio-deploy-meta">
            <div><strong>Veritabani:</strong> {info?.databaseProvider || 'Belirsiz'}{info?.databaseHost ? (' | ' + info.databaseHost) : ''}</div>
            <div><strong>Bagli Proje:</strong> {info?.linkedVercelProject?.projectName || 'Bulunamadi'}</div>
            <div><strong>Son Deploy:</strong> {info?.lastLocalDeploy?.at ? new Date(info.lastLocalDeploy.at).toLocaleString() : 'Henuz yok'}</div>
            {info?.lastLocalDeploy?.deploymentUrl ? <div><strong>URL:</strong> {info.lastLocalDeploy.deploymentUrl}</div> : null}
          </div>
          {deployOutput ? <pre className="studio-deploy-output">{deployOutput}</pre> : null}
        </div>

        <div className="card studio-panel">
          <div className="card-title">Yayinlanan Playlist</div>
          {!published.length ? (
            <div className="empty">
              Playlist eksik. Editor modulu icinden kurgu playlistini secip TV'ye Yayinla veya TV'ye Gonder kullan.
            </div>
          ) : (
            <div className="studio-list">
              {published.map((playlist) => (
                <div key={playlist.id} className="studio-summary-card">
                  <strong>{playlist.name}</strong>
                  <span className="muted">{playlist.type} | live {countData(playlist.data).live} | movies {countData(playlist.data).movies} | series {countData(playlist.data).series}</span>
                </div>
              ))}
            </div>
          )}
          {info ? (
            <div className="studio-m3u-box">
              <div className="sidebar-label">TV Linki</div>
              <code>{buildM3uLink(info)}</code>
              <div className="section-copy" style={{ marginTop: 8 }}>
                Eski cihazlarda redirect desteklenmezse:
              </div>
              <code>{buildDirectM3uLink(info)}</code>
            </div>
          ) : null}
        </div>

        <div className="card studio-panel">
          <div className="card-title">Istatistik</div>
          <div className="stats-grid">
            <div className="stat-card"><div className="stat-big">{totals.live}</div><div className="stat-label">Live</div></div>
            <div className="stat-card"><div className="stat-big">{totals.movies}</div><div className="stat-label">Movies</div></div>
            <div className="stat-card"><div className="stat-big">{totals.series}</div><div className="stat-label">Series</div></div>
            <div className="stat-card"><div className="stat-big">{published.length}</div><div className="stat-label">Playlist</div></div>
          </div>
          <div className="section-copy" style={{ marginTop: 12 }}>
            Veri kaynagi: <strong>{info?.storageMode || info?.storage || 'database'}</strong> | Paylasim modu: <strong>{info?.sharingMode || 'selected'}</strong>
          </div>
        </div>
      </div>
    </Shell>
  )
}

createRoot(document.getElementById('app-root')!).render(<TvServerApp />)
