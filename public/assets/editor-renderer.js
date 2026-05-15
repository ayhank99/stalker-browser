import {
  countChannels,
  setRight,
  typeLabel
} from './app-core.js'
import {
  KIND_CONFIG,
  categoryKey,
  shortText
} from './editor-store.js'

function appendChild(node, child) {
  if (child == null || child === false) return
  if (Array.isArray(child)) {
    child.forEach((entry) => appendChild(node, entry))
    return
  }
  if (child instanceof Node) {
    node.appendChild(child)
    return
  }
  node.appendChild(document.createTextNode(String(child)))
}

function el(tagName, options) {
  const node = document.createElement(tagName)
  const opts = options || {}

  if (opts.className) node.className = opts.className
  if (opts.id) node.id = opts.id
  if (opts.type) node.type = opts.type
  if (opts.text != null) node.textContent = String(opts.text)
  if (opts.value != null) node.value = String(opts.value)
  if (opts.placeholder != null) node.placeholder = String(opts.placeholder)
  if (opts.rows != null) node.rows = Number(opts.rows)
  if (opts.checked != null) node.checked = !!opts.checked
  if (opts.disabled != null) node.disabled = !!opts.disabled
  if (opts.draggable != null) node.draggable = !!opts.draggable
  if (opts.title != null) node.title = String(opts.title)
  if (opts.htmlFor != null) node.htmlFor = String(opts.htmlFor)
  if (opts.list != null) node.setAttribute('list', String(opts.list))

  if (opts.dataset) {
    Object.keys(opts.dataset).forEach((key) => {
      if (opts.dataset[key] != null) node.dataset[key] = String(opts.dataset[key])
    })
  }

  if (opts.attrs) {
    Object.keys(opts.attrs).forEach((key) => {
      if (opts.attrs[key] != null) node.setAttribute(key, String(opts.attrs[key]))
    })
  }

  for (let index = 2; index < arguments.length; index += 1) {
    appendChild(node, arguments[index])
  }

  return node
}

function clearNode(node) {
  if (node) node.replaceChildren()
}

function button(label, className, dataset, extra) {
  return el('button', Object.assign({
    type: 'button',
    className: className,
    text: label,
    dataset: dataset || {}
  }, extra || {}))
}

function emptyState(message, className) {
  return el('div', { className: className || 'empty', text: message })
}

function miniStat(value, label) {
  return el('div', { className: 'editor-mini-stat' },
    el('strong', { text: value }),
    el('span', { text: label })
  )
}

function inspectorSection(label, field, note) {
  const section = el('div', { className: 'editor-inspector-section' })
  if (label) {
    section.appendChild(el('label', { className: 'field-label', text: label }))
  }
  appendChild(section, field)
  if (note) {
    section.appendChild(el('div', { className: 'editor-inline-note', text: note }))
  }
  return section
}

function inspectorActions(definitions) {
  return el('div', { className: 'editor-inspector-actions' },
    definitions.map((definition) => {
      return button(definition.label, definition.className || 'btn btn-gray btn-sm', null, {
        dataset: { inspectorAction: definition.action }
      })
    })
  )
}

function createTagList(items) {
  return el('div', { className: 'editor-tag-list' },
    items.map((value) => el('span', { className: 'editor-tag', text: value }))
  )
}

function channelRowMeta(row) {
  return row.group + ' | ID: ' + (row.item.id || '-')
}

function renderOverviewInspector(store) {
  const playlist = store.currentPlaylist()
  const cardGrid = el('div', { className: 'editor-inspector-card-grid' },
    miniStat(store.totalForKind(playlist, 'live'), 'Live TV'),
    miniStat(store.totalForKind(playlist, 'movies'), 'Movies'),
    miniStat(store.totalForKind(playlist, 'series'), 'Series'),
    miniStat(store.groupsForKind(playlist, store.editorKind).length, 'Aktif kategori')
  )

  const playlistNameInput = el('input', {
    type: 'text',
    id: 'inspector-playlist-name',
    value: playlist.name || ''
  })

  const curated = store.isCuratedPlaylist(playlist)
  const actions = curated
    ? [
        { label: 'Playlist Adini Uygula', action: 'rename-playlist', className: 'btn btn-primary btn-sm' },
        { label: 'TV\'ye Yayinla', action: 'publish-playlist-tv', className: 'btn btn-gray btn-sm' },
        { label: 'Yeni Kategori', action: 'create-category', className: 'btn btn-gray btn-sm' },
        { label: 'Yeni Kanal', action: 'create-row', className: 'btn btn-gray btn-sm' }
      ]
    : [
        { label: 'Playlist Adini Uygula', action: 'rename-playlist', className: 'btn btn-primary btn-sm' },
        { label: 'TV\'ye Yayinla', action: 'publish-playlist-tv', className: 'btn btn-gray btn-sm' }
      ]

  return [
    el('div', { className: 'editor-inspector-head' },
      el('div', {},
        el('div', { className: 'editor-inspector-title', text: playlist.name }),
        el('div', { className: 'editor-inspector-subtitle', text: typeLabel(playlist.type) + ' playlisti' })
      )
    ),
    inspectorSection(
      'Playlist adi',
      playlistNameInput,
      curated
        ? 'Bu kurgu playlist bagimsizdir. Adini degistirebilir, yeni kategori acabilir ve kanallari tamamen manuel duzenleyebilirsin.'
        : 'Kaynak playlistin gorunen adini degistirebilirsin. Kaynak baglantisi ve sync ayarlari korunur.'
    ),
    cardGrid,
    inspectorSection(
      'Calisma Mantigi',
      el('p', { className: 'muted', text: 'Sol agactan kategori sec, ortadaki listede kanallari gor, sag panelden detay duzenle. Sol tik menu ve surukle-birak ile hizli calis.' })
    ),
    inspectorActions(actions)
  ]
}

function renderCategoryInspector(store, targets) {
  const playlist = store.currentPlaylist()

  if (targets.length > 1) {
    return [
      el('div', { className: 'editor-inspector-head' },
        el('div', {},
          el('div', { className: 'editor-inspector-title', text: targets.length + ' kategori secili' }),
          el('div', { className: 'editor-inspector-subtitle', text: 'Toplu kategori islemleri' })
        )
      ),
      inspectorSection('Secili kategoriler', createTagList(targets.map((target) => target.group))),
      inspectorActions([
        { label: 'Playliste Gonder', action: 'send-selected-categories', className: 'btn btn-primary btn-sm' },
        { label: 'Gonder ve Ac', action: 'send-selected-categories-open', className: 'btn btn-gray btn-sm' },
        { label: "TV'ye Gonder", action: 'send-selected-categories-publish', className: 'btn btn-primary btn-sm' },
        { label: 'TV Gizle/Goster', action: 'toggle-selected-categories', className: 'btn btn-gray btn-sm' },
        { label: 'Kategorileri Sil', action: 'delete-selected-categories', className: 'btn btn-red btn-sm' },
        { label: 'Secimi Temizle', action: 'clear-category-selection', className: 'btn btn-gray btn-sm' }
      ])
    ]
  }

  const target = targets[0]
  const hidden = store.isCategoryHidden(playlist, target.kind, target.group)
  const targetKindLabel = (KIND_CONFIG.find((entry) => entry.kind === target.kind) || store.selectedKindConfig()).label
  const nameInput = el('input', {
    type: 'text',
    id: 'inspector-category-name',
    value: target.group
  })

  return [
    el('div', { className: 'editor-inspector-head' },
      el('div', {},
        el('div', { className: 'editor-inspector-title', text: target.group }),
        el('div', { className: 'editor-inspector-subtitle', text: targetKindLabel + ' kategorisi' })
      )
    ),
    el('div', { className: 'editor-inspector-card-grid' },
      miniStat(store.itemCountForGroup(playlist, target.kind, target.group), 'Kanal'),
      miniStat(hidden ? 'Kapali' : 'Acik', 'TV durumu')
    ),
    inspectorSection('Kategori adi', nameInput, 'Kategori adini degistirmek grup anahtarini da gunceller.'),
    inspectorActions([
      { label: 'Playliste Gonder', action: 'send-selected-categories', className: 'btn btn-primary btn-sm' },
      { label: 'Gonder ve Ac', action: 'send-selected-categories-open', className: 'btn btn-gray btn-sm' },
      { label: "TV'ye Gonder", action: 'send-selected-categories-publish', className: 'btn btn-primary btn-sm' },
      { label: 'Adi Uygula', action: 'rename-category', className: 'btn btn-gray btn-sm' },
      { label: 'Bu Kategoriye Kanal Ekle', action: 'add-row-to-category', className: 'btn btn-gray btn-sm' },
      { label: hidden ? "TV'de Goster" : "TV'de Gizle", action: 'toggle-category', className: 'btn btn-gray btn-sm' },
      { label: 'Kategoriyi Sil', action: 'delete-category', className: 'btn btn-red btn-sm' }
    ])
  ]
}

function renderRowInspector(store, rows) {
  const playlist = store.currentPlaylist()

  if (rows.length > 1) {
    const bulkMove = el('input', {
      type: 'text',
      id: 'bulk-row-group',
      placeholder: 'Hedef kategori'
    })
    const inlineGrid = el('div', { className: 'editor-inline-grid' },
      el('input', { type: 'text', id: 'bulk-prefix', placeholder: 'Prefix' }),
      button('Ekle', 'btn btn-gray btn-sm', { inspectorAction: 'apply-prefix' }),
      el('input', { type: 'text', id: 'bulk-suffix', placeholder: 'Suffix' }),
      button('Ekle', 'btn btn-gray btn-sm', { inspectorAction: 'apply-suffix' }),
      el('input', { type: 'text', id: 'bulk-find', placeholder: 'Bul' }),
      el('input', { type: 'text', id: 'bulk-replace', placeholder: 'Degistir' }),
      button('Uygula', 'btn btn-gray btn-sm', { inspectorAction: 'apply-replace' })
    )

    return [
      el('div', { className: 'editor-inspector-head' },
        el('div', {},
          el('div', { className: 'editor-inspector-title', text: rows.length + ' kanal secili' }),
          el('div', { className: 'editor-inspector-subtitle', text: 'Toplu kanal islemleri' })
        )
      ),
      inspectorSection('Toplu tasima', bulkMove, 'Secili kanallari bu kategoriye tasir. Yeni kategori adi da yazabilirsin.'),
      inspectorSection('Isim islemleri', inlineGrid),
      inspectorActions([
        { label: 'Playliste Gonder', action: 'send-selected-rows', className: 'btn btn-primary btn-sm' },
        { label: 'Gonder ve Ac', action: 'send-selected-rows-open', className: 'btn btn-gray btn-sm' },
        { label: "TV'ye Gonder", action: 'send-selected-rows-publish', className: 'btn btn-primary btn-sm' },
        { label: 'Secilenleri Tasi', action: 'move-selected-rows', className: 'btn btn-gray btn-sm' },
        { label: 'Kopyala', action: 'duplicate-selected-rows', className: 'btn btn-gray btn-sm' },
        { label: 'Secilenleri Sil', action: 'delete-selected-rows', className: 'btn btn-red btn-sm' }
      ])
    ]
  }

  const row = rows[0]
  const rowSourceType = store.getItemSourceType(row.item, playlist)
  const cmdLabel = rowSourceType === 'stalker' ? 'Portal CMD' : 'Stream URL'
  const datalistId = 'editor-group-options'
  const groupInput = el('input', {
    type: 'text',
    list: datalistId,
    value: row.group,
    dataset: { inspectorField: 'group' }
  })
  const datalist = el('datalist', { id: datalistId },
    store.groupsForKind(playlist, store.editorKind).map((group) => el('option', { attrs: { value: group } }))
  )

  return [
    el('div', { className: 'editor-inspector-head' },
      el('div', {},
        el('div', { className: 'editor-inspector-title', text: row.item.name || 'Isimsiz Kanal' }),
        el('div', { className: 'editor-inspector-subtitle', text: row.group })
      )
    ),
    inspectorSection(rowSourceType === 'stalker' ? 'Stalker ID' : 'ID', el('input', {
      type: 'text',
      value: row.item.id || '',
      dataset: { inspectorField: 'id' }
    })),
    inspectorSection('Kanal adi', el('input', {
      type: 'text',
      value: row.item.name || '',
      dataset: { inspectorField: 'name' }
    })),
    inspectorSection('Kategori', [groupInput, datalist]),
    inspectorSection('Logo URL', el('input', {
      type: 'text',
      value: row.item.logo || '',
      dataset: { inspectorField: 'logo' }
    })),
    inspectorSection(
      cmdLabel,
      el('textarea', {
        rows: 5,
        value: store.getCmdInputValue(row.item, playlist),
        dataset: { inspectorField: 'cmd' }
      }),
      rowSourceType === 'stalker'
        ? 'Stalker kayitlarinda burada gecici token linki degil, portal komutu tutulur.'
        : ''
    ),
    inspectorActions([
      { label: 'Playliste Gonder', action: 'send-selected-rows', className: 'btn btn-primary btn-sm' },
      { label: 'Gonder ve Ac', action: 'send-selected-rows-open', className: 'btn btn-gray btn-sm' },
      { label: "TV'ye Gonder", action: 'send-selected-rows-publish', className: 'btn btn-primary btn-sm' },
      { label: 'Kopya Olustur', action: 'duplicate-active-row', className: 'btn btn-gray btn-sm' },
      { label: 'Kanali Sil', action: 'delete-active-row', className: 'btn btn-red btn-sm' }
    ])
  ]
}

export function createEditorRenderer(refs) {
  function renderPlaylistSidebar(store) {
    clearNode(refs.playlistList)
    if (!store.playlists.length) {
      refs.playlistList.appendChild(emptyState('Playlist yok'))
      return
    }

    const fragment = document.createDocumentFragment()
    store.playlists.forEach((playlist) => {
      const isPublished = !!(playlist && playlist.meta && playlist.meta.tvPublished)
      fragment.appendChild(
        el('button', {
          type: 'button',
          className: 'editor-playlist-item ' + (store.editorPlaylistId === playlist.id ? 'active' : ''),
          dataset: { playlistId: playlist.id }
        },
          el('div', { className: 'epl-name' },
            playlist.name,
            isPublished ? el('span', { className: 'editor-hidden-pill', text: 'TV' }) : null
          ),
          el('div', { className: 'muted', text: typeLabel(playlist.type) + ' | ' + countChannels(playlist.data) + ' icerik' })
        )
      )
    })
    refs.playlistList.appendChild(fragment)
  }

  function renderTargetSelect(store) {
    clearNode(refs.targetSelect)
    refs.targetSelect.appendChild(el('option', { attrs: { value: '' }, text: 'Kurgu playlist sec' }))
    const currentTarget = store.getPreferredCuratedPlaylist()
    store.curatedPlaylists().forEach((playlist) => {
      refs.targetSelect.appendChild(el('option', {
        attrs: { value: playlist.id },
        text: playlist.name
      }))
    })
    refs.targetSelect.value = currentTarget ? currentTarget.id : ''
  }

  function renderCategoryTree(store) {
    clearNode(refs.categoryTree)
    const playlist = store.currentPlaylist()
    if (!playlist) {
      refs.categoryTree.appendChild(emptyState('Soldan playlist secin'))
      return
    }

    KIND_CONFIG.forEach((entry) => {
      const groups = store.groupsForKind(playlist, entry.kind)
      const isExpanded = !!store.expandedKinds[entry.kind]
      const activeKind = store.editorKind === entry.kind && store.editorGroup === '__all__'

      const treeGroup = el('div', { className: 'editor-tree-group' })
      treeGroup.appendChild(
        el('button', {
          type: 'button',
          className: 'editor-tree-kind ' + (activeKind ? 'active' : ''),
          dataset: { treeToggleKind: '1', kind: entry.kind }
        },
          el('span', { className: 'editor-tree-chevron', text: isExpanded ? '▾' : '▸' }),
          el('span', { className: 'cat-dot ' + entry.dot }),
          el('span', { className: 'editor-tree-kind-name', text: entry.label }),
          el('span', { className: 'sub-cnt', text: store.totalForKind(playlist, entry.kind) })
        )
      )

      const children = el('div', { className: 'editor-tree-children' + (isExpanded ? '' : ' hidden') })
      if (groups.length) {
        groups.forEach((group) => {
          const key = categoryKey(entry.kind, group)
          const active = store.editorKind === entry.kind && store.editorGroup === group
          const checked = store.selectedCategoryKeys.has(key)
          const hidden = store.isCategoryHidden(playlist, entry.kind, group)
          const row = el('div', {
            className: 'editor-tree-row ' + (active ? 'active' : ''),
            draggable: true,
            dataset: {
              categoryRow: '1',
              kind: entry.kind,
              group: group
            }
          },
            el('input', {
              className: 'editor-cat-chk',
              type: 'checkbox',
              checked: checked,
              dataset: { kind: entry.kind, group: group }
            }),
            el('button', {
              type: 'button',
              className: 'editor-tree-item',
              dataset: { treeSelect: 'group', kind: entry.kind, group: group }
            },
              el('span', { className: 'editor-drag-grip', text: '⋮⋮', attrs: { 'aria-hidden': 'true' } }),
              el('span', { className: 'editor-tree-name', text: group }),
              hidden ? el('span', { className: 'editor-hidden-pill', text: 'TV kapali' }) : null,
              el('span', { className: 'sub-cnt', text: store.itemCountForGroup(playlist, entry.kind, group) })
            ),
            button('Menu', 'editor-tree-menu-btn', { openMenu: 'category', kind: entry.kind, group: group })
          )
          children.appendChild(row)
        })
      } else {
        children.appendChild(el('div', { className: 'muted editor-tree-empty', text: 'Kategori yok' }))
      }

      treeGroup.appendChild(children)
      refs.categoryTree.appendChild(treeGroup)
    })
  }

  function renderToolbar(store) {
    const playlist = store.currentPlaylist()
    refs.toolbar.classList.toggle('hidden', !playlist)
    refs.bulkbar.classList.add('hidden')
    refs.saveButton.disabled = !store.editorDirty

    if (!playlist) {
      refs.selectionLabel.textContent = 'Secim yok'
      refs.toolbarMeta.textContent = 'Playlist secin'
      refs.notice.textContent = ''
      refs.sendSelectionButton.disabled = true
      refs.sendOpenSelectionButton.disabled = true
      refs.sendPublishSelectionButton.disabled = true
      refs.publishTvButton.disabled = true
      refs.publishTvButton.textContent = "TV'ye Yayinla"
      return
    }

    refs.selectionLabel.textContent = store.currentSelectionLabel()
    refs.toolbarMeta.textContent = typeLabel(playlist.type) + ' | ' + countChannels(playlist.data) + ' icerik | ' + store.editorRows.length + ' gorunen'
    refs.notice.textContent = playlist.type === 'stalker'
      ? 'Stalker playlistlerde Portal CMD tutulur. Player ve TV sunucusu bu komutu anlik stream linkine cevirir.'
      : store.isCuratedPlaylist(playlist)
        ? 'Bu kurgu playlist kaynaktan bagimsizdir. Kaynak listeleri tekrar sync etsen bile burada ekledigin kategori ve kanallar bozulmaz.'
        : 'Kaynak playlistlerden secili kanal veya kategorileri ustteki hedefe gondererek kendi kalici kurgu playlistini olusturabilirsin.'
    const hasSelection = !!(store.selectedRows().length || store.effectiveCategoryTargets().length)
    refs.sendSelectionButton.disabled = !hasSelection
    refs.sendOpenSelectionButton.disabled = !hasSelection
    refs.sendPublishSelectionButton.disabled = !hasSelection
    refs.publishTvButton.disabled = false
    refs.publishTvButton.textContent = playlist.meta && playlist.meta.tvPublished ? "TV'de Yayinlaniyor" : "TV'ye Yayinla"
  }

  function renderBulkbar(store) {
    clearNode(refs.bulkbar)
    const rows = store.selectedRows()
    const categories = store.selectedCategoryEntries()

    if (rows.length) {
      refs.bulkbar.appendChild(
        el('div', { className: 'editor-bulk-copy' }, rows.length + ' kanal secili')
      )
      refs.bulkbar.appendChild(
        el('div', { className: 'editor-bulk-actions' },
          button('Playliste Gonder', 'btn btn-primary btn-sm', { bulkAction: 'send-rows' }),
          button('Gonder ve Ac', 'btn btn-gray btn-sm', { bulkAction: 'send-open-rows' }),
          button("TV'ye Gonder", 'btn btn-primary btn-sm', { bulkAction: 'send-publish-rows' }),
          button('Secilenleri Sil', 'btn btn-red btn-sm', { bulkAction: 'delete-rows' }),
          button('Kopyala', 'btn btn-gray btn-sm', { bulkAction: 'duplicate-rows' }),
          button('Secimi Temizle', 'btn btn-gray btn-sm', { bulkAction: 'clear-row-selection' })
        )
      )
      refs.bulkbar.classList.remove('hidden')
      return
    }

    if (categories.length) {
      refs.bulkbar.appendChild(
        el('div', { className: 'editor-bulk-copy' }, categories.length + ' kategori secili')
      )
      refs.bulkbar.appendChild(
        el('div', { className: 'editor-bulk-actions' },
          button('Playliste Gonder', 'btn btn-primary btn-sm', { bulkAction: 'send-categories' }),
          button('Gonder ve Ac', 'btn btn-gray btn-sm', { bulkAction: 'send-open-categories' }),
          button("TV'ye Gonder", 'btn btn-primary btn-sm', { bulkAction: 'send-publish-categories' }),
          button('TV Gizle/Goster', 'btn btn-gray btn-sm', { bulkAction: 'toggle-categories' }),
          button('Kategorileri Sil', 'btn btn-red btn-sm', { bulkAction: 'delete-categories' }),
          button('Secimi Temizle', 'btn btn-gray btn-sm', { bulkAction: 'clear-category-selection' })
        )
      )
      refs.bulkbar.classList.remove('hidden')
      return
    }

    refs.bulkbar.classList.add('hidden')
  }

  function renderListHead(store) {
    const playlist = store.currentPlaylist()
    if (!playlist) {
      refs.listTitle.textContent = 'Kanal Listesi'
      refs.listMeta.textContent = 'Soldan playlist ve kategori secin'
      refs.masterCheck.checked = false
      return
    }

    const groupLabel = store.editorGroup === '__all__' ? 'Tum kategoriler' : store.editorGroup
    refs.listTitle.textContent = store.selectedKindConfig().label + ' / ' + groupLabel
    refs.listMeta.textContent = store.editorRows.length + ' kanal gorunuyor'
  }

  function renderChannelList(store) {
    clearNode(refs.channelList)
    renderListHead(store)

    const playlist = store.currentPlaylist()
    if (!playlist) {
      refs.channelList.appendChild(emptyState('Soldan bir playlist secin'))
      refs.masterCheck.checked = false
      setRight('')
      return
    }

    const allSelected = store.editorRows.length > 0 && store.editorRows.every((row) => store.selectedRowItems.has(row.item))
    refs.masterCheck.checked = allSelected

    if (!store.editorRows.length) {
      refs.channelList.appendChild(emptyState('Bu secimde kanal bulunamadi'))
      setRight('0 kanal')
      return
    }

    const fragment = document.createDocumentFragment()
    store.editorRows.forEach((row, index) => {
      const selected = store.selectedRowItems.has(row.item)
      const active = store.activeRowItem === row.item || (selected && store.selectedRowItems.size === 1)
      const preview = store.getCmdInputValue(row.item, playlist)
      fragment.appendChild(
        el('div', {
          className: 'editor-channel-row ' + (selected ? 'selected ' : '') + (active ? 'active' : ''),
          draggable: true,
          dataset: { rowIndex: index }
        },
          el('label', { className: 'editor-check-wrap' },
            el('input', {
              className: 'ed-chk',
              type: 'checkbox',
              checked: selected,
              dataset: { index: index }
            })
          ),
          el('button', {
            type: 'button',
            className: 'editor-channel-main',
            dataset: { rowSelect: '1', rowIndex: index }
          },
            el('span', { className: 'editor-drag-grip', text: '⋮⋮', attrs: { 'aria-hidden': 'true' } }),
            el('span', { className: 'editor-channel-copy' },
              el('span', { className: 'editor-channel-title', text: row.item.name || 'Isimsiz Kanal' }),
              el('span', { className: 'editor-channel-meta', text: channelRowMeta(row) })
            )
          ),
          el('div', { className: 'editor-channel-side' },
            el('div', {
              className: 'editor-channel-preview',
              text: shortText(preview, 64),
              title: preview
            }),
            button('Menu', 'editor-row-menu-btn', { openMenu: 'row', rowIndex: index })
          )
        )
      )
    })

    refs.channelList.appendChild(fragment)
    setRight(store.editorRows.length + ' kanal')
  }

  function renderInspector(store) {
    clearNode(refs.inspector)
    const playlist = store.currentPlaylist()
    if (!playlist) {
      refs.inspector.appendChild(emptyState('Detaylar burada gorunur'))
      return
    }

    const rows = store.selectedRows()
    const categories = store.effectiveCategoryTargets()
    const nodes = rows.length
      ? renderRowInspector(store, rows)
      : categories.length
        ? renderCategoryInspector(store, categories)
        : renderOverviewInspector(store)

    nodes.forEach((node) => refs.inspector.appendChild(node))
  }

  function hideActionMenu() {
    refs.actionMenu.classList.add('hidden')
    clearNode(refs.actionMenu)
  }

  function renderActionMenu(state, anchor, store) {
    if (!state || !anchor) {
      hideActionMenu()
      return
    }

    clearNode(refs.actionMenu)

    if (state.type === 'category') {
      const playlist = store.currentPlaylist()
      const hidden = playlist ? store.isCategoryHidden(playlist, state.kind, state.group) : false
      refs.actionMenu.append(
        button('Detayi Ac', '', { menuAction: 'inspect-category' }),
        button('Playliste Gonder', '', { menuAction: 'send-category-to-playlist' }),
        button('Bu Kategoriye Kanal Ekle', '', { menuAction: 'add-channel' }),
        button('Yeniden Adlandir', '', { menuAction: 'rename-category' }),
        button(hidden ? "TV'de Goster" : "TV'de Gizle", '', { menuAction: 'toggle-category' }),
        button('Kategoriyi Sil', 'danger', { menuAction: 'delete-category' })
      )
    } else if (state.type === 'row') {
      refs.actionMenu.append(
        button('Detayi Ac', '', { menuAction: 'inspect-row' }),
        button('Playliste Gonder', '', { menuAction: 'send-row-to-playlist' }),
        button('Kopya Olustur', '', { menuAction: 'duplicate-row' }),
        button('Kategoriye Git', '', { menuAction: 'focus-row-group' }),
        button('Kanali Sil', 'danger', { menuAction: 'delete-row' })
      )
    } else {
      hideActionMenu()
      return
    }

    const rect = anchor.getBoundingClientRect()
    refs.actionMenu.style.left = Math.min(window.innerWidth - 240, rect.left) + 'px'
    refs.actionMenu.style.top = Math.min(window.innerHeight - 260, rect.bottom + 8) + 'px'
    refs.actionMenu.classList.remove('hidden')
  }

  return {
    renderPlaylistSidebar,
    renderTargetSelect,
    renderCategoryTree,
    renderToolbar,
    renderBulkbar,
    renderChannelList,
    renderInspector,
    renderActionMenu,
    hideActionMenu
  }
}
