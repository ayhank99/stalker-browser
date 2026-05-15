import React, { useEffect, useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { Shell } from './shared/shell';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ServerInfo {
  enabled: boolean;
  separatePort: boolean;
  port: number;
  username: string;
  password: string;
  storage: string;
  storageMode: string;
  hasDatabase: boolean;
  readOnly: boolean;
  readOnlyReason: string;
  databaseProvider: string;
  databaseHost: string;
  canTriggerLocalDeploy: boolean;
  deployInProgress: boolean;
  linkedVercelProject?: { projectId?: string; orgId?: string; name?: string } | null;
  publishedPlaylists: { id: string; name: string; type: string }[];
  sharingMode: string;
  isVercel?: boolean;
}

interface PlaylistSummary {
  id: string;
  name: string;
  type: string;
  counts?: { live: number; movies: number; series: number; total: number };
  meta?: { lastSyncedAt?: string; lastSyncAttemptAt?: string; syncIntervalMs?: number };
}

interface YtChannel {
  id: string;
  name: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

function relativeTime(iso?: string): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'Az önce';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} dk önce`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} sa önce`;
  return `${Math.floor(diff / 86_400_000)} gün önce`;
}

function totalCounts(playlists: PlaylistSummary[]) {
  return playlists.reduce(
    (acc, pl) => {
      const c = pl.counts || { live: 0, movies: 0, series: 0, total: 0 };
      acc.live += c.live;
      acc.movies += c.movies;
      acc.series += c.series;
      acc.total += c.total;
      return acc;
    },
    { live: 0, movies: 0, series: 0, total: 0 }
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatCard({ label, value, sub, color }: { label: string; value: string | number; sub?: string; color?: string }) {
  return (
    <div style={{
      background: 'rgba(255,255,255,0.04)',
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: 10,
      padding: '14px 18px',
      minWidth: 120,
      flex: '1 1 120px',
    }}>
      <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 800, color: color || '#f9fafb', lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function Badge({ text, color }: { text: string; color: string }) {
  return (
    <span style={{
      background: color + '22',
      color: color,
      border: `1px solid ${color}55`,
      borderRadius: 6,
      padding: '2px 10px',
      fontSize: 11,
      fontWeight: 700,
    }}>{text}</span>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
      <div style={{ width: 120, fontSize: 12, color: '#9ca3af', flexShrink: 0 }}>{label}</div>
      <input
        readOnly
        value={value}
        onClick={e => (e.target as HTMLInputElement).select()}
        style={{
          flex: 1, fontFamily: 'monospace', fontSize: 11, background: 'rgba(0,0,0,0.3)',
          border: '1px solid rgba(255,255,255,0.1)', borderRadius: 5, padding: '4px 8px', color: '#60a5fa',
          cursor: 'text',
        }}
      />
      <button
        className="btn btn-gray btn-sm"
        style={{ flexShrink: 0, minWidth: 64 }}
        onClick={() => { navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
      >
        {copied ? '✓' : 'Kopyala'}
      </button>
    </div>
  );
}

// ─── Main dashboard ───────────────────────────────────────────────────────────

export default function DashboardPage() {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const [ytChannels, setYtChannels] = useState<YtChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [syncing, setSyncing] = useState(false);

  const flash = useCallback((msg: string) => {
    setStatus(msg);
    setTimeout(() => setStatus(''), 3500);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [serverInfo, pls, ytChs] = await Promise.all([
        apiFetch<ServerInfo>('/api/server-info'),
        apiFetch<PlaylistSummary[]>('/api/playlists?summary=1'),
        apiFetch<{ channels: YtChannel[] }>('/api/yt-channels').then(d => d.channels || []).catch(() => []),
      ]);
      setInfo(serverInfo);
      setPlaylists(Array.isArray(pls) ? pls : []);
      setYtChannels(ytChs);
    } catch (e: any) {
      flash('Yükleme hatası: ' + e.message);
    } finally {
      setLoading(false);
    }
  }, [flash]);

  useEffect(() => { load(); }, [load]);

  const handleSyncAll = useCallback(async () => {
    setSyncing(true);
    try {
      await apiFetch('/api/playlists/sync-all', { method: 'POST' });
      flash('✓ Tüm playlist\'ler senkronize edildi');
      load();
    } catch (e: any) {
      flash('Hata: ' + e.message);
    } finally {
      setSyncing(false);
    }
  }, [flash, load]);

  const handleClearCache = useCallback(async () => {
    try {
      await apiFetch('/api/cache/clear', { method: 'POST' });
      flash('✓ Cache temizlendi');
      load();
    } catch {
      flash('✓ Yenilendi');
      load();
    }
  }, [flash, load]);

  // Build connection URLs
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const isVercel = info ? !info.canTriggerLocalDeploy : false;
  const xtreamBase = info?.separatePort
    ? origin.replace(/:\d+$/, '') + ':' + info.port
    : origin;
  const m3uUrl = info
    ? `${origin}/api/m3u?username=${encodeURIComponent(info.username)}&password=${encodeURIComponent(info.password)}`
    : '';
  const xtreamUrl = info ? `${xtreamBase}/player_api.php?username=${info.username}&password=${info.password}` : '';
  const totals = totalCounts(playlists);

  return (
    <Shell
      page="dashboard"
      title="Dashboard"
      subtitle={loading ? 'Yükleniyor...' : (status || `${playlists.length} playlist · ${totals.total.toLocaleString()} kanal`)}
    >
      {/* ── Hızlı istatistikler ─────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
        <StatCard label="Playlist" value={playlists.length} sub={`${totals.total.toLocaleString()} kanal toplam`} color="#60a5fa" />
        <StatCard label="Canlı" value={totals.live.toLocaleString()} sub="live kanal" color="#22c55e" />
        <StatCard label="Film" value={totals.movies.toLocaleString()} sub="VOD" color="#f59e0b" />
        <StatCard label="Dizi" value={totals.series.toLocaleString()} sub="seri" color="#a78bfa" />
        {ytChannels.length > 0 && (
          <StatCard label="YT Kanalı" value={ytChannels.length} sub="YouTube proxy" color="#f87171" />
        )}
      </div>

      {/* ── Row 1: Sunucu Durumu + IPTV Bağlantı ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16, marginBottom: 16 }}>

        {/* ── Sunucu Durumu ──────────────────────────────────────────────────── */}
        <div className="card">
          <div className="card-title" style={{ marginBottom: 14 }}>Sunucu Durumu</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ color: '#9ca3af' }}>Platform</span>
              <Badge text={isVercel ? 'Vercel' : 'Yerel'} color={isVercel ? '#60a5fa' : '#22c55e'} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ color: '#9ca3af' }}>Depolama</span>
              <Badge
                text={info?.databaseProvider ? info.databaseProvider : (info?.storage === 'database' ? 'Veritabanı' : 'Dosya')}
                color={info?.hasDatabase ? '#a78bfa' : '#6b7280'}
              />
            </div>
            {info?.databaseHost && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: '#9ca3af' }}>DB Host</span>
                <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#d1d5db' }}>{info.databaseHost}</span>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ color: '#9ca3af' }}>Durum</span>
              <Badge
                text={info?.readOnly ? 'Salt Okunur' : 'Aktif'}
                color={info?.readOnly ? '#f87171' : '#22c55e'}
              />
            </div>
            {info?.readOnlyReason && (
              <div style={{ fontSize: 11, color: '#f87171', background: 'rgba(248,113,113,0.08)', borderRadius: 6, padding: '6px 10px' }}>
                {info.readOnlyReason}
              </div>
            )}
            {info?.linkedVercelProject?.name && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: '#9ca3af' }}>Vercel Proje</span>
                <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#d1d5db' }}>{info.linkedVercelProject.name}</span>
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
            <button className="btn btn-gray btn-sm" onClick={load} disabled={loading}>
              {loading ? 'Yükleniyor...' : '↻ Yenile'}
            </button>
            <button className="btn btn-gray btn-sm" onClick={handleClearCache}>
              Cache Temizle
            </button>
            {!isVercel && (
              <button className="btn btn-primary btn-sm" onClick={handleSyncAll} disabled={syncing}>
                {syncing ? 'Senkronize...' : '⟳ Tümünü Senkronize Et'}
              </button>
            )}
          </div>
          {status && <div style={{ marginTop: 10, fontSize: 12, color: '#22c55e' }}>{status}</div>}
        </div>

        {/* ── IPTV Bağlantı Bilgileri ────────────────────────────────────────── */}
        {info && (
          <div className="card">
            <div className="card-title" style={{ marginBottom: 14 }}>IPTV Bağlantı Bilgileri</div>
            <CopyRow label="Kullanıcı Adı" value={info.username} />
            <CopyRow label="Şifre" value={info.password} />
            <CopyRow label="M3U URL" value={m3uUrl} />
            <CopyRow label="Xtream URL" value={xtreamUrl} />
            {info.separatePort && (
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 6 }}>
                Xtream port: <strong style={{ color: '#d1d5db' }}>{info.port}</strong>
              </div>
            )}
            <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <a href="/editor.html" className="btn btn-gray btn-sm">Editor'e Git</a>
              <a href="/control-panel.html" className="btn btn-gray btn-sm">Kontrol Panel</a>
              <a href="/channels.html" className="btn btn-gray btn-sm">Kanallar</a>
            </div>
          </div>
        )}

      </div>

      {/* ── Row 2: Playlist Listesi (full width) ── */}
      <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-title" style={{ marginBottom: 14 }}>
            Playlist'ler
            <span style={{ fontWeight: 400, fontSize: 12, color: '#6b7280', marginLeft: 8 }}>
              {playlists.length} liste · {totals.total.toLocaleString()} kanal
            </span>
          </div>
          {playlists.length === 0 ? (
            <div style={{ color: '#6b7280', fontSize: 13, textAlign: 'center', padding: '20px 0' }}>
              Henüz playlist yok. <a href="/editor.html" style={{ color: '#60a5fa' }}>Editor'den ekle</a>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {/* Header */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 70px 70px 70px 80px 120px', gap: 8, fontSize: 11, color: '#6b7280', padding: '4px 10px', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                <span>Ad</span><span style={{ textAlign: 'right' }}>Canlı</span><span style={{ textAlign: 'right' }}>Film</span><span style={{ textAlign: 'right' }}>Dizi</span><span style={{ textAlign: 'right' }}>Toplam</span><span style={{ textAlign: 'right' }}>Son Senkron</span>
              </div>
              {playlists.map(pl => {
                const c = pl.counts || { live: 0, movies: 0, series: 0, total: 0 };
                const lastSync = pl.meta?.lastSyncedAt || pl.meta?.lastSyncAttemptAt;
                return (
                  <div
                    key={pl.id}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 70px 70px 70px 80px 120px',
                      gap: 8,
                      padding: '8px 10px',
                      background: 'rgba(255,255,255,0.03)',
                      borderRadius: 7,
                      border: '1px solid rgba(255,255,255,0.06)',
                      fontSize: 13,
                      alignItems: 'center',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                      <span style={{
                        fontSize: 10, fontWeight: 700, background: 'rgba(96,165,250,0.15)',
                        color: '#60a5fa', border: '1px solid rgba(96,165,250,0.3)',
                        borderRadius: 4, padding: '1px 5px', flexShrink: 0,
                      }}>
                        {(pl.type || 'M3U').toUpperCase()}
                      </span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>
                        {pl.name}
                      </span>
                    </div>
                    <span style={{ textAlign: 'right', color: '#22c55e', fontWeight: 600 }}>{c.live > 0 ? c.live.toLocaleString() : '—'}</span>
                    <span style={{ textAlign: 'right', color: '#f59e0b', fontWeight: 600 }}>{c.movies > 0 ? c.movies.toLocaleString() : '—'}</span>
                    <span style={{ textAlign: 'right', color: '#a78bfa', fontWeight: 600 }}>{c.series > 0 ? c.series.toLocaleString() : '—'}</span>
                    <span style={{ textAlign: 'right', fontWeight: 700, color: '#f9fafb' }}>{c.total.toLocaleString()}</span>
                    <span style={{ textAlign: 'right', fontSize: 11, color: '#9ca3af' }}>{relativeTime(lastSync)}</span>
                  </div>
                );
              })}
              {/* Totals row */}
              <div style={{
                display: 'grid', gridTemplateColumns: '1fr 70px 70px 70px 80px 120px',
                gap: 8, padding: '8px 10px',
                borderTop: '1px solid rgba(255,255,255,0.1)',
                fontSize: 13, fontWeight: 800, color: '#f9fafb', marginTop: 4,
              }}>
                <span>TOPLAM</span>
                <span style={{ textAlign: 'right', color: '#22c55e' }}>{totals.live.toLocaleString()}</span>
                <span style={{ textAlign: 'right', color: '#f59e0b' }}>{totals.movies.toLocaleString()}</span>
                <span style={{ textAlign: 'right', color: '#a78bfa' }}>{totals.series.toLocaleString()}</span>
                <span style={{ textAlign: 'right' }}>{totals.total.toLocaleString()}</span>
                <span />
              </div>
            </div>
          )}
        </div>

      {/* ── Row 3: YouTube Kanalları + Hızlı Erişim ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>

        {/* ── YouTube Kanalları ─────────────────────────────────────────────── */}
        {ytChannels.length > 0 && (
          <div className="card">
            <div className="card-title" style={{ marginBottom: 14 }}>
              YouTube Proxy Kanalları
              <span style={{ fontWeight: 400, fontSize: 12, color: '#6b7280', marginLeft: 8 }}>{ytChannels.length} kanal</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {ytChannels.slice(0, 8).map(ch => (
                <div key={ch.id} style={{ fontSize: 13, padding: '5px 8px', background: 'rgba(248,113,113,0.06)', borderRadius: 6, border: '1px solid rgba(248,113,113,0.15)' }}>
                  <span style={{ color: '#f87171', fontWeight: 600 }}>▶</span>{' '}
                  <span style={{ color: '#f9fafb' }}>{ch.name}</span>
                </div>
              ))}
              {ytChannels.length > 8 && (
                <div style={{ fontSize: 12, color: '#6b7280', textAlign: 'center', padding: '4px 0' }}>
                  +{ytChannels.length - 8} daha · <a href="/yt-channels.html" style={{ color: '#60a5fa' }}>Tümünü gör</a>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Hızlı Erişim ─────────────────────────────────────────────────── */}
        <div className="card">
          <div className="card-title" style={{ marginBottom: 14 }}>Hızlı Erişim</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {[
              { href: '/editor.html', label: 'Playlist Editör', icon: 'E', color: '#60a5fa', desc: 'Kanal ekle/düzenle' },
              { href: '/channels.html', label: 'Webplayer', icon: 'C', color: '#22c55e', desc: 'Kanalları izle' },
              { href: '/control-panel.html', label: 'Kontrol Panel', icon: 'K', color: '#f59e0b', desc: 'Stalker/Xtream' },
              { href: '/tv-server.html', label: 'TV Sunucu', icon: 'T', color: '#a78bfa', desc: 'Yayın ayarları' },
              { href: '/yt-channels.html', label: 'YT Kanallar', icon: 'Y', color: '#f87171', desc: 'YouTube proxy' },
            ].map(item => (
              <a
                key={item.href}
                href={item.href}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '10px 12px', borderRadius: 8,
                  background: item.color + '11',
                  border: '1px solid ' + item.color + '33',
                  textDecoration: 'none', transition: 'background 0.15s',
                }}
              >
                <div style={{
                  width: 32, height: 32, borderRadius: 8,
                  background: item.color + '22', border: '1px solid ' + item.color + '44',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontWeight: 800, fontSize: 14, color: item.color, flexShrink: 0,
                }}>
                  {item.icon}
                </div>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 13, color: '#f9fafb' }}>{item.label}</div>
                  <div style={{ fontSize: 11, color: '#6b7280' }}>{item.desc}</div>
                </div>
              </a>
            ))}
          </div>
        </div>

      </div>
    </Shell>
  );
}

const el = document.getElementById('root');
if (el) createRoot(el).render(React.createElement(DashboardPage));
