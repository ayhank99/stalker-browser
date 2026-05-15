import {
  byId,
  initShell,
  loadPlaylists,
  setStatus
} from './app-core.js'
import {
  EditorStore,
  categoryKey
} from './editor-store.js'
import { createEditorRenderer } from './editor-renderer.js'

const refs = {
  playlistList: byId('editor-playlist-list'),
  categoryTree: byId('editor-category-tree'),
  toolbar: byId('editor-toolbar'),
  selectionLabel: byId('editor-selection-label'),
  toolbarMeta: byId('editor-toolbar-meta'),
  notice: byId('editor-notice'),
  bulkbar: byId('editor-bulkbar'),
  listTitle: byId('editor-list-title'),
  listMeta: byId('editor-list-meta'),
  masterCheck: byId('ed-chk-all'),
  channelList: byId('editor-channel-list'),
  inspector: byId('editor-inspector'),
  targetSelect: byId('editor-target-playlist'),
  search: byId('ed-search'),
  saveButton: byId('btn-save-editor'),
  sendSelectionButton: byId('btn-send-selection'),
  sendOpenSelectionButton: byId('btn-send-open-selection'),
  sendPublishSelectionButton: byId('btn-send-publish-selection'),
  createCuratedButton: byId('btn-create-curated'),
  addCategoryButton: byId('btn-add-category'),
  addRowButton: byId('btn-add-editor-row'),
  publishTvButton: byId('btn-publish-tv'),
  status: byId('ed-status'),
  actionMenu: byId('editor-action-menu')
}

let store = new EditorStore([])
const renderer = createEditorRenderer(refs)

let actionMenuState = null
let activeCategoryDrag = null
let activeRowDrag = null

function setEditorStatus(text, tone) {
  if (!refs.status) return
  refs.status.textContent = text || ''
  refs.status.style.color =
    tone === 'danger' ? 'var(--danger)' :
    tone === 'success' ? 'var(--success)' :
    tone === 'warning' ? 'var(--warning)' :
    'var(--muted)'
}

function closeActionMenu() {
  actionMenuState = null
  renderer.hideActionMenu()
}

function renderAll() {
  store.syncDerived()
  closeActionMenu()
  renderer.renderPlaylistSidebar(store)
  renderer.renderTargetSelect(store)
  renderer.renderCategoryTree(store)
  renderer.renderToolbar(store)
  renderer.renderBulkbar(store)
  renderer.renderChannelList(store)
  renderer.renderInspector(store)
}

function renderSelectionPanels() {
  renderer.renderCategoryTree(store)
  renderer.renderToolbar(store)
  renderer.renderBulkbar(store)
  renderer.renderChannelList(store)
  renderer.renderInspector(store)
}

function renderInspectorPanels() {
  renderer.renderCategoryTree(store)
  renderer.renderToolbar(store)
  renderer.renderBulkbar(store)
  renderer.renderInspector(store)
}

function renderSidebarPanels() {
  renderer.renderPlaylistSidebar(store)
  renderer.renderTargetSelect(store)
  renderer.renderCategoryTree(store)
  renderSelectionPanels()
}

function confirmLeaveDirtyState() {
  return !store.editorDirty || window.confirm('Kaydedilmemis degisiklikler var. Devam edersen taslak kaybolacak. Devam etmek istiyor musun?')
}

function focusSoon(selector) {
  window.setTimeout(() => {
    const field = document.querySelector(selector)
    if (field && typeof field.focus === 'function') {
      field.focus()
      if (typeof field.select === 'function') field.select()
    }
  }, 0)
}

function openActionMenu(state, anchor) {
  actionMenuState = state
  renderer.renderActionMenu(state, anchor, store)
}

async function saveCurrentPlaylist(message) {
  try {
    await store.persistCurrent()
    renderAll()
    setEditorStatus(message || 'Editor degisiklikleri kaydedildi', 'success')
    setStatus(message || 'Editor degisiklikleri kaydedildi')
  } catch (error) {
    setEditorStatus(error.message, 'danger')
    setStatus('Kaydetme hatasi: ' + error.message)
  }
}

function selectPlaylist(id, skipConfirm) {
  if (!skipConfirm && !confirmLeaveDirtyState()) return
  if (store.selectPlaylist(id)) {
    renderAll()
    setEditorStatus('', 'muted')
  }
}

async function sendSelectionToCurated(openTarget, publishTarget) {
  try {
    let targetId = refs.targetSelect.value
    if (!targetId && !store.getPreferredCuratedPlaylist()) {
      const name = window.prompt('Kurgu playlist adi', 'Benim Playlistim')
      if (!name) return
      const created = await store.createCuratedPlaylist(name)
      targetId = created.id
      store.setPreferredCuratedPlaylist(created.id)
    }
    const result = await store.sendSelectionToCurated(targetId)
    if ((openTarget || publishTarget) && result.targetPlaylist) {
      store.selectPlaylist(result.targetPlaylist.id)
      if (result.touchedTargets && result.touchedTargets.length) {
        store.clearCategorySelection()
        store.toggleCategorySelection(result.touchedTargets[0].kind, result.touchedTargets[0].group, true)
        store.setActiveCategory(result.touchedTargets[0].kind, result.touchedTargets[0].group)
      }
    }
    if (publishTarget && result.targetPlaylist) {
      await store.publishPlaylistById(result.targetPlaylist.id)
    }
    renderAll()
    setEditorStatus(
      publishTarget
        ? (result.targetPlaylist.name + " TV icin guncellendi")
        : (result.added + ' icerik kopyalandi'),
      'success'
    )
    setStatus(
      result.targetPlaylist.name + ' playlistine ' + result.added + ' icerik gonderildi' +
      (result.skipped ? ' | ' + result.skipped + ' tekrar atlandi' : '') +
      ((openTarget || publishTarget) ? ' | duzenlemeye acildi' : '') +
      (publishTarget ? " | TV'de yayinlaniyor" : '')
    )
  } catch (error) {
    setEditorStatus(error.message, 'danger')
    setStatus('Playliste gonderme hatasi: ' + error.message)
  }
}

async function publishCurrentToTv() {
  try {
    const current = await store.publishCurrentToTv()
    renderAll()
    setEditorStatus('TV yayini guncellendi', 'success')
    setStatus((current.name || 'Secili playlist') + ' TV sunucusunda yayinlanan playlist olarak ayarlandi')
  } catch (error) {
    setEditorStatus(error.message, 'danger')
    setStatus('TV yayin hatasi: ' + error.message)
  }
}

function handleAddCategory() {
  const playlist = store.currentPlaylist()
  if (!playlist) return
  const nextName = window.prompt('Yeni kategori adi', '')
  if (!nextName) return

  try {
    if (store.createCategory(store.editorKind, nextName)) {
      store.markDirty()
      renderAll()
      setEditorStatus('Yeni kategori olusturuldu', 'warning')
      setStatus('Yeni kategori olusturuldu')
      focusSoon('#inspector-category-name')
    }
  } catch (error) {
    setEditorStatus(error.message, 'danger')
  }
}

function handleDeleteSelectedRows() {
  const rows = store.selectedRows()
  if (!rows.length) return
  if (!window.confirm(rows.length + ' kanali silmek istiyor musunuz?')) return
  const removed = store.deleteSelectedRows()
  if (!removed) return
  renderAll()
  setEditorStatus(removed + ' kanal silindi, kaydetmen gerekiyor', 'warning')
  setStatus(removed + ' kanal silindi')
}

function handleDeleteTargetCategories() {
  const targets = store.effectiveCategoryTargets()
  if (!targets.length) return
  if (!window.confirm(targets.length + ' kategori ve altindaki tum kanallar silinecek. Devam edilsin mi?')) return
  const removed = store.deleteTargetCategories()
  if (!removed) return
  renderAll()
  setEditorStatus(removed + ' kategori silindi, kaydetmen gerekiyor', 'warning')
  setStatus(removed + ' kategori silindi')
}

function toggleTargetCategoriesVisibility() {
  const toggledHidden = store.toggleTargetCategoriesVisibility()
  renderAll()
  setEditorStatus(
    toggledHidden
      ? "Kategori TV cikisinda gizlendi, kaydetmen gerekiyor"
      : "Kategori TV cikisinda tekrar gosterilecek, kaydetmen gerekiyor",
    'warning'
  )
}

function duplicateSelectedRows() {
  const created = store.duplicateSelectedRows()
  if (!created) return
  renderAll()
  setEditorStatus(created + ' kopya olusturuldu, kaydetmen gerekiyor', 'warning')
}

function applyInspectorInput(event) {
  const field = event.target.getAttribute('data-inspector-field')
  if (!field || field === 'group') return
  const changed = store.updateActiveRowField(field, event.target.value)
  if (!changed) return
  if (field === 'id') {
    const rows = store.selectedRows()
    if (rows.length === 1) {
      const cmdField = refs.inspector.querySelector('[data-inspector-field="cmd"]')
      if (cmdField) cmdField.value = store.getCmdInputValue(rows[0].item, store.currentPlaylist())
    }
  }
  renderer.renderToolbar(store)
  renderer.renderChannelList(store)
  setEditorStatus('Alan guncellendi, kaydetmen gerekiyor', 'warning')
}

function applyInspectorChange(event) {
  const field = event.target.getAttribute('data-inspector-field')
  if (field !== 'group') return
  if (store.moveActiveRowToGroup(event.target.value)) {
    renderAll()
    setEditorStatus('Kanal yeni kategoriye tasindi, kaydetmen gerekiyor', 'warning')
  }
}

async function handleInspectorAction(event) {
  const action = event.target.getAttribute('data-inspector-action')
  if (!action) return

  if (action === 'rename-playlist') {
    const input = byId('inspector-playlist-name')
    if (input && store.renameCurrentPlaylist(input.value)) {
      renderAll()
      setEditorStatus('Playlist adi guncellendi, kaydetmen gerekiyor', 'warning')
    }
    return
  }

  if (action === 'create-category') {
    handleAddCategory()
    return
  }

  if (action === 'create-row') {
    store.addEditorRow()
    renderAll()
    setEditorStatus('Yeni kanal olusturuldu, kaydetmen gerekiyor', 'warning')
    focusSoon('[data-inspector-field="name"]')
    return
  }

  if (action === 'rename-category') {
    const targets = store.effectiveCategoryTargets()
    if (!targets.length) return
    const nextName = String(byId('inspector-category-name') ? byId('inspector-category-name').value : '').trim()
    if (!nextName) return
    try {
      if (store.renameCategory(targets[0].kind, targets[0].group, nextName)) {
        store.markDirty()
        renderAll()
        setEditorStatus('Kategori adi guncellendi, kaydetmen gerekiyor', 'warning')
      }
    } catch (error) {
      setEditorStatus(error.message, 'danger')
    }
    return
  }

  if (action === 'toggle-category' || action === 'toggle-selected-categories') {
    toggleTargetCategoriesVisibility()
    return
  }

  if (action === 'delete-category' || action === 'delete-selected-categories') {
    handleDeleteTargetCategories()
    return
  }

  if (action === 'clear-category-selection') {
    store.clearCategorySelection()
    renderAll()
    return
  }

  if (action === 'add-row-to-category') {
    const targets = store.effectiveCategoryTargets()
    if (!targets.length) return
    store.addEditorRow(targets[0].kind, targets[0].group)
    renderAll()
    setEditorStatus('Yeni kanal eklendi, kaydetmen gerekiyor', 'warning')
    focusSoon('[data-inspector-field="name"]')
    return
  }

  if (action === 'send-selected-categories' || action === 'send-selected-rows') {
    await sendSelectionToCurated(false, false)
    return
  }

  if (action === 'send-selected-categories-open' || action === 'send-selected-rows-open') {
    await sendSelectionToCurated(true, false)
    return
  }

  if (action === 'send-selected-categories-publish' || action === 'send-selected-rows-publish') {
    await sendSelectionToCurated(true, true)
    return
  }

  if (action === 'publish-playlist-tv') {
    await publishCurrentToTv()
    return
  }

  if (action === 'move-selected-rows') {
    const target = String(byId('bulk-row-group') ? byId('bulk-row-group').value : '').trim()
    if (!target) return
    if (store.moveSelectedRowsToGroup(target)) {
      renderAll()
      setEditorStatus('Kanallar yeni kategoriye tasindi, kaydetmen gerekiyor', 'warning')
    }
    return
  }

  if (action === 'apply-prefix') {
    const prefix = String(byId('bulk-prefix') ? byId('bulk-prefix').value : '')
    if (store.applyPrefix(prefix)) {
      renderAll()
      setEditorStatus('Prefix uygulandi, kaydetmen gerekiyor', 'warning')
    }
    return
  }

  if (action === 'apply-suffix') {
    const suffix = String(byId('bulk-suffix') ? byId('bulk-suffix').value : '')
    if (store.applySuffix(suffix)) {
      renderAll()
      setEditorStatus('Suffix uygulandi, kaydetmen gerekiyor', 'warning')
    }
    return
  }

  if (action === 'apply-replace') {
    const findText = String(byId('bulk-find') ? byId('bulk-find').value : '')
    const replaceText = String(byId('bulk-replace') ? byId('bulk-replace').value : '')
    if (store.applyReplace(findText, replaceText)) {
      renderAll()
      setEditorStatus('Bul degistir uygulandi, kaydetmen gerekiyor', 'warning')
    }
    return
  }

  if (action === 'duplicate-selected-rows' || action === 'duplicate-active-row') {
    duplicateSelectedRows()
    return
  }

  if (action === 'delete-selected-rows' || action === 'delete-active-row') {
    handleDeleteSelectedRows()
  }
}

function handleRowMenuAction(action) {
  const row = store.editorRows[actionMenuState ? Number(actionMenuState.index) : -1]
  if (!row) return

  if (action === 'inspect-row') {
    store.setSingleRowSelection(row, false)
    renderAll()
    return
  }

  if (action === 'send-row-to-playlist') {
    store.setSingleRowSelection(row, false)
    renderAll()
    sendSelectionToCurated(false)
    return
  }

  if (action === 'duplicate-row') {
    store.setSingleRowSelection(row, false)
    duplicateSelectedRows()
    return
  }

  if (action === 'focus-row-group') {
    store.setActiveCategory(store.editorKind, row.group)
    renderAll()
    return
  }

  if (action === 'delete-row') {
    store.setSingleRowSelection(row, false)
    handleDeleteSelectedRows()
  }
}

function handleCategoryMenuAction(action) {
  if (!actionMenuState) return
  const state = actionMenuState

  if (action === 'inspect-category') {
    store.clearCategorySelection()
    store.toggleCategorySelection(state.kind, state.group, true)
    store.setActiveCategory(state.kind, state.group)
    renderAll()
    return
  }

  if (action === 'send-category-to-playlist') {
    store.clearCategorySelection()
    store.toggleCategorySelection(state.kind, state.group, true)
    store.setActiveCategory(state.kind, state.group)
    renderAll()
    sendSelectionToCurated(false)
    return
  }

  if (action === 'add-channel') {
    store.setActiveCategory(state.kind, state.group)
    store.addEditorRow(state.kind, state.group)
    renderAll()
    focusSoon('[data-inspector-field="name"]')
    return
  }

  if (action === 'rename-category') {
    store.clearCategorySelection()
    store.toggleCategorySelection(state.kind, state.group, true)
    store.setActiveCategory(state.kind, state.group)
    renderAll()
    focusSoon('#inspector-category-name')
    return
  }

  if (action === 'toggle-category') {
    store.clearCategorySelection()
    store.toggleCategorySelection(state.kind, state.group, true)
    store.setActiveCategory(state.kind, state.group)
    toggleTargetCategoriesVisibility()
    return
  }

  if (action === 'delete-category') {
    store.clearCategorySelection()
    store.toggleCategorySelection(state.kind, state.group, true)
    store.setActiveCategory(state.kind, state.group)
    handleDeleteTargetCategories()
  }
}

function handleActionMenuClick(event) {
  const button = event.target.closest('button[data-menu-action]')
  if (!button) return
  const action = button.getAttribute('data-menu-action')
  if (!actionMenuState) return
  closeActionMenu()
  if (actionMenuState.type === 'row') {
    handleRowMenuAction(action)
  } else if (actionMenuState.type === 'category') {
    handleCategoryMenuAction(action)
  }
}

function handleBulkbarClick(event) {
  const action = event.target.getAttribute('data-bulk-action')
  if (!action) return

  if (action === 'send-rows' || action === 'send-categories') {
    sendSelectionToCurated(false, false)
    return
  }

  if (action === 'send-open-rows' || action === 'send-open-categories') {
    sendSelectionToCurated(true, false)
    return
  }

  if (action === 'send-publish-rows' || action === 'send-publish-categories') {
    sendSelectionToCurated(true, true)
    return
  }

  if (action === 'delete-rows') {
    handleDeleteSelectedRows()
    return
  }

  if (action === 'duplicate-rows') {
    duplicateSelectedRows()
    return
  }

  if (action === 'clear-row-selection') {
    store.clearRowSelection()
    renderSelectionPanels()
    return
  }

  if (action === 'toggle-categories') {
    toggleTargetCategoriesVisibility()
    return
  }

  if (action === 'delete-categories') {
    handleDeleteTargetCategories()
    return
  }

  if (action === 'clear-category-selection') {
    store.clearCategorySelection()
    renderInspectorPanels()
  }
}

function handleCategoryTreeClick(event) {
  const toggle = event.target.closest('button[data-tree-toggle-kind]')
  if (toggle) {
    const kind = toggle.getAttribute('data-kind')
    if (store.editorKind !== kind) {
      store.editorKind = kind
      store.editorGroup = '__all__'
      store.expandedKinds[kind] = true
    } else {
      store.expandedKinds[kind] = !store.expandedKinds[kind]
      if (!store.expandedKinds[kind]) store.editorGroup = '__all__'
    }
    store.activeRowItem = null
    store.clearRowSelection()
    store.syncDerived()
    renderAll()
    return
  }

  const menuButton = event.target.closest('button[data-open-menu="category"]')
  if (menuButton) {
    openActionMenu({
      type: 'category',
      kind: menuButton.getAttribute('data-kind'),
      group: menuButton.getAttribute('data-group')
    }, menuButton)
    return
  }

  const selectButton = event.target.closest('button[data-tree-select="group"]')
  if (selectButton) {
    const kind = selectButton.getAttribute('data-kind')
    const group = selectButton.getAttribute('data-group')
    if (event.ctrlKey || event.metaKey) {
      store.toggleCategorySelection(kind, group)
      store.setActiveCategory(kind, group)
      renderAll()
      return
    }
    store.clearCategorySelection()
    store.toggleCategorySelection(kind, group, true)
    store.setActiveCategory(kind, group)
    renderAll()
  }
}

function handleCategoryTreeChange(event) {
  const checkbox = event.target.closest('.editor-cat-chk')
  if (!checkbox) return
  store.toggleCategorySelection(checkbox.getAttribute('data-kind'), checkbox.getAttribute('data-group'), checkbox.checked)
  renderInspectorPanels()
}

function handleChannelListClick(event) {
  const menuButton = event.target.closest('button[data-open-menu="row"]')
  if (menuButton) {
    openActionMenu({
      type: 'row',
      index: menuButton.getAttribute('data-row-index')
    }, menuButton)
    return
  }

  const mainButton = event.target.closest('button[data-row-select]')
  if (mainButton) {
    const row = store.editorRows[Number(mainButton.getAttribute('data-row-index'))]
    if (!row) return
    store.setSingleRowSelection(row, event.ctrlKey || event.metaKey)
    renderSelectionPanels()
  }
}

function handleChannelListChange(event) {
  const checkbox = event.target.closest('.ed-chk')
  if (!checkbox) return
  store.toggleRowSelectionByIndex(checkbox.getAttribute('data-index'), checkbox.checked)
  renderSelectionPanels()
}

function handleMasterCheck(event) {
  store.toggleAllRows(event.target.checked)
  renderSelectionPanels()
}

function clearDragStates() {
  activeCategoryDrag = null
  activeRowDrag = null
  document.querySelectorAll('.drag-over').forEach((node) => node.classList.remove('drag-over'))
}

function handleCategoryDragStart(event) {
  const row = event.target.closest('.editor-tree-row[data-category-row]')
  if (!row || event.target.closest('input,button.editor-tree-menu-btn')) {
    event.preventDefault()
    return
  }

  activeCategoryDrag = {
    kind: row.getAttribute('data-kind'),
    group: row.getAttribute('data-group')
  }
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', activeCategoryDrag.group)
  }
}

function handleCategoryDragOver(event) {
  const row = event.target.closest('.editor-tree-row[data-category-row]')
  if (!row || (!activeCategoryDrag && !activeRowDrag)) return
  event.preventDefault()
  document.querySelectorAll('.drag-over').forEach((node) => node.classList.remove('drag-over'))
  row.classList.add('drag-over')
}

function handleCategoryDrop(event) {
  const row = event.target.closest('.editor-tree-row[data-category-row]')
  if (!row) return
  event.preventDefault()

  const targetKind = row.getAttribute('data-kind')
  const targetGroup = row.getAttribute('data-group')

  if (activeCategoryDrag && targetKind === activeCategoryDrag.kind) {
    const after = event.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2
    if (store.reorderCategory(activeCategoryDrag.kind, activeCategoryDrag.group, targetGroup, after)) {
      store.markDirty()
      renderAll()
      setEditorStatus('Kategori sirasi degisti, kaydetmen gerekiyor', 'warning')
    } else {
      clearDragStates()
    }
    return
  }

  if (activeRowDrag && targetKind === store.editorKind) {
    if (store.moveItemsToGroup([{ item: activeRowDrag.item, group: activeRowDrag.group, index: 0 }], targetGroup)) {
      store.markDirty()
      store.setActiveCategory(store.editorKind, targetGroup)
      store.selectedRowItems.clear()
      store.selectedRowItems.add(activeRowDrag.item)
      store.activeRowItem = activeRowDrag.item
      renderAll()
      setEditorStatus('Kanal yeni kategoriye suruklendi, kaydetmen gerekiyor', 'warning')
    } else {
      clearDragStates()
    }
  }
}

function handleRowDragStart(event) {
  const rowNode = event.target.closest('.editor-channel-row')
  if (!rowNode || event.target.closest('input,button.editor-row-menu-btn')) {
    event.preventDefault()
    return
  }

  const row = store.editorRows[Number(rowNode.getAttribute('data-row-index'))]
  if (!row) {
    event.preventDefault()
    return
  }

  activeRowDrag = {
    group: row.group,
    item: row.item
  }
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', row.group)
  }
}

function handleRowDragOver(event) {
  const row = event.target.closest('.editor-channel-row')
  if (!row || !activeRowDrag) return
  event.preventDefault()
  document.querySelectorAll('.drag-over').forEach((node) => node.classList.remove('drag-over'))
  row.classList.add('drag-over')
}

function handleRowDrop(event) {
  const rowNode = event.target.closest('.editor-channel-row')
  if (!rowNode || !activeRowDrag) return
  event.preventDefault()

  const targetRow = store.editorRows[Number(rowNode.getAttribute('data-row-index'))]
  if (!targetRow) {
    clearDragStates()
    return
  }

  const after = event.clientY > rowNode.getBoundingClientRect().top + rowNode.offsetHeight / 2
  if (store.reorderOrMoveRow(activeRowDrag.item, activeRowDrag.group, targetRow.item, targetRow.group, after)) {
    store.selectedRowItems.clear()
    store.selectedRowItems.add(activeRowDrag.item)
    store.activeRowItem = activeRowDrag.item
    store.markDirty()
    renderAll()
    setEditorStatus('Kanal sirasi degisti, kaydetmen gerekiyor', 'warning')
  } else {
    clearDragStates()
  }
}

function handleKeyboardMove(event) {
  if (event.target.closest('input, textarea, select')) return
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
  const direction = event.key === 'ArrowUp' ? -1 : 1

  if (store.selectedRowItems.size) {
    event.preventDefault()
    if (store.moveSelectedRowsByStep(direction)) {
      store.markDirty()
      renderAll()
      setEditorStatus(direction < 0 ? 'Secili kanallar yukari tasindi, kaydetmen gerekiyor' : 'Secili kanallar asagi tasindi, kaydetmen gerekiyor', 'warning')
    }
    return
  }

  if (!store.selectedCategoryKeys.size && store.editorGroup !== '__all__') {
    store.selectedCategoryKeys.add(categoryKey(store.editorKind, store.editorGroup))
  }

  if (store.selectedCategoryKeys.size) {
    event.preventDefault()
    if (store.moveSelectedCategoriesByStep(direction)) {
      store.markDirty()
      renderAll()
      setEditorStatus(direction < 0 ? 'Secili kategoriler yukari tasindi, kaydetmen gerekiyor' : 'Secili kategoriler asagi tasindi, kaydetmen gerekiyor', 'warning')
    }
  }
}

function handleDocumentClick(event) {
  if (!refs.actionMenu.classList.contains('hidden') &&
      !event.target.closest('#editor-action-menu') &&
      !event.target.closest('[data-open-menu]')) {
    closeActionMenu()
  }
}

function handleMenuShortcutClose(event) {
  if (event.key === 'Escape') closeActionMenu()
}

async function bootstrap() {
  initShell('editor')
  setStatus('Editor yukleniyor...')

  refs.playlistList.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-playlist-id]')
    if (!button) return
    selectPlaylist(button.getAttribute('data-playlist-id'))
  })

  refs.categoryTree.addEventListener('click', handleCategoryTreeClick)
  refs.categoryTree.addEventListener('change', handleCategoryTreeChange)
  refs.categoryTree.addEventListener('dragstart', handleCategoryDragStart)
  refs.categoryTree.addEventListener('dragover', handleCategoryDragOver)
  refs.categoryTree.addEventListener('dragleave', (event) => {
    const row = event.target.closest('.editor-tree-row[data-category-row]')
    if (row) row.classList.remove('drag-over')
  })
  refs.categoryTree.addEventListener('drop', handleCategoryDrop)
  refs.categoryTree.addEventListener('dragend', clearDragStates)

  refs.channelList.addEventListener('click', handleChannelListClick)
  refs.channelList.addEventListener('change', handleChannelListChange)
  refs.channelList.addEventListener('dragstart', handleRowDragStart)
  refs.channelList.addEventListener('dragover', handleRowDragOver)
  refs.channelList.addEventListener('dragleave', (event) => {
    const row = event.target.closest('.editor-channel-row')
    if (row) row.classList.remove('drag-over')
  })
  refs.channelList.addEventListener('drop', handleRowDrop)
  refs.channelList.addEventListener('dragend', clearDragStates)

  refs.search.addEventListener('input', (event) => {
    store.setSearchQuery(event.target.value)
    renderSelectionPanels()
  })

  refs.masterCheck.addEventListener('change', handleMasterCheck)
  refs.saveButton.addEventListener('click', () => saveCurrentPlaylist('Editor degisiklikleri kaydedildi'))
  refs.targetSelect.addEventListener('change', (event) => {
    store.setPreferredCuratedPlaylist(event.target.value)
    renderer.renderToolbar(store)
  })
  refs.createCuratedButton.addEventListener('click', async () => {
    const name = window.prompt('Yeni kurgu playlist adi', 'Benim Playlistim')
    if (!name) return
    try {
      const created = await store.createCuratedPlaylist(name)
      renderAll()
      if (confirmLeaveDirtyState()) {
        selectPlaylist(created.id, true)
        setStatus('Kurgu playlist olusturuldu ve acildi: ' + String(created.name || '').trim())
      } else {
        setStatus('Kurgu playlist olusturuldu: ' + String(created.name || '').trim() + '. Soldaki listeden acabilirsin.')
      }
    } catch (error) {
      setStatus('Kurgu playlist olusturulamadi: ' + error.message)
      setEditorStatus(error.message, 'danger')
    }
  })
  refs.sendSelectionButton.addEventListener('click', function() { sendSelectionToCurated(false, false) })
  refs.sendOpenSelectionButton.addEventListener('click', function() { sendSelectionToCurated(true, false) })
  refs.sendPublishSelectionButton.addEventListener('click', function() { sendSelectionToCurated(true, true) })
  refs.addRowButton.addEventListener('click', () => {
    store.addEditorRow()
    renderAll()
    setEditorStatus('Yeni kanal olusturuldu, kaydetmen gerekiyor', 'warning')
    focusSoon('[data-inspector-field="name"]')
  })
  refs.addCategoryButton.addEventListener('click', handleAddCategory)
  refs.publishTvButton.addEventListener('click', publishCurrentToTv)

  refs.bulkbar.addEventListener('click', handleBulkbarClick)
  refs.inspector.addEventListener('input', applyInspectorInput)
  refs.inspector.addEventListener('change', applyInspectorChange)
  refs.inspector.addEventListener('click', handleInspectorAction)
  refs.actionMenu.addEventListener('click', handleActionMenuClick)

  document.addEventListener('click', handleDocumentClick)
  document.addEventListener('keydown', handleKeyboardMove)
  document.addEventListener('keydown', handleMenuShortcutClose)
  window.addEventListener('scroll', closeActionMenu, true)
  window.addEventListener('resize', closeActionMenu)

  try {
    const playlists = await loadPlaylists()
    store = new EditorStore(playlists)
    renderAll()
    setEditorStatus('', 'muted')
    setStatus('Editor hazir')
  } catch (error) {
    setStatus('Editor yukleme hatasi: ' + error.message)
    setEditorStatus(error.message, 'danger')
  }
}

bootstrap()
