import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Shell } from './shared/shell'
import { PlaylistData, PlaylistItem, PlaylistRecord, cloneData, countData, createPlaylist, deletePlaylist, emptyData, getPlaylist, getPlaylistCounts, getPlaylistSummaries, publishPlaylist, splitPlaylists, updatePlaylist } from './shared/api'

type Kind = 'live' | 'movies' | 'series'
type WizardSelections = Record<Kind, string[]>
type TransferToast = { message: string; detail?: string; kind: 'success' | 'move' }

const KINDS: Array<{ key: Kind; label: string }> = [
  { key: 'live', label: 'Live TV' },
  { key: 'movies', label: 'Film' },
  { key: 'series', label: 'Dizi' }
]
const NEW_PLAYLIST_TARGET = '__new__'

function ensureGroup(data: PlaylistData, kind: Kind, group: string) { if (!data[kind][group]) data[kind][group] = []; return data[kind][group] }
function emptySelections(): WizardSelections { return { live: [], movies: [], series: [] } }
function firstNonEmptyKind(data: PlaylistData): Kind { if (Object.keys(data.live || {}).length) return 'live'; if (Object.keys(data.movies || {}).length) return 'movies'; return 'series' }
function firstGroupForKind(data: PlaylistData, kind: Kind) { return Object.keys(data[kind] || {})[0] || '' }
function itemKey(group: string, item: PlaylistItem, index: number) { return [group, item.id || '', item.name || '', item.cmd || item.sourceCmd || '', index].join('|') }
function normalizeEndpoint(value: unknown) { const raw = String(value || '').trim(); if (!raw) return ''; try { const parsed = new URL(raw); if ((parsed.protocol === 'http:' && parsed.port === '80') || (parsed.protocol === 'https:' && parsed.port === '443')) parsed.port = ''; parsed.username = ''; parsed.password = ''; parsed.search = ''; parsed.hash = ''; parsed.pathname = parsed.pathname.replace(/\/+$/, ''); return parsed.toString().replace(/\/+$/, '') } catch (_) { return raw.replace(/\/+$/, '') } }
function normalizeIdentityText(value: unknown) { return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ') }
function itemIdentityKey(kind: Kind, item: PlaylistItem) { const meta = item && item.sourceMeta && typeof item.sourceMeta === 'object' ? item.sourceMeta : {}; const sourceType = String(item.sourceType || '').trim() || 'custom'; const endpoint = normalizeEndpoint((meta as any).host || (meta as any).url || (meta as any).portalUrl || ''); const title = normalizeIdentityText(item.name); const cmd = String(item.sourceCmd || item.cmd || '').trim(); if (endpoint && title) return [kind, sourceType, endpoint, title].join('|'); if (cmd) return [kind, sourceType, cmd].join('|'); return [kind, sourceType, item.id || '', title].join('|') }
function dedupeItems(kind: Kind, items: PlaylistItem[]) { const seen = new Set<string>(); const result: PlaylistItem[] = []; (items || []).forEach((item) => { const key = itemIdentityKey(kind, item); if (seen.has(key)) return; seen.add(key); result.push(item) }); return result }
function shouldResolveStalkerCmd(cmd: string) { const value = String(cmd || '').trim(); return !value || /^(?:ffmpeg|ffrt|auto|mpegts)\s+/i.test(value) || value.includes('localhost') || value.includes('127.0.0.1') || value.startsWith('/') }
function extractYouTubeVideoId(url: string) { const value = String(url || '').trim(); const direct = value.match(/^[A-Za-z0-9_-]{11}$/); if (direct) return direct[0]; const proxy = value.match(/(?:^|\/)yt_([A-Za-z0-9_-]{11})(?:[/?#]|$)/); if (proxy) return proxy[1]; try { const parsed = new URL(value); const host = parsed.hostname.toLowerCase().replace(/^(www\.|m\.)/, ''); const parts = parsed.pathname.split('/').filter(Boolean); if (host === 'youtu.be' && /^[A-Za-z0-9_-]{11}$/.test(parts[0] || '')) return parts[0]; if (host === 'youtube.com' || host === 'music.youtube.com' || host === 'youtube-nocookie.com') { const watchId = parsed.searchParams.get('v') || ''; if (/^[A-Za-z0-9_-]{11}$/.test(watchId)) return watchId; if (['embed', 'live', 'shorts', 'v'].includes(parts[0]) && /^[A-Za-z0-9_-]{11}$/.test(parts[1] || '')) return parts[1]; } } catch (_) {} const fallback = value.match(/(?:v=|youtu\.be\/|embed\/|live\/|shorts\/|\/v\/)([A-Za-z0-9_-]{11})/); return fallback ? fallback[1] : '' }
function isYouTubeUrl(url: string) { return !!extractYouTubeVideoId(url) && /(?:youtube\.com|youtu\.be|yt_[A-Za-z0-9_-]{11})/i.test(String(url || '')) }
function buildYouTubeProxyPath(url: string) { const videoId = extractYouTubeVideoId(url); return videoId ? `/proxy/yt_${videoId}` : String(url || '').trim() }
function getItemSourceType(item: PlaylistItem | null | undefined, playlist: PlaylistRecord | null) { return String((item && item.sourceType) || (playlist && playlist.type) || '').trim() }
function getItemSourceMeta(item: PlaylistItem | null | undefined, playlist: PlaylistRecord | null) { const itemMeta = item && item.sourceMeta && typeof item.sourceMeta === 'object' ? item.sourceMeta : null; return cloneData(itemMeta || ((playlist && playlist.meta) || {})) }
function cloneItemForCurated(item: PlaylistItem, sourcePlaylist: PlaylistRecord) { const copy = cloneData(item); copy.sourceType = getItemSourceType(copy, sourcePlaylist); copy.sourceMeta = getItemSourceMeta(copy, sourcePlaylist); copy.sourcePlaylistId = copy.sourcePlaylistId || sourcePlaylist.id; copy.sourcePlaylistName = copy.sourcePlaylistName || sourcePlaylist.name; if (copy.sourceType === 'stalker') { const cmd = String(copy.sourceCmd || copy.cmd || '').trim(); copy.sourceCmd = cmd; copy.cmd = cmd } return copy }
function mergePlaylistRecords(current: PlaylistRecord[], incoming: PlaylistRecord[]) {
  return incoming.map((next) => {
    const existing = current.find((entry) => entry.id === next.id)
    if (!existing || !existing.data) return next
    return Object.assign({}, next, { data: existing.data })
  })
}
function mergePlaylistData(base: PlaylistData, incoming: PlaylistData) {
  const next: PlaylistData = { live: Object.assign({}, base.live || {}), movies: Object.assign({}, base.movies || {}), series: Object.assign({}, base.series || {}) }
  KINDS.forEach(({ key }) => {
    Object.entries(incoming[key] || {}).forEach(([group, items]) => {
      const existing = Array.isArray(next[key][group]) ? (next[key][group] as PlaylistItem[]) : []
      const merged = existing.slice(); merged.push(...cloneData(items || [])); next[key][group] = dedupeItems(key, merged)
    })
  })
  return next
}
function removeSelectedGroupsFromSource(base: PlaylistData, selections: WizardSelections) {
  const next: PlaylistData = { live: Object.assign({}, base.live || {}), movies: Object.assign({}, base.movies || {}), series: Object.assign({}, base.series || {}) }
  KINDS.forEach(({ key }) => { selections[key].forEach((group) => { delete next[key][group] }) })
  return next
}
async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const contentType = String(response.headers.get('content-type') || '')
  const text = await response.text()

  let payload: any = {}
  let parseError: any = null
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch (error) {
      payload = null
      parseError = error
    }
  }

  if (!response.ok) {
    const apiError = payload && typeof payload === 'object' ? (payload.error || payload.message) : ''
    const suffix = text ? ` — ${text.slice(0, 140).replace(/\s+/g, ' ').trim()}` : ''
    throw new Error((apiError ? String(apiError) : `${response.status} ${response.statusText}`) + suffix)
  }

  if (!contentType.includes('application/json')) {
    const suffix = text ? ` — ${text.slice(0, 140).replace(/\s+/g, ' ').trim()}` : ''
    throw new Error(`Beklenen JSON degil (${contentType || 'unknown'})` + suffix)
  }

  if (text && payload === null) {
    throw new Error('JSON parse hatasi: ' + (parseError && parseError.message ? String(parseError.message) : 'invalid JSON'))
  }

  return (payload ?? {}) as T
}
function buildPlayerUrl(url: string, name: string, mac: string, headers: Record<string, string>, options?: { sourceType?: string; portalUrl?: string; resolveCmd?: string; sourceId?: string; streamType?: string; sourceMeta?: Record<string, unknown> }) { let playerUrl = window.location.origin + '/player.html?url=' + encodeURIComponent(url) + '&name=' + encodeURIComponent(name || 'IPTV Stream'); if (mac) playerUrl += '&mac=' + encodeURIComponent(mac); if (headers && Object.keys(headers).length) playerUrl += '&headers=' + encodeURIComponent(JSON.stringify(headers)); if (options && options.sourceType) playerUrl += '&sourceType=' + encodeURIComponent(options.sourceType); if (options && options.portalUrl) playerUrl += '&portalUrl=' + encodeURIComponent(options.portalUrl); if (options && options.resolveCmd) playerUrl += '&resolveCmd=' + encodeURIComponent(options.resolveCmd); if (options && options.sourceId) playerUrl += '&sourceId=' + encodeURIComponent(options.sourceId); if (options && options.streamType) playerUrl += '&streamType=' + encodeURIComponent(options.streamType); if (options && options.sourceMeta) playerUrl += '&sourceMeta=' + encodeURIComponent(JSON.stringify(options.sourceMeta)); return playerUrl }

const SOURCE_TYPE_LABEL: Record<string, string> = { stalker: 'STK', xtream: 'XTR', m3u: 'M3U', external: 'EXT', custom: 'CST' }
const SOURCE_TYPE_CLASS: Record<string, string> = { stalker: 'ic-stalker', xtream: 'ic-xtream', m3u: 'ic-m3u', external: 'ic-external', custom: 'ic-custom' }

function EditorApp() {
  const [playlists, setPlaylists] = useState<PlaylistRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('Hazir')
  const [sourceId, setSourceId] = useState('')
  const [wizardOpen, setWizardOpen] = useState(false)
  const [wizardKind, setWizardKind] = useState<Kind>('live')
  const [wizardName, setWizardName] = useState('')
  const [wizardTargetId, setWizardTargetId] = useState(NEW_PLAYLIST_TARGET)
  const [wizardSelections, setWizardSelections] = useState<WizardSelections>(emptySelections())
  const [wizardSearchQuery, setWizardSearchQuery] = useState('')
  const [wizardTransferMode, setWizardTransferMode] = useState<'copy' | 'move'>('copy')
  const [draggedGroup, setDraggedGroup] = useState('')
  const [dragOverWizardGroup, setDragOverWizardGroup] = useState('')
  const [draggedCuratedGroup, setDraggedCuratedGroup] = useState('')
  const [dragOverCuratedGroup, setDragOverCuratedGroup] = useState('')
  const [draggedChannelIndex, setDraggedChannelIndex] = useState(-1)
  const [dragOverChannelIndex, setDragOverChannelIndex] = useState(-1)
  const [curatedId, setCuratedId] = useState('')
  const [curatedKind, setCuratedKind] = useState<Kind>('live')
  const [curatedGroup, setCuratedGroup] = useState('')
  const [selectedChannelIndex, setSelectedChannelIndex] = useState(0)
  const draftCuratedRef = useRef<PlaylistRecord | null>(null)
  const [draftVersion, setDraftVersion] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [previewUrl, setPreviewUrl] = useState('')
  const [previewLabel, setPreviewLabel] = useState('Webplayer hazir')
  const [previewBusy, setPreviewBusy] = useState(false)
  const [channelQuery, setChannelQuery] = useState('')
  const [channelLimit, setChannelLimit] = useState(300)
  const [transferToast, setTransferToast] = useState<TransferToast | null>(null)
  const [quickAddOpen, setQuickAddOpen] = useState(false)
  const [qaName, setQaName] = useState('')
  const [qaUrl, setQaUrl] = useState('')
  const [qaLogo, setQaLogo] = useState('')
  const [qaCategory, setQaCategory] = useState('')
  const [qaNewCategory, setQaNewCategory] = useState('')
  const [qaAddedCount, setQaAddedCount] = useState(0)
  const [vercelDeploying, setVercelDeploying] = useState(false)
  const [modalState, setModalState] = useState<{ type: 'confirm'; message: string } | { type: 'prompt'; message: string; defaultValue: string } | null>(null)
  const [modalPromptValue, setModalPromptValue] = useState('')
  const modalResolveRef = useRef<((value: any) => void) | null>(null)

  const { sources, curated } = useMemo(() => splitPlaylists(playlists), [playlists])
  const source = sources.find((p) => p.id === sourceId) || sources[0] || null
  const curatedPlaylist = curated.find((p) => p.id === curatedId) || curated[0] || null
  const publishedPlaylist = curated.find((p) => p.meta?.tvPublished) || null
  const wizardTargetPlaylist = wizardTargetId !== NEW_PLAYLIST_TARGET ? curated.find((p) => p.id === wizardTargetId) || null : null
  const draftCurated = draftCuratedRef.current

  useEffect(() => {
    if (!transferToast) return
    const timer = window.setTimeout(() => setTransferToast(null), 5000)
    return () => clearTimeout(timer)
  }, [transferToast])

  useEffect(() => {
    getPlaylistSummaries().then((nextPlaylists) => {
      setPlaylists((current) => mergePlaylistRecords(current, nextPlaylists))
      const split = splitPlaylists(nextPlaylists)
      if (split.sources[0]) setSourceId((current) => current || split.sources[0].id)
      if (split.curated[0]) setCuratedId((current) => current || split.curated[0].id)
    }).catch((error) => setMessage('Yukleme hatasi: ' + error.message)).finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!curatedId) return
    const current = curated.find((p) => p.id === curatedId) || null
    if (!current) return
    if (current.data) {
      const currentCountsTotal = getPlaylistCounts(current).total
      const currentDataTotal = countData(current.data).total
      if (currentDataTotal > 0 || currentCountsTotal === 0) return
    }
    getPlaylist(curatedId)
      .then((full) => { setPlaylists((existing) => existing.map((p) => p.id === full.id ? full : p)) })
      .catch((error) => setMessage('Playlist yukleme hatasi: ' + error.message))
  }, [curatedId, curated])

  useEffect(() => {
    if (!source) return
    setWizardSelections(emptySelections())
    setWizardKind('live')
    setWizardSearchQuery('')
    setWizardName((current) => current.trim() ? current : (source.name + ' Playlist'))
  }, [source?.id])

  useEffect(() => {
    if (!curatedPlaylist) {
      draftCuratedRef.current = null
      setDraftVersion((v) => v + 1); setDirty(false); setPreviewUrl('')
      setPreviewLabel('Webplayer hazir'); setChannelQuery(''); setChannelLimit(300)
      return
    }
    const nextDraft = cloneData(curatedPlaylist)
    const nextKind = Object.keys(nextDraft.data[curatedKind] || {}).length ? curatedKind : firstNonEmptyKind(nextDraft.data)
    draftCuratedRef.current = nextDraft
    setDraftVersion((v) => v + 1); setCuratedKind(nextKind); setCuratedGroup(firstGroupForKind(nextDraft.data, nextKind))
    setSelectedChannelIndex(0); setDirty(false); setPreviewUrl('')
    setPreviewLabel('Kanal secip Webplayer ile test et'); setChannelQuery(''); setChannelLimit(300)
  }, [curatedPlaylist])

  const sourceCounts = source ? getPlaylistCounts(source) : getPlaylistCounts()
  const wizardGroups = source && source.data ? Object.keys(source.data[wizardKind] || {}) : []

  const filteredWizardGroups = useMemo(() => {
    const q = wizardSearchQuery.trim().toLowerCase()
    if (!q) return wizardGroups
    return wizardGroups.filter((g) => g.toLowerCase().includes(q))
  }, [wizardGroups, wizardSearchQuery])

  const selectedGroupsForKind = wizardSelections[wizardKind]
  const wizardCounts = useMemo(() => {
    const counts = { live: 0, movies: 0, series: 0, total: 0 }
    if (!source || !source.data) return counts
    KINDS.forEach(({ key }) => {
      wizardSelections[key].forEach((group) => {
        const items = source.data && source.data[key] ? source.data[key][group] : []
        const amount = Array.isArray(items) ? items.length : 0
        counts[key] += amount; counts.total += amount
      })
    })
    return counts
  }, [source, wizardSelections])
  const selectedCategoryCount = useMemo(() => Object.values(wizardSelections).reduce((sum, entries) => sum + entries.length, 0), [wizardSelections])

  const curatedGroups = draftCurated ? Object.keys(draftCurated.data[curatedKind] || {}) : []
  const curatedItems = draftCurated && curatedGroup ? (draftCurated.data[curatedKind][curatedGroup] || []) : []
  const selectedChannel = curatedItems[selectedChannelIndex] || null
  const selectedChannelSourceType = selectedChannel ? getItemSourceType(selectedChannel, draftCurated) : ''
  const selectedChannelSourceMeta = selectedChannel ? getItemSourceMeta(selectedChannel, draftCurated) : {}
  const draftCounts = useMemo(() => {
    if (!draftCurated) return { live: 0, movies: 0, series: 0, total: 0 }
    return countData(draftCurated.data)
  }, [draftVersion, draftCurated?.id])
  const curatedList = useMemo(() => {
    const query = channelQuery.trim().toLowerCase()
    const total = curatedItems.length
    if (!total) return { rows: [] as Array<{ item: PlaylistItem; index: number }>, total: 0, matched: 0, query }
    if (!query) {
      const cap = Math.min(total, Math.max(1, channelLimit))
      return { rows: Array.from({ length: cap }, (_, index) => ({ item: curatedItems[index], index })), total, matched: total, query }
    }
    const rows: Array<{ item: PlaylistItem; index: number }> = []
    let matched = 0
    for (let index = 0; index < curatedItems.length; index++) {
      const item = curatedItems[index]
      const name = String(item?.name || '').toLowerCase()
      const id = String(item?.id || '').toLowerCase()
      const cmd = String((item?.sourceCmd || item?.cmd) || '').toLowerCase()
      if (name.includes(query) || id.includes(query) || cmd.includes(query)) {
        matched++
        if (rows.length < channelLimit) rows.push({ item, index })
      }
    }
    return { rows, total, matched, query }
  }, [draftVersion, curatedItems, channelQuery, channelLimit])
  const isFilteringChannels = !!curatedList.query

  useEffect(() => {
    if (!curatedItems.length) setSelectedChannelIndex(0)
    else if (selectedChannelIndex > curatedItems.length - 1) setSelectedChannelIndex(0)
  }, [curatedItems.length, selectedChannelIndex])

  async function ensureFullPlaylist(id: string) {
    const current = playlists.find((p) => p.id === id) || null
    if (current && current.data) {
      const currentCountsTotal = getPlaylistCounts(current).total
      const currentDataTotal = countData(current.data).total
      if (currentDataTotal > 0 || currentCountsTotal === 0) return current
    }
    const full = await getPlaylist(id)
    setPlaylists((existing) => existing.map((p) => p.id === full.id ? full : p))
    return full
  }

  async function refreshPlaylists(preferredCuratedId?: string) {
    const nextPlaylists = await getPlaylistSummaries()
    setPlaylists((current) => mergePlaylistRecords(current, nextPlaylists))
    const split = splitPlaylists(nextPlaylists)
    if (split.sources.length) setSourceId((current) => split.sources.some((p) => p.id === current) ? current : split.sources[0].id)
    if (preferredCuratedId) { setCuratedId(preferredCuratedId); return }
    if (split.curated.length) setCuratedId((current) => split.curated.some((p) => p.id === current) ? current : split.curated[0].id)
    else setCuratedId('')
  }

  function updateDraft(mutator: (playlist: PlaylistRecord) => void) {
    const current = draftCuratedRef.current
    if (!current) return
    mutator(current); setDirty(true); setDraftVersion((v) => v + 1)
  }

  async function openWizard() {
    if (!source) { setMessage('Once bir kaynak liste sec'); return }
    const sourceCountsNow = getPlaylistCounts(source)
    const sourceDataTotal = source.data ? countData(source.data).total : 0
    const needsFullSource = !source.data || (sourceCountsNow.total > 0 && sourceDataTotal === 0)
    if (needsFullSource) {
      try { await ensureFullPlaylist(source.id) } catch (error: any) { setMessage('Kaynak yukleme hatasi: ' + error.message); return }
    }
    const nextTargetId = curatedId || NEW_PLAYLIST_TARGET
    const nextTarget = nextTargetId !== NEW_PLAYLIST_TARGET ? curated.find((p) => p.id === nextTargetId) || null : null
    setWizardTargetId(nextTargetId)
    setWizardName(nextTarget ? nextTarget.name : (source.name + ' Playlist'))
    setWizardSearchQuery('')
    setWizardOpen(true)
  }

  const closeWizard = useCallback(() => {
    setWizardOpen(false); setDraggedGroup(''); setDragOverWizardGroup('')
  }, [])

  const clearWizard = useCallback(() => {
    setWizardSelections(emptySelections())
    setWizardSearchQuery('')
  }, [])

  const toggleWizardCategory = useCallback((kind: Kind, group: string, checked: boolean) => {
    setWizardSelections((current) => ({ ...current, [kind]: checked ? current[kind].concat(group) : current[kind].filter((e) => e !== group) }))
  }, [])

  function insertSelectedGroup(kind: Kind, group: string, targetGroup?: string) {
    setWizardSelections((current) => {
      const next = current[kind].slice()
      const existingIndex = next.indexOf(group)
      if (existingIndex !== -1) next.splice(existingIndex, 1)
      if (targetGroup) {
        const targetIndex = next.indexOf(targetGroup)
        if (targetIndex !== -1) next.splice(targetIndex, 0, group)
        else next.push(group)
      } else { next.push(group) }
      return { ...current, [kind]: next }
    })
  }

  function reorderSelectedGroup(kind: Kind, targetGroup: string) {
    if (!draggedGroup) return
    insertSelectedGroup(kind, draggedGroup, targetGroup)
  }

  function reorderCuratedGroups(targetGroup: string) {
    if (!draftCurated || !draggedCuratedGroup || draggedCuratedGroup === targetGroup) return
    let didReorder = false
    updateDraft((playlist) => {
      const entries = Object.entries(playlist.data[curatedKind] || {})
      const fromIndex = entries.findIndex((e) => e[0] === draggedCuratedGroup)
      const toIndex = entries.findIndex((e) => e[0] === targetGroup)
      if (fromIndex === -1 || toIndex === -1) return
      didReorder = true
      const moved = entries.splice(fromIndex, 1)[0]
      entries.splice(toIndex, 0, moved)
      playlist.data[curatedKind] = Object.fromEntries(entries)
    })
    if (didReorder) setCuratedGroup(draggedCuratedGroup)
    setDraggedCuratedGroup(''); setDragOverCuratedGroup('')
  }

  function reorderCuratedChannels(targetIndex: number) {
    if (isFilteringChannels) return
    if (!draftCurated || !curatedGroup || draggedChannelIndex < 0 || draggedChannelIndex === targetIndex) return
    updateDraft((playlist) => {
      const items = ensureGroup(playlist.data, curatedKind, curatedGroup)
      if (draggedChannelIndex >= items.length || targetIndex >= items.length) return
      const moved = items.splice(draggedChannelIndex, 1)[0]
      items.splice(targetIndex, 0, moved)
    })
    setSelectedChannelIndex(targetIndex)
    setDraggedChannelIndex(-1); setDragOverChannelIndex(-1)
  }

  async function applyWizardSelection() {
    if (!source) { setMessage('Once kaynak liste sec'); return }
    if (!wizardCounts.total) { setMessage('Aktarmak icin en az bir alt kategori sec'); return }
    try {
      const fullSource = await ensureFullPlaylist(source.id)
      const previewData = emptyData()
      if (fullSource.data) {
        KINDS.forEach(({ key }) =>
          wizardSelections[key].forEach((group) => {
            previewData[key][group] = dedupeItems(key, cloneData(fullSource.data![key][group] || []).map((item) => cloneItemForCurated(item, fullSource)))
          })
        )
      }
      const previewCounts = countData(previewData)
      if (!previewCounts.total) { setMessage('Aktarmak icin en az bir alt kategori sec'); return }

      const shouldMove = wizardTransferMode === 'move'
      const totalCats = selectedCategoryCount

      const buildDetail = () => {
        const parts: string[] = []
        if (wizardCounts.live > 0) parts.push(`Live: ${wizardCounts.live.toLocaleString()}`)
        if (wizardCounts.movies > 0) parts.push(`Film: ${wizardCounts.movies.toLocaleString()}`)
        if (wizardCounts.series > 0) parts.push(`Dizi: ${wizardCounts.series.toLocaleString()}`)
        return parts.join(' · ')
      }

      if (wizardTargetId !== NEW_PLAYLIST_TARGET) {
        const targetSummary = curated.find((p) => p.id === wizardTargetId) || null
        if (!targetSummary) throw new Error('Hedef playlist bulunamadi')
        const fullTarget = await ensureFullPlaylist(targetSummary.id)
        const mergedData = mergePlaylistData(fullTarget.data || emptyData(), previewData)
        const saved = await updatePlaylist(fullTarget.id, { name: fullTarget.name, data: mergedData, meta: Object.assign({}, fullTarget.meta || {}, { playlistBucket: 'curated' }) })
        setPlaylists((existing) => existing.map((p) => p.id === saved.id ? saved : p))

        if (shouldMove) {
          const remainingSourceData = removeSelectedGroupsFromSource(fullSource.data || emptyData(), wizardSelections)
          const updatedSource = await updatePlaylist(fullSource.id, { name: fullSource.name, data: remainingSourceData, meta: fullSource.meta || {} })
          setPlaylists((existing) => existing.map((p) => p.id === updatedSource.id ? updatedSource : p))
        }

        const nextKind = Object.keys(previewData[wizardKind] || {}).length ? wizardKind : firstNonEmptyKind(mergedData)
        const preferredGroup = wizardSelections[nextKind][0] || firstGroupForKind(mergedData, nextKind)
        await refreshPlaylists(saved.id)
        setCuratedId(saved.id); setCuratedKind(nextKind); setCuratedGroup(preferredGroup); setSelectedChannelIndex(0)
        closeWizard(); clearWizard()
        setTransferToast({
          message: `${totalCats} kategori — ${wizardCounts.total.toLocaleString()} icerik "${saved.name}" playlistine ${shouldMove ? 'tasindi' : 'kopyalandi'}`,
          detail: buildDetail(),
          kind: shouldMove ? 'move' : 'success'
        })
        setMessage(`'${fullSource.name}' → '${saved.name}': ${totalCats} kategori ${shouldMove ? 'tasindi' : 'kopyalandi'}.`)
        window.setTimeout(() => document.getElementById('curated-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80)
        return
      }

      const name = wizardName.trim() || (fullSource.name + ' Playlist')
      const created = await createPlaylist({ name, type: 'custom', data: previewData, meta: { playlistBucket: 'curated' } })
      setPlaylists((existing) => existing.some((p) => p.id === created.id) ? existing.map((p) => p.id === created.id ? created : p) : existing.concat(created))

      if (shouldMove) {
        const remainingSourceData = removeSelectedGroupsFromSource(fullSource.data || emptyData(), wizardSelections)
        const updatedSource = await updatePlaylist(fullSource.id, { name: fullSource.name, data: remainingSourceData, meta: fullSource.meta || {} })
        setPlaylists((existing) => existing.map((p) => p.id === updatedSource.id ? updatedSource : p))
      }

      const nextKind = firstNonEmptyKind(previewData)
      await refreshPlaylists(created.id)
      setCuratedId(created.id); setCuratedKind(nextKind); setCuratedGroup(firstGroupForKind(previewData, nextKind)); setSelectedChannelIndex(0)
      closeWizard(); clearWizard()
      setTransferToast({
        message: `"${created.name}" olusturuldu — ${totalCats} kategori, ${wizardCounts.total.toLocaleString()} icerik ${shouldMove ? 'taşindi' : 'aktarildi'}`,
        detail: buildDetail(),
        kind: shouldMove ? 'move' : 'success'
      })
      setMessage(`'${created.name}' olusturuldu, ${totalCats} kategori ${shouldMove ? 'tasindi' : 'kopyalandi'}.`)
      window.setTimeout(() => document.getElementById('curated-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80)
    } catch (error: any) { setMessage('Playlist aktarim hatasi: ' + error.message) }
  }

  async function createEmptyCuratedPlaylist() {
    const name = await showPromptModal('Bos playlist adi', 'Benim Playlistim')
    if (!name) return
    try {
      const created = await createPlaylist({ name, type: 'custom', data: emptyData(), meta: { playlistBucket: 'curated' } })
      await refreshPlaylists(created.id)
      setCuratedId(created.id); setCuratedKind('live'); setCuratedGroup(''); setSelectedChannelIndex(0)
      setMessage(`'${created.name}' olusturuldu.`)
    } catch (error: any) { setMessage('Bos playlist olusturma hatasi: ' + error.message) }
  }

  async function handleDeleteCuratedPlaylist() {
    if (!draftCurated) return
    if (!await showConfirmModal(`'${draftCurated.name}' playlistini silmek istiyor musun?`)) return
    try { await deletePlaylist(draftCurated.id); setPreviewUrl(''); await refreshPlaylists(); setMessage(`'${draftCurated.name}' silindi`) } catch (error: any) { setMessage('Silme hatasi: ' + error.message) }
  }

  async function saveDraft() {
    if (!draftCurated) return
    try {
      const saved = await updatePlaylist(draftCurated.id, { name: draftCurated.name, data: draftCurated.data, meta: draftCurated.meta || {} })
      setPlaylists((existing) => existing.some((p) => p.id === saved.id) ? existing.map((p) => p.id === saved.id ? saved : p) : existing.concat(saved))
      draftCuratedRef.current = cloneData(saved); setDraftVersion((v) => v + 1)
      await refreshPlaylists(saved.id); setCuratedId(saved.id)
      setMessage(`'${saved.name}' kaydedildi — Vercel'de de gorunur ✓`)
      setDirty(false)
    } catch (error: any) { setMessage('Kaydetme hatasi: ' + error.message) }
  }

  async function publishDraft() {
    if (!draftCurated) return
    try {
      const targetId = draftCurated.id
      // Always save the latest draft data before publishing to ensure DB is current
      const saved = await updatePlaylist(targetId, { name: draftCurated.name, data: draftCurated.data, meta: draftCurated.meta || {} })
      setPlaylists((existing) => existing.some((p) => p.id === saved.id) ? existing.map((p) => p.id === saved.id ? saved : p) : existing.concat(saved))
      draftCuratedRef.current = cloneData(saved); setDraftVersion((v) => v + 1); setDirty(false)
      await publishPlaylist(targetId); await refreshPlaylists(targetId)
      const playlistName = draftCuratedRef.current?.name || draftCurated.name || 'Playlist'
      setMessage(`${playlistName} TV'ye yayinlandi — Vercel ve localhost:8080 uzerinden aktif ✓`)
    } catch (error: any) { setMessage('TV yayin hatasi: ' + error.message) }
  }

  async function triggerVercelDeploy() {
    if (vercelDeploying) return
    setVercelDeploying(true)
    setMessage('Vercel deploy baslatiliyor...')
    try {
      const result = await requestJson<{ ok: boolean; deploymentUrl?: string }>('/api/deploy/vercel', { method: 'POST' })
      setMessage('Vercel deploy tamamlandi' + (result.deploymentUrl ? ' — ' + result.deploymentUrl : '') + ' ✓')
    } catch (error: any) {
      setMessage('Vercel deploy hatasi: ' + error.message)
    } finally {
      setVercelDeploying(false)
    }
  }

  function openQuickAdd() {
    setQaName('')
    setQaUrl('')
    setQaLogo('')
    const fallbackGroup = curatedGroups[0] || ''
    setQaCategory(curatedGroup || fallbackGroup || '')
    setQaNewCategory('')
    setQaAddedCount(0)
    setQuickAddOpen(true)
  }

  function closeQuickAdd() {
    setQuickAddOpen(false)
  }

  function handleQuickAddChannel() {
    if (!draftCurated) return
    const name = qaName.trim()
    if (!name) return
    const targetCat = qaCategory === '__new__'
      ? qaNewCategory.trim()
      : (qaCategory.trim() || qaNewCategory.trim())
    if (!targetCat) return
    const originalUrl = qaUrl.trim()
    const streamCmd = isYouTubeUrl(originalUrl) ? buildYouTubeProxyPath(originalUrl) : originalUrl
    updateDraft((playlist) => {
      ensureGroup(playlist.data, curatedKind, targetCat).push({
        id: String(Date.now()),
        name,
        logo: qaLogo.trim() || '',
        cmd: streamCmd,
        sourceCmd: streamCmd,
        sourceType: isYouTubeUrl(originalUrl) ? 'external' : 'custom',
        sourceMeta: isYouTubeUrl(originalUrl) ? { originalUrl, providerLabel: 'YouTube Proxy' } : {}
      })
    })
    setCuratedGroup(targetCat)
    if (qaCategory !== targetCat) setQaCategory(targetCat)
    setQaName('')
    setQaUrl('')
    setQaLogo('')
    setQaAddedCount((c) => c + 1)
  }

  function showConfirmModal(message: string): Promise<boolean> {
    return new Promise((resolve) => {
      modalResolveRef.current = resolve
      setModalState({ type: 'confirm', message })
    })
  }

  function showPromptModal(message: string, defaultValue = ''): Promise<string | null> {
    return new Promise((resolve) => {
      modalResolveRef.current = resolve
      setModalPromptValue(defaultValue)
      setModalState({ type: 'prompt', message, defaultValue })
    })
  }

  function handleModalConfirm() {
    const resolve = modalResolveRef.current
    const isPrompt = modalState?.type === 'prompt'
    setModalState(null)
    modalResolveRef.current = null
    if (resolve) resolve(isPrompt ? modalPromptValue : true)
  }

  function handleModalCancel() {
    const resolve = modalResolveRef.current
    const isPrompt = modalState?.type === 'prompt'
    setModalState(null)
    modalResolveRef.current = null
    if (resolve) resolve(isPrompt ? null : false)
  }

  const handleCreateCategory = useCallback(async () => {
    const name = await showPromptModal('Yeni kategori adi', '')
    if (!name) return
    updateDraft((playlist) => { ensureGroup(playlist.data, curatedKind, name) }); setCuratedGroup(name)
  }, [curatedKind])

  const handleRenameCategory = useCallback(async (group: string) => {
    const next = await showPromptModal('Kategori adi', group)
    if (!next || next === group) return
    updateDraft((playlist) => { playlist.data[curatedKind][next] = playlist.data[curatedKind][group] || []; delete playlist.data[curatedKind][group] })
    setCuratedGroup(next)
  }, [curatedKind])

  const handleDeleteCategory = useCallback((group: string) => {
    updateDraft((playlist) => { delete playlist.data[curatedKind][group] })
    if (curatedGroup === group) { setCuratedGroup(''); setSelectedChannelIndex(0) }
  }, [curatedKind, curatedGroup])

  function pushManualChannel(sourceType: string) {
    if (!curatedGroup) return
    updateDraft((playlist) => {
      ensureGroup(playlist.data, curatedKind, curatedGroup).push({
        id: String(Date.now()), name: sourceType === 'external' ? 'Yeni Harici Video' : 'Yeni Kanal',
        logo: '', cmd: '', sourceCmd: '', sourceType,
        sourceMeta: sourceType === 'external' ? { providerLabel: 'Manuel kaynak' } : {}
      })
    })
    setSelectedChannelIndex(curatedItems.length)
  }
  const handleCreateChannel = useCallback(() => pushManualChannel('custom'), [curatedGroup, curatedKind])
  const handleCreateExternalChannel = useCallback(() => pushManualChannel('external'), [curatedGroup, curatedKind])

  function updateSelectedChannel(mutator: (item: PlaylistItem) => void) {
    if (!draftCurated || !curatedGroup || !selectedChannel) return
    updateDraft((playlist) => mutator(ensureGroup(playlist.data, curatedKind, curatedGroup)[selectedChannelIndex]))
  }

  async function playChannelItem(item: PlaylistItem, idx: number) {
    if (!draftCurated) return
    const sourceType = getItemSourceType(item, draftCurated)
    const sourceMeta = getItemSourceMeta(item, draftCurated)
    const previewSourceMeta = Object.assign({}, sourceMeta || {}) as Record<string, unknown>
    let rawCmd = String(item.sourceCmd || item.cmd || '').trim()
    const originalCmd = rawCmd
    if (isYouTubeUrl(originalCmd) && !String(previewSourceMeta.originalUrl || '').trim()) previewSourceMeta.originalUrl = originalCmd
    if (isYouTubeUrl(rawCmd)) rawCmd = buildYouTubeProxyPath(rawCmd)
    const rawId = String(item.id || '').trim()
    if (!rawCmd && !((sourceType === 'stalker' || sourceType === 'xtream') && curatedKind === 'series' && rawId)) return
    try {
      setPreviewBusy(true); setPreviewLabel('Yayin hazirlaniyor...')
      let targetUrl = rawCmd; let mac = ''; let headers: Record<string, string> = {}
      const needsResolve =
        (sourceType === 'stalker' && typeof sourceMeta.url === 'string' && typeof sourceMeta.mac === 'string' && (curatedKind !== 'live' || shouldResolveStalkerCmd(rawCmd))) ||
        (sourceType === 'xtream' && curatedKind === 'series' && typeof sourceMeta.host === 'string')
      if (needsResolve) {
        const resolved = await requestJson<{ streamUrl: string; playbackHeaders?: Record<string, string> }>('/api/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ portalUrl: sourceMeta.url, mac: sourceMeta.mac, cmd: rawCmd, itemId: rawId, type: curatedKind, sourceType, sourceMeta }) })
        targetUrl = resolved.streamUrl; mac = String(sourceMeta.mac || ''); headers = resolved.playbackHeaders || {}
      } else if (sourceType === 'stalker' && typeof sourceMeta.mac === 'string') mac = String(sourceMeta.mac || '')
      setSelectedChannelIndex(idx)
      setPreviewUrl(buildPlayerUrl(targetUrl, item.name || 'IPTV Stream', mac, headers, { sourceType, portalUrl: typeof sourceMeta.url === 'string' ? sourceMeta.url : '', resolveCmd: rawCmd, sourceId: rawId, streamType: curatedKind, sourceMeta: previewSourceMeta }))
      setPreviewLabel((item.name || 'Kanal') + ' oynatiliyor')
    } catch (error: any) { setPreviewUrl(''); setPreviewLabel('Player hatasi: ' + (error as any).message) } finally { setPreviewBusy(false) }
  }

  async function playSelectedChannel() {
    if (!selectedChannel || !draftCurated) return
    await playChannelItem(selectedChannel, selectedChannelIndex)
  }

  // Video bitince otomatik sonraki kanala gec
  const playNextChannelRef = useRef<() => void>(() => {})
  useEffect(() => {
    playNextChannelRef.current = () => {
      if (!draftCurated) return
      const items = draftCurated.data[curatedKind]?.[curatedGroup] || []
      if (!items.length) return
      const nextIdx = (selectedChannelIndex + 1) % items.length
      const nextItem = items[nextIdx]
      if (nextItem) void playChannelItem(nextItem, nextIdx)
    }
  })

  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      if (e.data && e.data.type === 'video-ended') {
        playNextChannelRef.current()
      }
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [])

  return (
    <Shell page="editor" title="Playlist Studio" subtitle="Kaynak sec · Sihirbaz ile playlist olustur · Editor ile duzenle · Webplayer ile test et" status={dirty ? '● Kaydedilmemis' : '● Canli'}>

      {transferToast && (
        <div className={'transfer-toast transfer-toast-' + transferToast.kind} onClick={() => setTransferToast(null)}>
          <div className="transfer-toast-icon">{transferToast.kind === 'move' ? '↗' : '✓'}</div>
          <div className="transfer-toast-body">
            <div className="transfer-toast-msg">{transferToast.message}</div>
            {transferToast.detail && <div className="transfer-toast-detail">{transferToast.detail}</div>}
          </div>
          <button className="transfer-toast-close" onClick={() => setTransferToast(null)}>✕</button>
        </div>
      )}

      <div className="studio-grid studio-grid-editor">

        {/* ── SOURCE PANEL ── */}
        <div className="card studio-panel studio-source-panel">
          <div className="studio-panel-head">
            <div>
              <div className="card-title"><span className="icon-badge ic-stalker">K</span>Import Kaynaklar</div>
              <div className="section-copy">Kaynagi sec, sihirbaz ile playlist olustur veya mevcut playliste kategori ekle.</div>
            </div>
            <button className="btn btn-primary btn-sm" onClick={() => { void openWizard() }} disabled={!source}>
              ⚡ Sihirbaz
            </button>
          </div>
          <div className="studio-source-list">
            {sources.map((playlist) => {
              const totals = getPlaylistCounts(playlist)
              return (
                <button key={playlist.id} className={'studio-playlist-card' + (source?.id === playlist.id ? ' active' : '')} onClick={() => setSourceId(playlist.id)}>
                  <div className="studio-playlist-card-top">
                    <strong>{playlist.name}</strong>
                    <span className={'studio-pill studio-pill-type-' + playlist.type}>{playlist.type.toUpperCase()}</span>
                  </div>
                  <div className="studio-meta-line">{totals.total.toLocaleString()} icerik</div>
                  <div className="studio-mini-stats">
                    <span className="mini-stat-live">▶ {totals.live.toLocaleString()}</span>
                    <span className="mini-stat-movies">◉ {totals.movies.toLocaleString()}</span>
                    <span className="mini-stat-series">◈ {totals.series.toLocaleString()}</span>
                  </div>
                </button>
              )
            })}
            {!sources.length && <div className="empty">Kaynak yok. Kontrol panelinden ekle.</div>}
          </div>
        </div>

        {/* ── EDITOR PANEL ── */}
        <div className="card studio-panel studio-editor-shell" id="curated-editor">
          <div className="studio-panel-head">
            <div>
              <div className="card-title"><span className="icon-badge ic-editor">E</span>Playlist Editoru</div>
              <div className="section-copy">Sihirbazdan gelen playlist burada acilir. Kategori ve kanal yonetimi, webplayer test.</div>
            </div>
            <div className="studio-pill">{curated.length} kurgu playlist</div>
          </div>

          <div className="studio-editor-topbar">
            <div className="field studio-editor-select">
              <label>Acik Playlist</label>
              <select value={curatedId} onChange={(e) => setCuratedId(e.target.value)}>
                <option value="">Playlist sec...</option>
                {curated.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div className="studio-toolbar">
              <button className="btn btn-gray btn-sm" onClick={() => { void openWizard() }} disabled={!source}>+ Kaynaktan Ekle</button>
              <button className="btn btn-gray btn-sm" onClick={createEmptyCuratedPlaylist}>+ Bos Playlist</button>
              <button className="btn btn-red btn-sm" onClick={handleDeleteCuratedPlaylist} disabled={!draftCurated}>Sil</button>
              <button className="btn btn-green btn-sm" onClick={saveDraft} disabled={!draftCurated || !dirty} title="Kaydedilen veri Vercel'de de gorunur — ayni veritabani">Kaydet ☁</button>
              <button className="btn btn-primary btn-sm" onClick={publishDraft} disabled={!draftCurated} title="Hem localhost:8080 hem Vercel uzerinden yayinlanir">▶ TV Yayini</button>
              <button className="btn btn-gray btn-sm" onClick={triggerVercelDeploy} disabled={vercelDeploying} title="Vercel'e yeni deployment gonder (kod degisikligi icin)" style={{ opacity: .75 }}>{vercelDeploying ? '⏳ Deploy...' : '☁ Vercel Deploy'}</button>
            </div>
          </div>

          {draftCurated ? (
            <>
              <div className="studio-editor-banner">
                <div>
                  <div className="studio-editor-title">{draftCurated.name || 'Kurgu Playlist'}</div>
                  <div className="section-copy">{publishedPlaylist?.id === draftCurated.id ? "Bu playlist su anda TV'de yayinlaniyor." : "Editor modunda. Kaydet ve tek tusla TV'ye yayinla."}</div>
                </div>
                <div className="studio-badge-row">
                  <span className={'editor-tag' + (draftCurated.meta?.tvPublished ? ' editor-tag-live' : ' editor-tag-muted')}>{draftCurated.meta?.tvPublished ? '● TV Yayininda' : '○ Taslak'}</span>
                  <span className="editor-tag">{draftCounts.total.toLocaleString()} icerik</span>
                  {dirty && <span className="editor-tag editor-tag-warn">● Kaydedilmemis</span>}
                </div>
              </div>

              <div className="studio-field-grid studio-field-grid-wide">
                <div className="field">
                  <label>Playlist Adi</label>
                  <input type="text" value={draftCurated.name || ''} onChange={(e) => updateDraft((p) => { p.name = e.target.value })} />
                </div>
                <div className="field">
                  <label>Icerik Tipi</label>
                  <div className="studio-kind-tabs">
                    {KINDS.map((kind) => (
                      <button key={kind.key} className={'btn btn-sm ' + (curatedKind === kind.key ? 'btn-primary' : 'btn-gray')} onClick={() => setCuratedKind(kind.key)}>
                        {kind.label} <span className="kind-count">({draftCounts[kind.key].toLocaleString()})</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="studio-editor-grid studio-editor-grid-wide">

                {/* CATEGORIES */}
                <div className="studio-subpanel">
                  <div className="studio-section-head">
                    <div><div className="sidebar-label">Kategoriler</div><div className="section-copy">Surukle ile sirala.</div></div>
                    <button className="btn btn-gray btn-sm" onClick={handleCreateCategory}>+ Kategori</button>
                  </div>
                  <div className="studio-scroll studio-scroll-editor">
                    {curatedGroups.map((group) => (
                      <div
                        key={group}
                        className={'studio-group-row studio-group-row-rich studio-draggable-row' + (curatedGroup === group ? ' active' : '') + (dragOverCuratedGroup === group && draggedCuratedGroup !== group ? ' drag-target-active' : '')}
                        draggable
                        onDragStart={() => setDraggedCuratedGroup(group)}
                        onDragOver={(e) => { e.preventDefault(); setDragOverCuratedGroup(group) }}
                        onDragLeave={() => setDragOverCuratedGroup('')}
                        onDrop={() => reorderCuratedGroups(group)}
                      >
                        <span className="studio-drag-handle">⠿</span>
                        <button className="studio-link-button" onClick={() => { setCuratedGroup(group); setSelectedChannelIndex(0) }}>
                          <span className="studio-row-main">
                            <strong>{group}</strong>
                            <span className="muted">{(draftCurated.data[curatedKind][group] || []).length.toLocaleString()} kanal</span>
                          </span>
                        </button>
                        <div className="studio-inline-actions">
                          <button className="btn btn-gray btn-sm" onClick={() => handleRenameCategory(group)} title="Yeniden Adlandir">↩</button>
                          <button className="btn btn-red btn-sm" onClick={() => handleDeleteCategory(group)} title="Sil">✕</button>
                        </div>
                      </div>
                    ))}
                    {!curatedGroups.length && <div className="empty">Bu tipte kategori yok</div>}
                  </div>
                </div>

                {/* CHANNEL LIST */}
                <div className="studio-subpanel">
                  <div className="studio-section-head">
                    <div>
                      <div className="sidebar-label">Kanal Listesi</div>
                      <div className="section-copy">{curatedGroup ? `${curatedGroup}${isFilteringChannels ? ' — Arama Acik' : ''}` : 'Once kategori sec'}</div>
                    </div>
                    <button className="btn btn-primary btn-sm" onClick={openQuickAdd} disabled={!draftCurated || !curatedGroup}>⊕ Kanal Ekle</button>
                  </div>

                  {!curatedGroup ? (
                    <div className="studio-empty-large">Kategori secildiginde kanal listesi burada gorunur.</div>
                  ) : (
                    <>
                      <div className="studio-field-grid studio-field-grid-wide">
                        <div className="field">
                          <label>Kanal Ara</label>
                          <input type="text" value={channelQuery} placeholder="Isim / ID / URL..." onChange={(e) => { setChannelQuery(e.target.value); setChannelLimit(300) }} />
                        </div>
                        <div className="field">
                          <label>Gosterim</label>
                          <div className="studio-static-field">
                            <strong>{curatedList.rows.length.toLocaleString()} / {(isFilteringChannels ? curatedList.matched : curatedList.total).toLocaleString()}</strong>
                            <span>{isFilteringChannels ? `${curatedList.total.toLocaleString()} toplam` : 'kanal'}</span>
                          </div>
                        </div>
                      </div>
                      <div className="studio-scroll studio-scroll-editor">
                        {curatedList.rows.map(({ item, index }) => (
                          <div
                            key={itemKey(curatedGroup, item, index)}
                            className={'studio-group-row studio-group-row-rich studio-draggable-row channel-row' + (selectedChannelIndex === index ? ' active' : '') + (dragOverChannelIndex === index && draggedChannelIndex !== index ? ' drag-target-active' : '')}
                            draggable={!isFilteringChannels}
                            onDragStart={() => { if (!isFilteringChannels) setDraggedChannelIndex(index) }}
                            onDragOver={(e) => { if (!isFilteringChannels) { e.preventDefault(); setDragOverChannelIndex(index) } }}
                            onDragLeave={() => setDragOverChannelIndex(-1)}
                            onDrop={() => reorderCuratedChannels(index)}
                          >
                            <span className="studio-drag-handle">⠿</span>
                            <button className="studio-link-button" onClick={() => setSelectedChannelIndex(index)}>
                              <span className="studio-row-main">
                                <strong>{item.name || 'Yeni Kanal'}</strong>
                                <span className="muted channel-meta-url">
                                  {item.id || item.sourceCmd || item.cmd || ''}
                                </span>
                              </span>
                            </button>
                            {item.sourceType && (
                              <span className={'source-type-badge ' + (SOURCE_TYPE_CLASS[item.sourceType] || 'ic-custom')}>
                                {SOURCE_TYPE_LABEL[item.sourceType] || item.sourceType.slice(0, 3).toUpperCase()}
                              </span>
                            )}
                            <button
                              className="btn btn-red btn-sm"
                              style={{ padding: '1px 6px', fontSize: 11, flexShrink: 0 }}
                              title="Kanali sil"
                              onClick={(e) => {
                                e.stopPropagation()
                                updateDraft((playlist) => {
                                  const arr = playlist.data[curatedKind][curatedGroup] || []
                                  playlist.data[curatedKind][curatedGroup] = arr.filter((_, i) => i !== index)
                                })
                                if (selectedChannelIndex === index) setSelectedChannelIndex(-1)
                              }}
                            >✕</button>
                          </div>
                        ))}
                        {!curatedItems.length && <div className="empty">Bu kategoride kanal yok</div>}
                        {isFilteringChannels && curatedItems.length > 0 && !curatedList.matched ? <div className="empty">Arama sonucu bulunamadi</div> : null}
                      </div>
                      <div className="studio-toolbar">
                        <button className="btn btn-gray btn-sm" onClick={() => { setChannelQuery(''); setChannelLimit(300) }} disabled={!channelQuery && channelLimit === 300}>Sifirla</button>
                        {(isFilteringChannels ? curatedList.matched > curatedList.rows.length : curatedList.total > curatedList.rows.length) && (
                          <button className="btn btn-gray btn-sm" onClick={() => setChannelLimit((v) => v + 300)}>+300 Daha</button>
                        )}
                      </div>
                    </>
                  )}
                </div>

                {/* CHANNEL EDITOR + PLAYER */}
                <div className="studio-subpanel studio-subpanel-editor">
                  <div className="studio-section-head">
                    <div>
                      <div className="sidebar-label">Kanal Editoru + Player</div>
                      <div className="section-copy">{selectedChannel ? 'Secili kanali duzenle ve asagida test et.' : 'Listeden kanal sec.'}</div>
                    </div>
                    <button className="btn btn-primary btn-sm" onClick={playSelectedChannel} disabled={!selectedChannel || previewBusy}>
                      {previewBusy ? '⏳ Hazirlaniyor' : '▶ Player'}
                    </button>
                  </div>

                  {!selectedChannel ? (
                    <div className="studio-empty-large">
                      <strong>Kanal secilmedi</strong>
                      <span>Sol listeden kanal sec, burada duzenle ve player ile test et.</span>
                    </div>
                  ) : (
                    <>
                      <div className="studio-channel-card studio-channel-card-wide">
                        <div className="studio-field-grid studio-field-grid-wide">
                          <div className="field">
                            <label>Kanal Adi</label>
                            <input type="text" value={selectedChannel.name || ''} onChange={(e) => updateSelectedChannel((item) => { item.name = e.target.value })} />
                          </div>
                          <div className="field">
                            <label>Kanal ID</label>
                            <input type="text" value={selectedChannel.id || ''} onChange={(e) => updateSelectedChannel((item) => { item.id = e.target.value })} />
                          </div>
                        </div>
                        <div className="studio-field-grid studio-field-grid-wide">
                          <div className="field">
                            <label>Kaynak Tipi</label>
                            <select value={selectedChannelSourceType || 'custom'} onChange={(e) => updateSelectedChannel((item) => { item.sourceType = e.target.value; if (e.target.value === 'external') item.sourceMeta = Object.assign({}, item.sourceMeta || {}, { providerLabel: (item.sourceMeta && item.sourceMeta.providerLabel) || 'Manuel kaynak' }) })}>
                              <option value="custom">Manuel / Genel</option>
                              <option value="external">Harici Video</option>
                              <option value="stalker">Stalker Portal</option>
                              <option value="xtream">Xtream</option>
                              <option value="m3u">M3U</option>
                            </select>
                          </div>
                          <div className="field">
                            <label>Logo URL</label>
                            <input type="text" value={selectedChannel.logo || ''} onChange={(e) => updateSelectedChannel((item) => { item.logo = e.target.value })} />
                          </div>
                        </div>
                        {selectedChannelSourceType === 'external' && (
                          <div className="field">
                            <label>Kaynak Etiketi</label>
                            <input type="text" value={String(selectedChannelSourceMeta.providerLabel || '')} onChange={(e) => updateSelectedChannel((item) => { item.sourceMeta = Object.assign({}, item.sourceMeta || {}, { providerLabel: e.target.value }) })} />
                          </div>
                        )}
                        <div className="field">
                          <label className="channel-url-label">
                            {selectedChannelSourceType === 'stalker' ? '⚙ Portal CMD' : selectedChannelSourceType === 'external' ? '🔗 Video URL' : '▶ Stream URL'}
                          </label>
                          <textarea rows={3} value={selectedChannel.sourceCmd || selectedChannel.cmd || ''} onChange={(e) => updateSelectedChannel((item) => { const nextValue = e.target.value; item.cmd = nextValue; item.sourceCmd = nextValue; if (isYouTubeUrl(nextValue)) { item.sourceMeta = Object.assign({}, item.sourceMeta || {}, { originalUrl: nextValue }) } else if (item.sourceMeta && typeof item.sourceMeta === 'object' && 'originalUrl' in item.sourceMeta) { const nextMeta = Object.assign({}, item.sourceMeta || {}); delete (nextMeta as Record<string, unknown>).originalUrl; item.sourceMeta = nextMeta } })} className="channel-url-textarea" />
                        </div>
                        <div className="studio-toolbar">
                          <button className="btn btn-red btn-sm" onClick={() => {
                            updateDraft((playlist) => {
                              const arr = playlist.data[curatedKind][curatedGroup] || []
                              playlist.data[curatedKind][curatedGroup] = arr.filter((_, i) => i !== selectedChannelIndex)
                            })
                            setSelectedChannelIndex(-1)
                          }}>
                            Kanali Sil
                          </button>
                        </div>
                      </div>
                      <div className="studio-player-box">
                        <div className="studio-player-head"><strong>{previewLabel}</strong></div>
                        {previewUrl
                          ? <iframe key={previewUrl} src={previewUrl} title="Editor Player" className="studio-player-frame" allow="autoplay; fullscreen" />
                          : <div className="studio-player-empty">Kanal sec · ▶ Player butonuna bas · Player burada acilir</div>
                        }
                      </div>
                    </>
                  )}
                </div>

              </div>
            </>
          ) : (
            <div className="studio-empty-large">
              <strong>Playlist acik degil</strong>
              <span>⚡ Sihirbaz ile yeni playlist olustur veya var olan birini sec.</span>
            </div>
          )}

          <div className="studio-message">{loading ? '⏳ Yukleniyor...' : message}</div>
        </div>
      </div>

      {/* ── QUICK ADD CHANNEL MODAL ── */}
      {quickAddOpen && (
        <div className="studio-modal-backdrop" onClick={closeQuickAdd}>
          <div className="studio-modal" style={{ maxWidth: '500px', width: '100%' }} onClick={(e) => e.stopPropagation()}>
            <div className="studio-modal-head">
              <div>
                <strong style={{ fontSize: 17 }}>⊕ Hizli Kanal Ekle</strong>
                <div className="section-copy" style={{ marginTop: 2 }}>
                  {KINDS.find((k) => k.key === curatedKind)?.label} — Pencere acik kalir, art arda ekleyebilirsin
                  {qaAddedCount > 0 && <span style={{ color: '#4ade80', marginLeft: 10 }}>✓ {qaAddedCount} kanal eklendi</span>}
                </div>
              </div>
              <button className="btn btn-gray btn-sm" onClick={closeQuickAdd}>✕ Kapat</button>
            </div>

            <div className="field">
              <label>Kategori *</label>
              {curatedGroups.length > 0 ? (
                <>
                  <select
                    value={qaCategory}
                    onChange={(e) => { setQaCategory(e.target.value); if (e.target.value !== '__new__') setQaNewCategory('') }}
                    style={{ marginBottom: qaCategory === '__new__' ? 8 : 0 }}
                  >
                    <option value="">Kategori sec...</option>
                    {curatedGroups.map((g) => <option key={g} value={g}>{g} ({(draftCurated?.data[curatedKind][g] || []).length} kanal)</option>)}
                    <option value="__new__">+ Yeni kategori olustur...</option>
                  </select>
                  {qaCategory === '__new__' && (
                    <input type="text" placeholder="Yeni kategori adi" value={qaNewCategory} onChange={(e) => setQaNewCategory(e.target.value)} autoFocus />
                  )}
                </>
              ) : (
                <input type="text" placeholder="Kategori adi (yeni olusturulacak)" value={qaNewCategory} onChange={(e) => setQaNewCategory(e.target.value)} />
              )}
            </div>

            <div className="field">
              <label>Kanal Adi *</label>
              <input
                type="text"
                placeholder="Ornek: TRT 1"
                value={qaName}
                onChange={(e) => setQaName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleQuickAddChannel() }}
                autoFocus={curatedGroups.length === 0}
              />
            </div>

            <div className="field">
              <label>Stream URL / CMD</label>
              <input
                type="text"
                placeholder="http://... veya ffmpeg rtmp://..."
                value={qaUrl}
                onChange={(e) => setQaUrl(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleQuickAddChannel() }}
              />
            </div>

            <div className="field">
              <label>Logo URL (istege bagli)</label>
              <input type="text" placeholder="http://..." value={qaLogo} onChange={(e) => setQaLogo(e.target.value)} />
            </div>

            <div className="studio-modal-actions">
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>Enter ile de ekleyebilirsin</div>
              <div className="studio-inline-actions">
                <button className="btn btn-gray btn-sm" onClick={closeQuickAdd}>Kapat</button>
                <button
                  className="btn btn-primary"
                  onClick={handleQuickAddChannel}
                  disabled={!qaName.trim() || (curatedGroups.length > 0 ? (!qaCategory || (qaCategory === '__new__' && !qaNewCategory.trim())) : !qaNewCategory.trim())}
                >
                  ⊕ Listeye Ekle
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── WIZARD MODAL ── */}
      {wizardOpen && (
        <div className="studio-modal-backdrop" onClick={closeWizard}>
          <div className="studio-modal" onClick={(e) => e.stopPropagation()}>

            <div className="studio-modal-head">
              <div>
                <div className="card-title"><span className="icon-badge ic-dashboard">⚡</span>Aktarma Sihirbazi</div>
                <div className="section-copy">
                  Kategori sec · {wizardTransferMode === 'move' ? 'Kaynak listeden tasiyarak' : 'Kopyalayarak'} hedef playliste aktar
                </div>
              </div>
              <div className="studio-inline-actions">
                <div className={'wizard-mode-pill wizard-mode-' + wizardTransferMode}>
                  {wizardTransferMode === 'move' ? '↗ Tasi Modu' : '⧉ Kopya Modu'}
                </div>
                <button className="btn btn-gray btn-sm" onClick={closeWizard}>✕</button>
              </div>
            </div>

            <div className="studio-field-grid studio-field-grid-wide">
              <div className="field">
                <label>Kaynak Liste</label>
                <select value={sourceId} onChange={(e) => { const nextId = e.target.value; setSourceId(nextId); void ensureFullPlaylist(nextId).catch((err: any) => setMessage('Kaynak yukleme hatasi: ' + err.message)) }}>
                  {sources.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.type})</option>)}
                </select>
              </div>
              <div className="field">
                <label>Hedef Playlist</label>
                <select value={wizardTargetId} onChange={(e) => { const nextTargetId = e.target.value; const nextTarget = nextTargetId !== NEW_PLAYLIST_TARGET ? curated.find((p) => p.id === nextTargetId) || null : null; setWizardTargetId(nextTargetId); if (nextTarget) setWizardName(nextTarget.name); else if (source) setWizardName(source.name + ' Playlist') }}>
                  <option value={NEW_PLAYLIST_TARGET}>✦ Yeni playlist olustur</option>
                  {curated.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            </div>

            <div className="studio-field-grid studio-field-grid-wide">
              <div className="field">
                <label>Playlist Adi</label>
                <input type="text" value={wizardTargetPlaylist ? wizardTargetPlaylist.name : wizardName} onChange={(e) => { if (!wizardTargetPlaylist) setWizardName(e.target.value) }} disabled={!!wizardTargetPlaylist} />
              </div>
              <div className="field">
                <label>Aktarim Modu</label>
                <div className="studio-kind-tabs">
                  <button className={'btn btn-sm ' + (wizardTransferMode === 'copy' ? 'btn-primary' : 'btn-gray')} onClick={() => setWizardTransferMode('copy')}>⧉ Kopyala</button>
                  <button className={'btn btn-sm ' + (wizardTransferMode === 'move' ? 'btn-primary' : 'btn-gray')} onClick={() => setWizardTransferMode('move')}>↗ Tasi</button>
                </div>
                <div className="section-copy wizard-mode-hint">
                  {wizardTransferMode === 'move' ? '⚠ Tasi modu: Secilen kategoriler kaynaktan kalici silinir.' : 'Kopyala modu: Kaynak liste degismez, kopya aktarilir.'}
                </div>
              </div>
            </div>

            <div className="studio-kind-tabs">
              {KINDS.map((kind) => (
                <button key={kind.key} className={'btn btn-sm ' + (wizardKind === kind.key ? 'btn-primary' : 'btn-gray')} onClick={() => { setWizardKind(kind.key); setWizardSearchQuery('') }}>
                  {kind.label} ({source ? sourceCounts[kind.key].toLocaleString() : 0})
                  {wizardSelections[kind.key].length > 0 && <span className="kind-sel-badge">{wizardSelections[kind.key].length}</span>}
                </button>
              ))}
            </div>

            <div className="studio-modal-grid">

              {/* LEFT: Source categories */}
              <div className="studio-subpanel">
                <div className="studio-section-head">
                  <div><div className="sidebar-label">Alt Kategoriler</div><div className="section-copy">Checkbox ile sec veya sag tarafa surukle.</div></div>
                  <div className="studio-pill studio-pill-soft">{filteredWizardGroups.length}{wizardSearchQuery ? `/${wizardGroups.length}` : ''} kategori</div>
                </div>

                <div className="wizard-search-wrap">
                  <span className="wizard-search-icon">🔍</span>
                  <input
                    type="text"
                    className="wizard-search-input"
                    placeholder="Kategori ara..."
                    value={wizardSearchQuery}
                    onChange={(e) => setWizardSearchQuery(e.target.value)}
                  />
                  {wizardSearchQuery && (
                    <button className="wizard-search-clear" onClick={() => setWizardSearchQuery('')}>✕</button>
                  )}
                </div>

                <div className="studio-scroll studio-scroll-modal">
                  {filteredWizardGroups.map((group) => {
                    const isSelected = wizardSelections[wizardKind].includes(group)
                    const isPendingMove = isSelected && wizardTransferMode === 'move'
                    return (
                      <label
                        key={group}
                        className={'studio-check-row studio-check-row-rich studio-draggable-row' + (isPendingMove ? ' pending-move' : '') + (dragOverWizardGroup === group && draggedGroup !== group ? ' drag-target-active' : '')}
                        draggable
                        onDragStart={() => setDraggedGroup(group)}
                        onDragOver={(e) => { e.preventDefault(); setDragOverWizardGroup(group) }}
                        onDragLeave={() => setDragOverWizardGroup('')}
                      >
                        <input type="checkbox" checked={isSelected} onChange={(e) => toggleWizardCategory(wizardKind, group, e.target.checked)} />
                        <span className="studio-drag-handle">⠿</span>
                        <span className="studio-row-main">
                          <strong>{group}</strong>
                          <span className="muted">{source && source.data ? (source.data[wizardKind][group] || []).length.toLocaleString() : 0} kanal</span>
                        </span>
                        {isPendingMove && <span className="pending-move-badge">↗ Tasinacak</span>}
                      </label>
                    )
                  })}
                  {filteredWizardGroups.length === 0 && wizardGroups.length > 0 && (
                    <div className="empty">"{wizardSearchQuery}" ile esleyen kategori yok</div>
                  )}
                  {!wizardGroups.length && <div className="empty">Bu bolumde kategori yok</div>}
                </div>
              </div>

              {/* RIGHT: Selected categories */}
              <div
                className={'studio-subpanel studio-subpanel-editor wizard-drop-zone' + (draggedGroup ? ' drop-zone-active' : '')}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => { if (draggedGroup) insertSelectedGroup(wizardKind, draggedGroup); setDraggedGroup(''); setDragOverWizardGroup('') }}
              >
                <div className="studio-section-head">
                  <div><div className="sidebar-label">Secilen Kategoriler</div><div className="section-copy">Buraya surukle veya sirala.</div></div>
                  <div className={'studio-pill ' + (selectedCategoryCount > 0 ? 'studio-pill-live' : 'studio-pill-soft')}>{selectedCategoryCount} secili</div>
                </div>
                <div className="studio-scroll studio-scroll-modal">
                  {selectedGroupsForKind.map((group) => (
                    <div
                      key={group}
                      className="studio-drag-row"
                      draggable
                      onDragStart={() => setDraggedGroup(group)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => { reorderSelectedGroup(wizardKind, group); setDraggedGroup('') }}
                    >
                      <span className="studio-drag-handle">⠿</span>
                      <span className="studio-row-main">
                        <strong>{group}</strong>
                        <span className="muted">{source && source.data ? (source.data[wizardKind][group] || []).length.toLocaleString() : 0} kanal</span>
                      </span>
                      <button className="btn btn-red btn-sm" onClick={() => toggleWizardCategory(wizardKind, group, false)}>✕</button>
                    </div>
                  ))}
                  {!selectedGroupsForKind.length && (
                    <div className="wizard-drop-hint">
                      <div className="wizard-drop-arrow">⟵</div>
                      <div>Soldan kategori surukle veya checkbox ile sec</div>
                    </div>
                  )}
                </div>
                <div className="studio-summary-strip">
                  <div className="studio-summary-chip"><span>Live TV</span><strong>{wizardCounts.live.toLocaleString()}</strong></div>
                  <div className="studio-summary-chip"><span>Film</span><strong>{wizardCounts.movies.toLocaleString()}</strong></div>
                  <div className="studio-summary-chip"><span>Dizi</span><strong>{wizardCounts.series.toLocaleString()}</strong></div>
                </div>
              </div>

            </div>

            <div className="studio-modal-actions">
              <div className="studio-inline-actions">
                <button className="btn btn-gray btn-sm" onClick={clearWizard}>Temizle</button>
                <span className="wizard-count-label">{wizardCounts.total.toLocaleString()} icerik secili</span>
              </div>
              <button className="btn btn-primary wizard-apply-btn" onClick={applyWizardSelection} disabled={!wizardCounts.total}>
                {wizardTargetPlaylist
                  ? (wizardTransferMode === 'move' ? `↗ ${selectedCategoryCount} Kategoriyi Tasi` : `⧉ ${selectedCategoryCount} Kategoriyi Kopyala`)
                  : (wizardTransferMode === 'move' ? '↗ Tasi ve Olustur' : '⧉ Kopyala ve Olustur')}
              </button>
            </div>

          </div>
        </div>
      )}

      {modalState && (
        <div className="modal-overlay" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(3px)' }} onClick={handleModalCancel}>
          <div className="modal-box" style={{ background: '#0c1929', border: '1px solid rgba(63,109,167,0.45)', borderRadius: '14px', padding: '28px 32px', minWidth: '320px', maxWidth: '480px', width: '90vw', boxShadow: '0 8px 48px rgba(0,0,0,0.7)' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-message" style={{ color: '#e8edf3', fontSize: '15px', lineHeight: 1.55, marginBottom: modalState.type === 'prompt' ? '14px' : '24px' }}>{modalState.message}</div>
            {modalState.type === 'prompt' && (
              <input
                type="text"
                value={modalPromptValue}
                onChange={(e) => setModalPromptValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleModalConfirm(); if (e.key === 'Escape') handleModalCancel() }}
                autoFocus
                style={{ width: '100%', boxSizing: 'border-box', padding: '9px 12px', background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(63,109,167,0.4)', borderRadius: '8px', color: '#e8edf3', fontSize: '14px', outline: 'none', marginBottom: '20px' }}
              />
            )}
            <div className="modal-btns" style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button onClick={handleModalCancel} style={{ padding: '8px 18px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.08)', color: '#c9d3de', cursor: 'pointer', fontSize: '13px' }}>İptal</button>
              <button onClick={handleModalConfirm} style={{ padding: '8px 18px', borderRadius: '8px', border: 'none', background: '#2d6db5', color: '#fff', cursor: 'pointer', fontSize: '13px', fontWeight: 600 }}>Tamam</button>
            </div>
          </div>
        </div>
      )}

    </Shell>
  )
}

createRoot(document.getElementById('app-root')!).render(<EditorApp />)
