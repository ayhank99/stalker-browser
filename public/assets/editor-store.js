import {
  createPlaylist,
  updatePlaylist
} from './app-core.js'

export const KIND_CONFIG = [
  { kind: 'live', label: 'Live TV', dot: 'd-live' },
  { kind: 'movies', label: 'Movies', dot: 'd-movies' },
  { kind: 'series', label: 'Series', dot: 'd-series' }
]

const PREFERRED_TARGET_KEY = 'editorPreferredCuratedPlaylistId'

function deepClone(value) {
  return JSON.parse(JSON.stringify(value || {}))
}

export function buildStalkerPortalCmd(id) {
  const value = String(id || '').trim()
  if (!value) return ''
  return 'ffmpeg http://localhost/ch/' + value + '_'
}

export function shouldAutobuildStalkerCmd(value) {
  const text = String(value || '').trim()
  return !text || /^(?:ffmpeg\s+)?https?:\/\/localhost\/ch\/\d+_$/i.test(text) || /^\/ch\/\d+_$/i.test(text)
}

export function categoryKey(kind, group) {
  return kind + '::' + group
}

export function parseCategoryKey(key) {
  const parts = String(key || '').split('::')
  return {
    kind: parts[0] || 'live',
    group: parts.slice(1).join('::')
  }
}

export function shortText(value, maxLength) {
  const text = String(value || '').trim()
  if (!text) return '-'
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength - 1) + '...'
}

export class EditorStore {
  constructor(playlists) {
    this.playlists = []
    this.editorPlaylistId = null
    this.editorKind = 'live'
    this.editorGroup = '__all__'
    this.editorRows = []
    this.editorDirty = false
    this.expandedKinds = { live: true, movies: false, series: false }
    this.selectedCategoryKeys = new Set()
    this.selectedRowItems = new Set()
    this.activeRowItem = null
    this.searchQuery = ''
    this.preferredTargetPlaylistId = window.localStorage.getItem(PREFERRED_TARGET_KEY) || ''
    this.replacePlaylists(playlists || [])
  }

  replacePlaylists(playlists) {
    this.playlists = Array.isArray(playlists) ? playlists.slice() : []
    if (!this.editorPlaylistId || !this.playlists.some((playlist) => playlist.id === this.editorPlaylistId)) {
      this.editorPlaylistId = this.playlists[0] ? this.playlists[0].id : null
    }
    this.syncDerived()
  }

  markDirty() {
    this.editorDirty = true
  }

  clearDirty() {
    this.editorDirty = false
  }

  currentPlaylist() {
    return this.playlists.find((playlist) => playlist.id === this.editorPlaylistId) || null
  }

  isCuratedPlaylist(playlist) {
    return !!(playlist && playlist.type === 'custom')
  }

  curatedPlaylists() {
    return this.playlists.filter((playlist) => this.isCuratedPlaylist(playlist))
  }

  getPreferredCuratedPlaylist() {
    if (this.preferredTargetPlaylistId) {
      const found = this.playlists.find((playlist) => playlist.id === this.preferredTargetPlaylistId && this.isCuratedPlaylist(playlist))
      if (found) return found
    }
    const first = this.curatedPlaylists()[0] || null
    if (first) {
      this.preferredTargetPlaylistId = first.id
      window.localStorage.setItem(PREFERRED_TARGET_KEY, first.id)
    }
    return first
  }

  setPreferredCuratedPlaylist(id) {
    this.preferredTargetPlaylistId = String(id || '').trim()
    if (this.preferredTargetPlaylistId) {
      window.localStorage.setItem(PREFERRED_TARGET_KEY, this.preferredTargetPlaylistId)
    } else {
      window.localStorage.removeItem(PREFERRED_TARGET_KEY)
    }
  }

  selectedKindConfig() {
    return KIND_CONFIG.find((entry) => entry.kind === this.editorKind) || KIND_CONFIG[0]
  }

  ensureHiddenCategories(playlist) {
    if (!playlist.meta) playlist.meta = {}
    if (!playlist.meta.hiddenCategories || typeof playlist.meta.hiddenCategories !== 'object') {
      playlist.meta.hiddenCategories = { live: {}, movies: {}, series: {} }
    }
    KIND_CONFIG.forEach((entry) => {
      if (!playlist.meta.hiddenCategories[entry.kind] || typeof playlist.meta.hiddenCategories[entry.kind] !== 'object') {
        playlist.meta.hiddenCategories[entry.kind] = {}
      }
    })
    return playlist.meta.hiddenCategories
  }

  isCategoryHidden(playlist, kind, group) {
    const hidden = this.ensureHiddenCategories(playlist)
    return !!hidden[kind][group]
  }

  setCategoryHidden(playlist, kind, group, hidden) {
    const map = this.ensureHiddenCategories(playlist)
    if (hidden) map[kind][group] = true
    else delete map[kind][group]
  }

  ensurePlaylistData(playlist) {
    if (!playlist.data || typeof playlist.data !== 'object') {
      playlist.data = { live: {}, movies: {}, series: {} }
    }
    KIND_CONFIG.forEach((entry) => {
      if (!playlist.data[entry.kind] || typeof playlist.data[entry.kind] !== 'object') {
        playlist.data[entry.kind] = {}
      }
    })
  }

  groupsForKind(playlist, kind) {
    this.ensurePlaylistData(playlist || {})
    return Object.keys((playlist && playlist.data && playlist.data[kind]) || {})
  }

  itemCountForGroup(playlist, kind, group) {
    const items = playlist && playlist.data && playlist.data[kind] && playlist.data[kind][group]
    return Array.isArray(items) ? items.length : 0
  }

  totalForKind(playlist, kind) {
    return this.groupsForKind(playlist, kind).reduce((sum, group) => {
      return sum + this.itemCountForGroup(playlist, kind, group)
    }, 0)
  }

  getItemSourceType(item, playlist) {
    return String((item && item.sourceType) || (playlist && playlist.type) || '').trim()
  }

  getItemSourceMeta(item, playlist) {
    const sourceType = this.getItemSourceType(item, playlist)
    const itemMeta = item && item.sourceMeta && typeof item.sourceMeta === 'object' ? item.sourceMeta : null
    if (itemMeta) return itemMeta
    if (sourceType === 'custom') return {}
    return (playlist && playlist.meta) || {}
  }

  getCmdInputValue(item, playlist) {
    if (this.getItemSourceType(item, playlist) === 'stalker') {
      return String((item && (item.sourceCmd || item.cmd)) || '').trim()
    }
    return String((item && item.cmd) || '').trim()
  }

  cloneItemForCuratedPlaylist(item, sourcePlaylist) {
    const copy = deepClone(item)
    copy.sourceType = this.getItemSourceType(item, sourcePlaylist)
    copy.sourceMeta = this.getItemSourceMeta(item, sourcePlaylist)
    copy.sourcePlaylistId = (item && item.sourcePlaylistId) || (sourcePlaylist && sourcePlaylist.id) || ''
    copy.sourcePlaylistName = (item && item.sourcePlaylistName) || (sourcePlaylist && sourcePlaylist.name) || ''
    copy.sourceCmd = String((item && (item.sourceCmd || item.cmd)) || '').trim()
    copy.cmd = String((item && item.cmd) || '').trim()
    copy.id = String(copy.id || '')
    return copy
  }

  cloneItemForDuplicate(item, playlist, index) {
    const copy = deepClone(item)
    copy.name = String(copy.name || 'Yeni Kanal') + ' Kopya'
    if (playlist.type === 'stalker') {
      copy.id = String(copy.id || '')
      if (!copy.sourceCmd && copy.cmd) copy.sourceCmd = copy.cmd
    } else {
      copy.id = String(Date.now()) + String(index)
    }
    return copy
  }

  findCuratedDuplicate(targetItems, nextItem) {
    const nextCmd = String(nextItem.sourceCmd || nextItem.cmd || '').trim()
    const nextSourceType = String(nextItem.sourceType || '').trim()
    return (targetItems || []).some((existing) => {
      return String(existing.sourceType || '').trim() === nextSourceType &&
        String(existing.sourceCmd || existing.cmd || '').trim() === nextCmd &&
        String(existing.name || '').trim() === String(nextItem.name || '').trim()
    })
  }

  cleanupPlaylistData(playlist) {
    if (!playlist || !playlist.data) return
    const hidden = this.ensureHiddenCategories(playlist)
    KIND_CONFIG.forEach((entry) => {
      const groups = playlist.data[entry.kind] || {}
      Object.keys(groups).forEach((group) => {
        if (!Array.isArray(groups[group]) || !groups[group].length) {
          delete groups[group]
          delete hidden[entry.kind][group]
        }
      })
      Object.keys(hidden[entry.kind] || {}).forEach((group) => {
        if (!groups[group]) delete hidden[entry.kind][group]
      })
    })
  }

  pruneSelections() {
    const playlist = this.currentPlaylist()
    if (!playlist) {
      this.selectedCategoryKeys.clear()
      this.selectedRowItems.clear()
      this.activeRowItem = null
      return
    }

    const validCategoryKeys = new Set()
    KIND_CONFIG.forEach((entry) => {
      this.groupsForKind(playlist, entry.kind).forEach((group) => {
        validCategoryKeys.add(categoryKey(entry.kind, group))
      })
    })
    Array.from(this.selectedCategoryKeys).forEach((key) => {
      if (!validCategoryKeys.has(key)) this.selectedCategoryKeys.delete(key)
    })

    const validRowItems = new Set()
    this.groupsForKind(playlist, this.editorKind).forEach((group) => {
      ;(playlist.data[this.editorKind][group] || []).forEach((item) => {
        validRowItems.add(item)
      })
    })
    Array.from(this.selectedRowItems).forEach((item) => {
      if (!validRowItems.has(item)) this.selectedRowItems.delete(item)
    })
    if (this.activeRowItem && !validRowItems.has(this.activeRowItem)) {
      this.activeRowItem = null
    }
  }

  syncSelectionToExistingState() {
    const playlist = this.currentPlaylist()
    if (!playlist) {
      this.editorKind = 'live'
      this.editorGroup = '__all__'
      this.pruneSelections()
      return
    }

    this.ensurePlaylistData(playlist)
    if (!playlist.data[this.editorKind]) this.editorKind = 'live'
    if (this.editorGroup !== '__all__' && !playlist.data[this.editorKind][this.editorGroup]) {
      this.editorGroup = '__all__'
    }
    this.expandedKinds[this.editorKind] = true
    this.pruneSelections()
  }

  buildRows() {
    const playlist = this.currentPlaylist()
    if (!playlist) {
      this.editorRows = []
      return this.editorRows
    }

    const query = String(this.searchQuery || '').trim().toLowerCase()
    const rows = []

    this.groupsForKind(playlist, this.editorKind).forEach((group) => {
      if (this.editorGroup !== '__all__' && group !== this.editorGroup) return
      ;(playlist.data[this.editorKind][group] || []).forEach((item, index) => {
        rows.push({ item: item, group: group, index: index })
      })
    })

    const filtered = query
      ? rows.filter((row) => {
          return String(row.item.name || '').toLowerCase().includes(query) ||
            String(row.group || '').toLowerCase().includes(query) ||
            String(row.item.id || '').toLowerCase().includes(query) ||
            String(this.getCmdInputValue(row.item, playlist) || '').toLowerCase().includes(query)
        })
      : rows

    const visibleItems = new Set(filtered.map((row) => row.item))
    Array.from(this.selectedRowItems).forEach((item) => {
      if (!visibleItems.has(item)) this.selectedRowItems.delete(item)
    })
    if (this.activeRowItem && !visibleItems.has(this.activeRowItem)) {
      this.activeRowItem = null
    }

    this.editorRows = filtered
    return this.editorRows
  }

  syncDerived() {
    this.syncSelectionToExistingState()
    this.buildRows()
    return this.editorRows
  }

  selectedRows() {
    return this.editorRows.filter((row) => this.selectedRowItems.has(row.item))
  }

  selectedCategoryEntries() {
    const playlist = this.currentPlaylist()
    if (!playlist) return []
    return Array.from(this.selectedCategoryKeys).map(parseCategoryKey).filter((entry) => {
      return !!(playlist.data && playlist.data[entry.kind] && playlist.data[entry.kind][entry.group])
    })
  }

  effectiveCategoryTargets() {
    const selected = this.selectedCategoryEntries()
    if (selected.length) return selected
    if (this.editorGroup !== '__all__') return [{ kind: this.editorKind, group: this.editorGroup }]
    return []
  }

  currentSelectionLabel() {
    const rows = this.selectedRows()
    const targets = this.effectiveCategoryTargets()
    if (rows.length > 1) return rows.length + ' kanal secili'
    if (rows.length === 1) return rows[0].item.name || 'Kanal secili'
    if (targets.length > 1) return targets.length + ' kategori secili'
    if (targets.length === 1) return targets[0].group
    return this.selectedKindConfig().label + ' / Tum Kategoriler'
  }

  selectPlaylist(id) {
    if (id === this.editorPlaylistId) return false
    this.editorPlaylistId = id
    this.editorKind = 'live'
    this.editorGroup = '__all__'
    this.expandedKinds = { live: true, movies: false, series: false }
    this.selectedCategoryKeys.clear()
    this.selectedRowItems.clear()
    this.activeRowItem = null
    this.clearDirty()
    this.syncDerived()
    return true
  }

  setSearchQuery(value) {
    this.searchQuery = String(value || '')
    this.buildRows()
  }

  toggleExpandedKind(kind) {
    this.expandedKinds[kind] = !this.expandedKinds[kind]
    return this.expandedKinds[kind]
  }

  setActiveCategory(kind, group) {
    this.editorKind = kind
    this.editorGroup = group
    this.expandedKinds[kind] = true
    this.activeRowItem = null
    this.selectedRowItems.clear()
    this.buildRows()
  }

  toggleCategorySelection(kind, group, checked) {
    const key = categoryKey(kind, group)
    if (checked == null) {
      if (this.selectedCategoryKeys.has(key)) this.selectedCategoryKeys.delete(key)
      else this.selectedCategoryKeys.add(key)
    } else if (checked) {
      this.selectedCategoryKeys.add(key)
    } else {
      this.selectedCategoryKeys.delete(key)
    }
  }

  activateCategory(kind, group, additive) {
    if (additive) {
      this.toggleCategorySelection(kind, group)
    } else {
      this.selectedCategoryKeys.clear()
      this.selectedCategoryKeys.add(categoryKey(kind, group))
      this.setActiveCategory(kind, group)
    }
  }

  setSingleRowSelection(row, additive) {
    if (!row) return
    this.selectedCategoryKeys.clear()
    if (additive) {
      if (this.selectedRowItems.has(row.item)) this.selectedRowItems.delete(row.item)
      else this.selectedRowItems.add(row.item)
    } else {
      this.selectedRowItems.clear()
      this.selectedRowItems.add(row.item)
    }
    this.activeRowItem = row.item
  }

  toggleRowSelectionByIndex(index, checked) {
    const row = this.editorRows[Number(index)]
    if (!row) return
    if (checked) this.selectedRowItems.add(row.item)
    else this.selectedRowItems.delete(row.item)
    if (!this.selectedRowItems.size) this.activeRowItem = null
  }

  toggleAllRows(checked) {
    this.selectedCategoryKeys.clear()
    this.selectedRowItems.clear()
    if (checked) {
      this.editorRows.forEach((row) => this.selectedRowItems.add(row.item))
      this.activeRowItem = this.editorRows[0] ? this.editorRows[0].item : null
    } else {
      this.activeRowItem = null
    }
  }

  clearRowSelection() {
    this.selectedRowItems.clear()
    this.activeRowItem = null
  }

  clearCategorySelection() {
    this.selectedCategoryKeys.clear()
  }

  rebuildKindOrder(kind, orderedGroups) {
    const playlist = this.currentPlaylist()
    if (!playlist) return
    const nextGroups = {}
    orderedGroups.forEach((group) => {
      nextGroups[group] = playlist.data[kind][group]
    })
    playlist.data[kind] = nextGroups
  }

  moveItemsToGroup(rows, nextGroupName) {
    const playlist = this.currentPlaylist()
    const nextGroup = String(nextGroupName || '').trim() || 'Genel'
    if (!playlist || !rows.length) return false
    this.ensurePlaylistData(playlist)
    if (!playlist.data[this.editorKind][nextGroup]) playlist.data[this.editorKind][nextGroup] = []

    const orderedRows = rows.slice().sort((left, right) => {
      if (left.group === right.group) return right.index - left.index
      return left.group > right.group ? 1 : -1
    })

    orderedRows.forEach((row) => {
      const source = playlist.data[this.editorKind][row.group]
      if (!source) return
      const sourceIndex = source.indexOf(row.item)
      if (sourceIndex < 0) return
      source.splice(sourceIndex, 1)
      playlist.data[this.editorKind][nextGroup].push(row.item)
    })

    this.cleanupPlaylistData(playlist)
    if (this.editorGroup !== '__all__' && !playlist.data[this.editorKind][this.editorGroup]) {
      this.editorGroup = nextGroup
    }
    this.syncDerived()
    return true
  }

  removeRows(rows) {
    const playlist = this.currentPlaylist()
    if (!playlist) return 0
    let removed = 0
    const orderedRows = rows.slice().sort((left, right) => {
      if (left.group === right.group) return right.index - left.index
      return left.group > right.group ? 1 : -1
    })

    orderedRows.forEach((row) => {
      const group = playlist.data[this.editorKind][row.group]
      if (!group) return
      const index = group.indexOf(row.item)
      if (index < 0) return
      group.splice(index, 1)
      this.selectedRowItems.delete(row.item)
      if (this.activeRowItem === row.item) this.activeRowItem = null
      removed += 1
    })

    this.cleanupPlaylistData(playlist)
    if (this.editorGroup !== '__all__' && !playlist.data[this.editorKind][this.editorGroup]) {
      this.editorGroup = '__all__'
    }
    this.syncDerived()
    return removed
  }

  duplicateRows(rows) {
    const playlist = this.currentPlaylist()
    if (!playlist || !rows.length) return 0
    const inserted = []

    rows.forEach((row, index) => {
      const group = playlist.data[this.editorKind][row.group]
      if (!group) return
      const sourceIndex = group.indexOf(row.item)
      if (sourceIndex < 0) return
      const copy = this.cloneItemForDuplicate(row.item, playlist, index)
      group.splice(sourceIndex + 1, 0, copy)
      inserted.push(copy)
    })

    this.selectedRowItems.clear()
    inserted.forEach((item) => this.selectedRowItems.add(item))
    this.activeRowItem = inserted[0] || this.activeRowItem
    this.syncDerived()
    return inserted.length
  }

  renameCategory(kind, oldGroup, nextGroup) {
    const playlist = this.currentPlaylist()
    const finalGroup = String(nextGroup || '').trim()
    if (!playlist || !finalGroup || oldGroup === finalGroup) return false
    if (!playlist.data[kind] || !playlist.data[kind][oldGroup]) return false
    if (playlist.data[kind][finalGroup]) throw new Error('Bu kategori zaten var')

    const groupOrder = this.groupsForKind(playlist, kind).map((group) => {
      return group === oldGroup ? finalGroup : group
    })
    const movedItems = playlist.data[kind][oldGroup]
    delete playlist.data[kind][oldGroup]
    playlist.data[kind][finalGroup] = movedItems
    this.rebuildKindOrder(kind, groupOrder)

    if (this.isCategoryHidden(playlist, kind, oldGroup)) {
      this.setCategoryHidden(playlist, kind, oldGroup, false)
      this.setCategoryHidden(playlist, kind, finalGroup, true)
    }

    if (this.selectedCategoryKeys.delete(categoryKey(kind, oldGroup))) {
      this.selectedCategoryKeys.add(categoryKey(kind, finalGroup))
    }
    if (this.editorKind === kind && this.editorGroup === oldGroup) {
      this.editorGroup = finalGroup
    }
    this.syncDerived()
    return true
  }

  createCategory(kind, groupName) {
    const playlist = this.currentPlaylist()
    const nextGroup = String(groupName || '').trim()
    if (!playlist || !nextGroup) return false
    this.ensurePlaylistData(playlist)
    if (playlist.data[kind][nextGroup]) throw new Error('Bu kategori zaten var')
    playlist.data[kind][nextGroup] = []
    this.editorKind = kind
    this.editorGroup = nextGroup
    this.expandedKinds[kind] = true
    this.selectedCategoryKeys.clear()
    this.selectedCategoryKeys.add(categoryKey(kind, nextGroup))
    this.syncDerived()
    return true
  }

  reorderCategory(kind, sourceGroup, targetGroup, insertAfter) {
    const playlist = this.currentPlaylist()
    if (!playlist || !playlist.data[kind]) return false
    const keys = this.groupsForKind(playlist, kind)
    const sourceIndex = keys.indexOf(sourceGroup)
    const targetIndex = keys.indexOf(targetGroup)
    if (sourceIndex < 0 || targetIndex < 0 || sourceGroup === targetGroup) return false

    keys.splice(sourceIndex, 1)
    let nextIndex = targetIndex
    if (sourceIndex < targetIndex) nextIndex -= 1
    if (insertAfter) nextIndex += 1
    keys.splice(Math.max(0, nextIndex), 0, sourceGroup)
    this.rebuildKindOrder(kind, keys)
    this.syncDerived()
    return true
  }

  reorderOrMoveRow(sourceItem, sourceGroupName, targetItem, targetGroupName, insertAfter) {
    const playlist = this.currentPlaylist()
    if (!playlist) return false
    const sourceGroup = playlist.data[this.editorKind][sourceGroupName]
    const targetGroup = playlist.data[this.editorKind][targetGroupName]
    if (!sourceGroup || !targetGroup) return false

    const sourceIndex = sourceGroup.indexOf(sourceItem)
    const targetIndex = targetGroup.indexOf(targetItem)
    if (sourceIndex < 0 || targetIndex < 0) return false

    sourceGroup.splice(sourceIndex, 1)
    let nextIndex = targetIndex
    if (sourceGroup === targetGroup && sourceIndex < targetIndex) nextIndex -= 1
    if (insertAfter) nextIndex += 1
    targetGroup.splice(Math.max(0, nextIndex), 0, sourceItem)
    this.cleanupPlaylistData(playlist)
    this.syncDerived()
    return true
  }

  swapSelectedOneStep(list, isSelected, direction) {
    let moved = false
    if (direction < 0) {
      for (let index = 1; index < list.length; index += 1) {
        if (isSelected(list[index]) && !isSelected(list[index - 1])) {
          const temp = list[index - 1]
          list[index - 1] = list[index]
          list[index] = temp
          moved = true
        }
      }
    } else {
      for (let index = list.length - 2; index >= 0; index -= 1) {
        if (isSelected(list[index]) && !isSelected(list[index + 1])) {
          const temp = list[index + 1]
          list[index + 1] = list[index]
          list[index] = temp
          moved = true
        }
      }
    }
    return moved
  }

  moveSelectedCategoriesByStep(direction) {
    const playlist = this.currentPlaylist()
    const targets = this.selectedCategoryEntries()
    if (!playlist || !targets.length) return false
    let moved = false
    targets.forEach((entry) => {
      const keys = this.groupsForKind(playlist, entry.kind)
      const nextKeys = keys.slice()
      const changed = this.swapSelectedOneStep(nextKeys, (group) => {
        return this.selectedCategoryKeys.has(categoryKey(entry.kind, group))
      }, direction)
      if (changed) {
        this.rebuildKindOrder(entry.kind, nextKeys)
        moved = true
      }
    })
    if (moved) this.syncDerived()
    return moved
  }

  moveSelectedRowsByStep(direction) {
    const playlist = this.currentPlaylist()
    if (!playlist || !this.selectedRowItems.size) return false
    let moved = false
    this.groupsForKind(playlist, this.editorKind).forEach((group) => {
      const items = playlist.data[this.editorKind][group] || []
      const changed = this.swapSelectedOneStep(items, (item) => this.selectedRowItems.has(item), direction)
      if (changed) moved = true
    })
    if (moved) this.syncDerived()
    return moved
  }

  renameCurrentPlaylist(nextName) {
    const playlist = this.currentPlaylist()
    const normalized = String(nextName || '').trim()
    if (!playlist || !normalized || normalized === String(playlist.name || '').trim()) return false
    playlist.name = normalized
    this.markDirty()
    return true
  }

  addEditorRow(targetKind, targetGroup) {
    const playlist = this.currentPlaylist()
    if (!playlist) return null

    const kind = targetKind || this.editorKind
    const group = String(
      targetGroup || (this.editorGroup !== '__all__' ? this.editorGroup : (this.groupsForKind(playlist, kind)[0] || 'Genel'))
    ).trim() || 'Genel'

    this.ensurePlaylistData(playlist)
    if (!playlist.data[kind][group]) playlist.data[kind][group] = []

    const item = playlist.type === 'stalker'
      ? { id: '', name: 'Yeni Stalker Kanal', logo: '', cmd: '', sourceCmd: '' }
      : { id: String(Date.now()), name: 'Yeni Kanal', logo: '', cmd: '' }

    playlist.data[kind][group].push(item)
    this.setActiveCategory(kind, group)
    this.selectedRowItems.clear()
    this.selectedRowItems.add(item)
    this.activeRowItem = item
    this.markDirty()
    this.syncDerived()
    return item
  }

  async createCuratedPlaylist(name) {
    const playlistName = String(name || '').trim() || 'Benim Playlistim'
    const now = new Date().toISOString()
    const playlist = await createPlaylist({
      id: String(Date.now()),
      name: playlistName,
      type: 'custom',
      createdAt: now,
      updatedAt: now,
      meta: {
        isCurated: true,
        syncIntervalMs: 0,
        accountStatus: 'Manuel kurgu'
      },
      data: { live: {}, movies: {}, series: {} }
    })
    this.playlists.push(playlist)
    this.setPreferredCuratedPlaylist(playlist.id)
    this.syncDerived()
    return playlist
  }

  async sendSelectionToCurated(targetPlaylistId) {
    const sourcePlaylist = this.currentPlaylist()
    const selectedTargetCategories = this.effectiveCategoryTargets()
    const rows = this.selectedRows()
    if (!sourcePlaylist || (!selectedTargetCategories.length && !rows.length)) {
      throw new Error('Gonderilecek kanal veya kategori secin')
    }

    let targetPlaylist = null
    if (targetPlaylistId) {
      targetPlaylist = this.playlists.find((playlist) => playlist.id === targetPlaylistId && this.isCuratedPlaylist(playlist)) || null
    }
    if (!targetPlaylist) {
      targetPlaylist = this.getPreferredCuratedPlaylist()
    }
    if (!targetPlaylist) {
      throw new Error('Kurgu playlist secin')
    }

    this.ensurePlaylistData(targetPlaylist)

    const ensureTargetGroup = (kind, group) => {
      if (!targetPlaylist.data[kind][group]) targetPlaylist.data[kind][group] = []
      return targetPlaylist.data[kind][group]
    }

    const pushItem = (kind, group, item) => {
      const targetItems = ensureTargetGroup(kind, group)
      const cloned = this.cloneItemForCuratedPlaylist(item, sourcePlaylist)
      if (this.findCuratedDuplicate(targetItems, cloned)) return false
      targetItems.push(cloned)
      return true
    }

    let added = 0
    let skipped = 0
    var touchedTargets = []

    const rememberTarget = (kind, group) => {
      if (!touchedTargets.some((entry) => entry.kind === kind && entry.group === group)) {
        touchedTargets.push({ kind: kind, group: group })
      }
    }

    if (rows.length) {
      rows.forEach((row) => {
        if (pushItem(this.editorKind, row.group, row.item)) {
          added += 1
          rememberTarget(this.editorKind, row.group)
        } else {
          skipped += 1
        }
      })
    } else {
      selectedTargetCategories.forEach((target) => {
        const sourceItems = (((sourcePlaylist.data || {})[target.kind] || {})[target.group] || [])
        sourceItems.forEach((item) => {
          if (pushItem(target.kind, target.group, item)) {
            added += 1
            rememberTarget(target.kind, target.group)
          } else {
            skipped += 1
          }
        })
      })
    }

    const updatedTarget = await updatePlaylist(targetPlaylist.id, {
      name: targetPlaylist.name,
      data: targetPlaylist.data,
      meta: targetPlaylist.meta
    })
    Object.assign(targetPlaylist, updatedTarget)
    this.syncDerived()
    return { targetPlaylist, added, skipped, touchedTargets: touchedTargets }
  }

  async publishCurrentToTv() {
    const current = this.currentPlaylist()
    if (!current) throw new Error('Playlist secin')
    return this.publishPlaylistById(current.id)
  }

  async publishPlaylistById(playlistId) {
    if (!playlistId) throw new Error('Playlist secin')

    const current = this.currentPlaylist()
    const target = this.playlists.find((playlist) => playlist.id === playlistId)
    if (!target) throw new Error('Playlist bulunamadi')

    const now = new Date().toISOString()
    const changedPlaylists = []

    for (const playlist of this.playlists) {
      const desiredPublished = playlist.id === playlistId
      const currentMeta = Object.assign({}, playlist.meta || {})
      const wasPublished = !!currentMeta.tvPublished
      currentMeta.tvPublished = desiredPublished
      currentMeta.tvPublishedAt = desiredPublished ? now : ''

      const shouldPersistMeta = wasPublished !== desiredPublished
      const shouldPersistCurrent = current && playlist.id === current.id && this.editorDirty

      if (!shouldPersistMeta && !shouldPersistCurrent) continue

      const payload = {
        name: playlist.name,
        meta: currentMeta
      }

      if (current && playlist.id === current.id) {
        payload.data = playlist.data
      }

      const updated = await updatePlaylist(playlist.id, payload)
      Object.assign(playlist, updated)
      changedPlaylists.push(updated)
    }

    if (!changedPlaylists.length && !(target.meta && target.meta.tvPublished)) {
      const payload = {
        name: target.name,
        meta: Object.assign({}, target.meta || {}, {
          tvPublished: true,
          tvPublishedAt: now
        })
      }
      if (current && current.id === target.id) {
        payload.data = target.data
      }
      const updated = await updatePlaylist(target.id, payload)
      Object.assign(target, updated)
    }

    this.clearDirty()
    this.syncDerived()
    return target
  }

  deleteSelectedRows() {
    const rows = this.selectedRows()
    const removed = this.removeRows(rows)
    if (removed) this.markDirty()
    return removed
  }

  deleteTargetCategories() {
    const playlist = this.currentPlaylist()
    const targets = this.effectiveCategoryTargets()
    if (!playlist || !targets.length) return 0
    targets.forEach((target) => {
      if (playlist.data[target.kind]) delete playlist.data[target.kind][target.group]
      this.setCategoryHidden(playlist, target.kind, target.group, false)
      this.selectedCategoryKeys.delete(categoryKey(target.kind, target.group))
    })
    this.editorGroup = '__all__'
    this.cleanupPlaylistData(playlist)
    this.markDirty()
    this.syncDerived()
    return targets.length
  }

  toggleTargetCategoriesVisibility() {
    const playlist = this.currentPlaylist()
    const targets = this.effectiveCategoryTargets()
    if (!playlist || !targets.length) return false
    const shouldHide = targets.some((target) => !this.isCategoryHidden(playlist, target.kind, target.group))
    targets.forEach((target) => {
      this.setCategoryHidden(playlist, target.kind, target.group, shouldHide)
    })
    this.markDirty()
    return shouldHide
  }

  duplicateSelectedRows() {
    const created = this.duplicateRows(this.selectedRows())
    if (created) this.markDirty()
    return created
  }

  moveSelectedRowsToGroup(targetGroupName) {
    const rows = this.selectedRows()
    if (!rows.length) return false
    const moved = this.moveItemsToGroup(rows, targetGroupName)
    if (moved) this.markDirty()
    return moved
  }

  applyNameTransform(transformer) {
    const rows = this.selectedRows()
    if (!rows.length) return 0
    rows.forEach((row) => {
      row.item.name = transformer(String(row.item.name || ''))
    })
    this.markDirty()
    return rows.length
  }

  applyPrefix(prefix) {
    const value = String(prefix || '')
    if (!value) return 0
    return this.applyNameTransform((name) => value + name)
  }

  applySuffix(suffix) {
    const value = String(suffix || '')
    if (!value) return 0
    return this.applyNameTransform((name) => name + value)
  }

  applyReplace(findText, replaceText) {
    const findValue = String(findText || '')
    if (!findValue) return 0
    const replaceValue = String(replaceText || '')
    return this.applyNameTransform((name) => name.split(findValue).join(replaceValue))
  }

  updateActiveRowField(field, value) {
    const rows = this.selectedRows()
    const playlist = this.currentPlaylist()
    if (!playlist || rows.length !== 1) return false

    const row = rows[0]
    const rowSourceType = this.getItemSourceType(row.item, playlist)
    if (field === 'id') {
      row.item.id = value
      if (rowSourceType === 'stalker' && shouldAutobuildStalkerCmd(row.item.sourceCmd || row.item.cmd)) {
        const nextCmd = buildStalkerPortalCmd(value)
        row.item.sourceCmd = nextCmd
        row.item.cmd = nextCmd
      }
    } else if (field === 'name') {
      row.item.name = value
    } else if (field === 'logo') {
      row.item.logo = value
    } else if (field === 'cmd') {
      if (rowSourceType === 'stalker') {
        row.item.sourceCmd = value
        row.item.cmd = value
      } else {
        row.item.cmd = value
      }
    } else if (field === 'group') {
      return false
    } else {
      return false
    }

    this.markDirty()
    return true
  }

  moveActiveRowToGroup(nextGroup) {
    const rows = this.selectedRows()
    if (rows.length !== 1) return false
    const moved = this.moveItemsToGroup(rows, nextGroup)
    if (moved) this.markDirty()
    return moved
  }

  async persistCurrent() {
    const playlist = this.currentPlaylist()
    if (!playlist) return null
    this.cleanupPlaylistData(playlist)
    const updatedPlaylist = await updatePlaylist(playlist.id, {
      name: playlist.name,
      data: playlist.data,
      meta: playlist.meta
    })
    Object.assign(playlist, updatedPlaylist)
    this.clearDirty()
    this.syncDerived()
    return updatedPlaylist
  }
}
