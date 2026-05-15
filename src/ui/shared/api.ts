export type PlaylistItem = {
  id?: string
  name?: string
  logo?: string
  cmd?: string
  sourceCmd?: string
  sourceType?: string
  sourceMeta?: Record<string, unknown>
  sourcePlaylistId?: string
  sourcePlaylistName?: string
}

export type PlaylistData = {
  live: Record<string, PlaylistItem[]>
  movies: Record<string, PlaylistItem[]>
  series: Record<string, PlaylistItem[]>
}

export type PlaylistCounts = {
  live: number
  movies: number
  series: number
  total: number
}

export type PlaylistMeta = {
  playlistBucket?: 'source' | 'curated'
  tvPublished?: boolean
  tvPublishedAt?: string
  hiddenCategories?: Record<string, Record<string, boolean>>
  [key: string]: unknown
}

export type PlaylistRecord = {
  id: string
  name: string
  type: string
  data?: PlaylistData
  counts?: PlaylistCounts
  meta?: PlaylistMeta
  createdAt?: string
  updatedAt?: string
}

export type ServerInfo = {
  username: string
  password: string
  deliveryMode: string
  storage: string
  storageMode?: string
  storageFallbackReason?: string
  databaseProvider?: string
  databaseHost?: string
  readOnly: boolean
  readOnlyReason?: string
  canTriggerLocalDeploy?: boolean
  lastLocalDeploy?: { at: string; deploymentUrl?: string | null } | null
  deployInProgress?: boolean
  linkedVercelProject?: { projectId?: string; orgId?: string; projectName?: string } | null
  sharingMode?: 'selected' | 'all'
  publishedPlaylists?: Array<{ id: string; name: string; type: string }>
  separatePort?: boolean
  port?: number
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const text = await response.text()
  const payload = text ? JSON.parse(text) : null
  if (!response.ok) {
    throw new Error(payload && payload.error ? payload.error : response.statusText)
  }
  return payload as T
}

export function emptyData(): PlaylistData {
  return { live: {}, movies: {}, series: {} }
}

export function emptyCounts(): PlaylistCounts {
  return { live: 0, movies: 0, series: 0, total: 0 }
}

export function splitPlaylists(playlists: PlaylistRecord[]) {
  const sources: PlaylistRecord[] = []
  const curated: PlaylistRecord[] = []

  ;(playlists || []).forEach((playlist) => {
    if (playlist?.meta?.playlistBucket === 'curated' || playlist.type === 'custom' || playlist.type === 'playlist') {
      curated.push(playlist)
      return
    }
    sources.push(playlist)
  })

  return { sources, curated }
}

export function countData(data?: PlaylistData) {
  const result = emptyCounts()
  ;(['live', 'movies', 'series'] as const).forEach((kind) => {
    Object.values((data && data[kind]) || {}).forEach((items) => {
      result[kind] += (items || []).length
      result.total += (items || []).length
    })
  })
  return result
}

export function getPlaylistCounts(playlist?: Partial<PlaylistRecord> | null) {
  if (!playlist) return emptyCounts()
  const counts = playlist.counts
  if (counts) {
    return {
      live: Math.max(0, Number(counts.live) || 0),
      movies: Math.max(0, Number(counts.movies) || 0),
      series: Math.max(0, Number(counts.series) || 0),
      total: Math.max(0, Number(counts.total) || 0)
    }
  }
  return countData(playlist.data)
}

export function cloneData<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

export async function getPlaylists() {
  return requestJson<PlaylistRecord[]>('/api/playlists')
}

export async function getPlaylist(id: string) {
  return requestJson<PlaylistRecord>('/api/playlists/' + encodeURIComponent(id))
}

export async function getPlaylistSummaries() {
  return requestJson<PlaylistRecord[]>('/api/playlists?summary=1')
}

export async function createPlaylist(payload: Partial<PlaylistRecord>) {
  return requestJson<PlaylistRecord>('/api/playlists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
}

export async function updatePlaylist(id: string, payload: Partial<PlaylistRecord>) {
  return requestJson<PlaylistRecord>('/api/playlists/' + encodeURIComponent(id), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
}

export async function deletePlaylist(id: string) {
  return requestJson<{ ok: boolean }>('/api/playlists/' + encodeURIComponent(id), {
    method: 'DELETE'
  })
}

export async function publishPlaylist(id: string) {
  return requestJson<{ ok: boolean; playlistId: string }>('/api/playlists/' + encodeURIComponent(id) + '/publish-tv', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  })
}

export async function getServerInfo() {
  return requestJson<ServerInfo>('/api/server-info')
}

export async function saveServerConfig(username: string, password: string) {
  return requestJson('/api/server-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  })
}

export async function deployVercel() {
  return requestJson<{ ok: boolean; deploymentUrl?: string; output?: string }>('/api/deploy/vercel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  })
}
