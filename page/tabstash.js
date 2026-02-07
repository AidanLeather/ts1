/**
 * TabStash – Full-page management UI
 *
 * This is the main interface at chrome-extension://…/page/tabstash.html.
 * It can also replace the new-tab page via chrome_url_overrides.
 *
 * Architecture:
 *   - State is loaded from chrome.storage.local via lib/storage.js
 *   - Views: "all", "duplicates", "archived", or a specific collection id
 *   - Keyboard shortcuts: / = focus search, Esc = clear/close, Cmd+K = palette
 *   - Google favicon service for reliable icons:
 *     https://www.google.com/s2/favicons?domain=DOMAIN&sz=32
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// ── State ──────────────────────────────────────────────
let state = {
  collections: [],
  urlIndex: {},
  settings: {},
  currentView: 'all',    // 'all' | 'duplicates' | 'archived' | collection-id
  searchQuery: '',
  moveTabId: null,
  moveSourceColId: null,
};

// ── Init ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadData();
  render();
  bindEvents();
  bindKeyboard();
});

async function loadData() {
  const data = await TabStashStorage.getAll();
  state.collections = data.collections;
  state.urlIndex = data.urlIndex;
  state.settings = data.settings;
}

// ── Favicon helper ─────────────────────────────────────
/**
 * We use Google's public favicon service instead of relying on the
 * favIconUrl stored when the tab was saved. Reasons:
 *   1. Stored favIconUrl may be a data: URI (large) or chrome:// (blocked)
 *   2. Google's service normalises icons and serves reliable 32px PNGs
 *   3. Works even if the original page didn't expose a favicon
 */
function faviconUrl(url) {
  try {
    const domain = new URL(url).hostname;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`;
  } catch {
    return '';
  }
}

// ── Event binding ──────────────────────────────────────
function bindEvents() {
  // Sidebar nav
  $$('.nav-item[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.currentView = btn.dataset.view;
      state.searchQuery = '';
      $('#search').value = '';
      render();
    });
  });

  // Search
  $('#search').addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    render();
  });

  // Save all tabs
  $('#save-all-btn').addEventListener('click', saveAllTabs);

  // Merge all duplicates
  $('#merge-all-btn').addEventListener('click', async () => {
    const removed = await TabStashStorage.mergeAllDuplicates();
    if (removed > 0) {
      showToast(`Merged ${removed} duplicate${removed !== 1 ? 's' : ''}`);
      await loadData();
      render();
    } else {
      showToast('No duplicates to merge');
    }
  });

  // New collection
  $('#new-collection-btn').addEventListener('click', async () => {
    const name = prompt('Collection name:');
    if (name && name.trim()) {
      const col = await TabStashStorage.addCollection(name.trim(), []);
      await loadData();
      state.currentView = col.id;
      render();
    }
  });

  // Settings button
  $('#settings-btn').addEventListener('click', openSettings);
  $('#settings-close-btn').addEventListener('click', closeSettings);
  $('#settings-overlay .modal-backdrop').addEventListener('click', closeSettings);

  // Move modal
  $('#move-close-btn').addEventListener('click', closeMoveModal);
  $('#move-modal .modal-backdrop').addEventListener('click', closeMoveModal);

  // Command palette
  $('#command-palette .modal-backdrop').addEventListener('click', closePalette);
}

// ── Keyboard shortcuts ─────────────────────────────────
function bindKeyboard() {
  document.addEventListener('keydown', (e) => {
    const activeTag = document.activeElement?.tagName;
    const inInput = activeTag === 'INPUT' || activeTag === 'TEXTAREA';

    // Cmd/Ctrl+K → command palette
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      openPalette();
      return;
    }

    // Escape → close modals, clear search
    if (e.key === 'Escape') {
      if (!$('#command-palette').classList.contains('hidden')) {
        closePalette();
        return;
      }
      if (!$('#settings-overlay').classList.contains('hidden')) {
        closeSettings();
        return;
      }
      if (!$('#move-modal').classList.contains('hidden')) {
        closeMoveModal();
        return;
      }
      if (state.searchQuery) {
        state.searchQuery = '';
        $('#search').value = '';
        $('#search').blur();
        render();
        return;
      }
      if (inInput) {
        document.activeElement.blur();
        return;
      }
    }

    // / → focus search (when not in an input)
    if (e.key === '/' && !inInput) {
      e.preventDefault();
      $('#search').focus();
    }
  });
}

// ── Save all tabs ──────────────────────────────────────
async function saveAllTabs() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const saveable = tabs.filter(
    (t) => t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://')
  );
  if (saveable.length === 0) return;

  const name = formatCollectionName();
  await TabStashStorage.addCollection(name, saveable);
  await loadData();
  render();
  showToast(`Saved ${saveable.length} tab${saveable.length !== 1 ? 's' : ''}`);

  // Handle close-after-save
  if (state.settings.closeAfterSave === 'always') {
    closeSavedTabs(saveable);
  } else if (state.settings.closeAfterSave === 'ask') {
    if (confirm(`Close ${saveable.length} saved tabs?`)) {
      closeSavedTabs(saveable);
    }
  }
}

function closeSavedTabs(tabs) {
  const tabIds = tabs.map((t) => t.id).filter(Boolean);
  if (tabIds.length > 0) {
    chrome.tabs.remove(tabIds);
  }
}

// ── Render ─────────────────────────────────────────────
function render() {
  updateSidebar();
  updateViewHeader();

  const content = $('#content');
  const empty = $('#empty-state');

  // Search mode
  if (state.searchQuery.trim()) {
    const results = TabStashStorage.search(state.collections, state.searchQuery);
    if (results.length === 0) {
      content.innerHTML = '';
      empty.querySelector('.empty-title').textContent = 'No results';
      empty.querySelector('.empty-sub').innerHTML = `Nothing matching "<b>${escHtml(state.searchQuery)}</b>"`;
      empty.classList.remove('hidden');
    } else {
      empty.classList.add('hidden');
      content.innerHTML = '';
      renderSearchResults(content, results);
    }
    return;
  }

  // View routing
  empty.querySelector('.empty-title').textContent = 'Save your first tabs';
  empty.querySelector('.empty-sub').innerHTML = 'Click "Save all tabs" to stash everything open in this window,<br>or use the TabStash popup from the toolbar.';

  if (state.currentView === 'all') {
    renderAllView(content, empty);
  } else if (state.currentView === 'duplicates') {
    renderDuplicatesView(content, empty);
  } else if (state.currentView === 'archived') {
    renderArchivedView(content, empty);
  } else {
    renderCollectionView(content, empty, state.currentView);
  }
}

function renderAllView(content, empty) {
  if (state.collections.length === 0) {
    content.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  content.innerHTML = '';
  for (const col of state.collections) {
    content.appendChild(buildCollectionBlock(col, false));
  }
}

function renderDuplicatesView(content, empty) {
  // Find all URLs with count > 1
  const dupUrls = Object.entries(state.urlIndex).filter(([, c]) => c > 1);
  if (dupUrls.length === 0) {
    content.innerHTML = '';
    empty.querySelector('.empty-title').textContent = 'No duplicates';
    empty.querySelector('.empty-sub').innerHTML = 'All your saved tabs are unique.';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  content.innerHTML = '';

  // Collect all tab instances for dup URLs
  const dupSet = new Set(dupUrls.map(([url]) => url));
  for (const col of state.collections) {
    const dupTabs = col.tabs.filter((t) => !t.archived && dupSet.has(t.url));
    if (dupTabs.length === 0) continue;

    const fakeCol = { ...col, tabs: dupTabs };
    content.appendChild(buildCollectionBlock(fakeCol, true));
  }
}

function renderArchivedView(content, empty) {
  const archivedCols = [];
  for (const col of state.collections) {
    const archived = col.tabs.filter((t) => t.archived);
    if (archived.length > 0) {
      archivedCols.push({ ...col, tabs: archived });
    }
  }
  if (archivedCols.length === 0) {
    content.innerHTML = '';
    empty.querySelector('.empty-title').textContent = 'No archived tabs';
    empty.querySelector('.empty-sub').innerHTML = 'Tabs older than your archive threshold will appear here.';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  content.innerHTML = '';
  for (const col of archivedCols) {
    content.appendChild(buildCollectionBlock(col, true));
  }
}

function renderCollectionView(content, empty, colId) {
  const col = state.collections.find((c) => c.id === colId);
  if (!col || col.tabs.length === 0) {
    content.innerHTML = '';
    empty.querySelector('.empty-title').textContent = col ? 'Empty collection' : 'Collection not found';
    empty.querySelector('.empty-sub').innerHTML = col
      ? 'Save tabs to this collection from the popup or by moving tabs here.'
      : '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  content.innerHTML = '';
  content.appendChild(buildCollectionBlock(col, false));
}

function renderSearchResults(content, results) {
  // Group results by collection
  const groups = {};
  for (const r of results) {
    if (!groups[r.collectionId]) {
      groups[r.collectionId] = {
        name: r.collectionName,
        id: r.collectionId,
        tabs: [],
      };
    }
    groups[r.collectionId].tabs.push(r);
  }

  for (const group of Object.values(groups)) {
    const block = buildCollectionBlock(group, true);
    content.appendChild(block);
  }
}

// ── Build a collection block ───────────────────────────
function buildCollectionBlock(col, readOnly) {
  const div = document.createElement('div');
  div.className = 'collection-block';
  div.dataset.id = col.id;

  const activeTabs = col.tabs.filter((t) => !t.archived);
  const archivedTabs = col.tabs.filter((t) => t.archived);
  const totalActive = activeTabs.length;
  const totalArchived = archivedTabs.length;

  // Header
  const header = document.createElement('div');
  header.className = 'collection-header';

  const arrowSvg = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M4 5.5L7 8.5L10 5.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  header.innerHTML = `
    <span class="collapse-icon">${arrowSvg}</span>
    <span class="collection-name">${escHtml(col.name)}</span>
    <span class="collection-count">${totalActive} tab${totalActive !== 1 ? 's' : ''}${totalArchived ? ` · ${totalArchived} archived` : ''}</span>
    ${readOnly ? '' : `
    <div class="col-header-actions">
      <button class="icon-btn restore-all-btn" title="Restore all tabs">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 7H10M10 7L6.5 3.5M10 7L6.5 10.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <button class="icon-btn rename-col-btn" title="Rename">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M10 2L12 4L5 11H3V9L10 2Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>
      </button>
      <button class="icon-btn export-md-btn" title="Export as Markdown">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 10V12H11V10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M7 2V9M7 9L4.5 6.5M7 9L9.5 6.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <button class="icon-btn danger delete-col-btn" title="Delete collection">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3.5 4.5H10.5L10 12H4L3.5 4.5Z" stroke="currentColor" stroke-width="1.1"/><path d="M2.5 4.5H11.5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/><path d="M5.5 4.5V3C5.5 2.7 5.7 2.5 6 2.5H8C8.3 2.5 8.5 2.7 8.5 3V4.5" stroke="currentColor" stroke-width="1.1"/></svg>
      </button>
    </div>`}
  `;

  // Collapse toggle
  header.addEventListener('click', (e) => {
    if (e.target.closest('.col-header-actions')) return;
    div.classList.toggle('collapsed');
  });

  if (!readOnly) {
    // Restore all
    header.querySelector('.restore-all-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      for (const tab of activeTabs) {
        chrome.tabs.create({ url: tab.url, active: false });
      }
      showToast(`Opened ${activeTabs.length} tab${activeTabs.length !== 1 ? 's' : ''}`);
    });

    // Rename
    header.querySelector('.rename-col-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      startInlineRename(div, col);
    });

    // Export as markdown
    header.querySelector('.export-md-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const realCol = state.collections.find((c) => c.id === col.id);
      if (!realCol) return;
      const md = TabStashStorage.exportCollectionAsMarkdown(realCol);
      downloadText(`${col.name}.md`, md, 'text/markdown');
      showToast('Exported as Markdown');
    });

    // Delete collection
    header.querySelector('.delete-col-btn')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm(`Delete "${col.name}" and all its tabs?`)) {
        await TabStashStorage.removeCollection(col.id);
        if (state.currentView === col.id) state.currentView = 'all';
        await loadData();
        render();
        showToast('Collection deleted');
      }
    });
  }

  div.appendChild(header);

  // Body
  const body = document.createElement('div');
  body.className = 'collection-body';

  const allTabs = [...activeTabs, ...archivedTabs];
  for (const tab of allTabs) {
    body.appendChild(buildTabRow(tab, col.id));
  }

  div.appendChild(body);
  return div;
}

// ── Build a tab row ────────────────────────────────────
function buildTabRow(tab, collectionId) {
  const row = document.createElement('div');
  row.className = `tab-row${tab.archived ? ' archived' : ''}`;

  const count = state.urlIndex[tab.url] || 0;
  const showDups = state.settings.showDuplicateWarnings !== false;
  const dupBadge = showDups && count > 1
    ? `<span class="dup-badge">Saved ${count}×</span>` : '';

  // Archive-approaching badge
  let archiveBadge = '';
  if (!tab.archived && state.settings.archiveEnabled) {
    const daysLeft = TabStashStorage.daysUntilArchive(tab, state.settings);
    if (daysLeft !== null && daysLeft <= 7) {
      archiveBadge = `<span class="archive-badge">Archives in ${daysLeft}d</span>`;
    }
  }

  const iconSrc = faviconUrl(tab.url);
  const faviconHtml = iconSrc
    ? `<img class="tab-favicon" src="${escAttr(iconSrc)}" alt="" loading="lazy">`
    : '<div class="tab-favicon-placeholder"></div>';

  row.innerHTML = `
    ${faviconHtml}
    <div class="tab-info">
      <div class="tab-title" title="${escAttr(tab.url)}">${escHtml(tab.title)}</div>
      <div class="tab-url">${escHtml(shortUrl(tab.url))}</div>
    </div>
    <div class="tab-meta">
      ${archiveBadge}
      ${dupBadge}
      <span class="tab-date">${relativeDate(tab.savedAt)}</span>
    </div>
    <div class="tab-actions">
      <button class="icon-btn restore-btn" title="Open tab">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 7H11M11 7L7.5 3.5M11 7L7.5 10.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <button class="icon-btn move-btn" title="Move to collection">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1.5" y="3" width="11" height="8.5" rx="1.5" stroke="currentColor" stroke-width="1.1" fill="none"/><path d="M1.5 5.5H12.5" stroke="currentColor" stroke-width="1.1"/></svg>
      </button>
      ${count > 1 ? `
      <button class="icon-btn merge-btn" title="Merge duplicates of this URL">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M4 4L7 7L4 10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 4L7 7L10 10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>` : ''}
      <button class="icon-btn danger delete-btn" title="Delete tab">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3.5 3.5L10.5 10.5M10.5 3.5L3.5 10.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
      </button>
    </div>
  `;

  // Restore
  row.querySelector('.tab-title').addEventListener('click', () => {
    chrome.tabs.create({ url: tab.url });
  });
  row.querySelector('.restore-btn').addEventListener('click', () => {
    chrome.tabs.create({ url: tab.url });
  });

  // Delete
  row.querySelector('.delete-btn').addEventListener('click', async () => {
    await TabStashStorage.removeTab(tab.id);
    await loadData();
    render();
  });

  // Move
  row.querySelector('.move-btn').addEventListener('click', () => {
    openMoveModal(tab.id, collectionId);
  });

  // Merge this URL's duplicates
  row.querySelector('.merge-btn')?.addEventListener('click', async () => {
    const removed = await TabStashStorage.mergeDuplicates(tab.url, collectionId);
    if (removed > 0) {
      showToast(`Merged ${removed} duplicate${removed !== 1 ? 's' : ''}`);
      await loadData();
      render();
    }
  });

  return row;
}

// ── Sidebar ────────────────────────────────────────────
function updateSidebar() {
  // Counts
  let allCount = 0;
  let archivedCount = 0;
  for (const col of state.collections) {
    for (const t of col.tabs) {
      if (t.archived) archivedCount++;
      else allCount++;
    }
  }
  const dupCount = Object.values(state.urlIndex).filter((c) => c > 1).length;

  $('#nav-all-count').textContent = allCount;
  $('#nav-dup-count').textContent = dupCount;
  $('#nav-archived-count').textContent = archivedCount;

  // Active nav item
  $$('.nav-item[data-view]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === state.currentView);
  });

  // Collections list
  const list = $('#sidebar-collections');
  list.innerHTML = '';

  for (const col of state.collections) {
    const active = col.tabs.filter((t) => !t.archived).length;
    const btn = document.createElement('button');
    btn.className = `sidebar-col-item${state.currentView === col.id ? ' active' : ''}`;
    btn.innerHTML = `
      <span class="sidebar-col-name">${escHtml(col.name)}</span>
      <span class="sidebar-col-count">${active}</span>
      <div class="sidebar-col-actions">
        <button class="icon-btn danger sidebar-delete-btn" title="Delete">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 3L9 9M9 3L3 9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
        </button>
      </div>
    `;

    btn.addEventListener('click', (e) => {
      if (e.target.closest('.sidebar-col-actions')) return;
      state.currentView = col.id;
      state.searchQuery = '';
      $('#search').value = '';
      render();
    });

    btn.querySelector('.sidebar-delete-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm(`Delete "${col.name}"?`)) {
        await TabStashStorage.removeCollection(col.id);
        if (state.currentView === col.id) state.currentView = 'all';
        await loadData();
        render();
      }
    });

    list.appendChild(btn);
  }
}

function updateViewHeader() {
  const title = $('#view-title');
  const count = $('#view-count');

  if (state.searchQuery.trim()) {
    const results = TabStashStorage.search(state.collections, state.searchQuery);
    title.textContent = 'Search';
    count.textContent = `${results.length} result${results.length !== 1 ? 's' : ''}`;
    return;
  }

  if (state.currentView === 'all') {
    const total = state.collections.reduce((s, c) => s + c.tabs.filter((t) => !t.archived).length, 0);
    title.textContent = 'All Tabs';
    count.textContent = `${total} tab${total !== 1 ? 's' : ''}`;
  } else if (state.currentView === 'duplicates') {
    const dupCount = Object.values(state.urlIndex).filter((c) => c > 1).length;
    title.textContent = 'Duplicates';
    count.textContent = `${dupCount} URL${dupCount !== 1 ? 's' : ''} saved multiple times`;
  } else if (state.currentView === 'archived') {
    const archCount = state.collections.reduce((s, c) => s + c.tabs.filter((t) => t.archived).length, 0);
    title.textContent = 'Archived';
    count.textContent = `${archCount} tab${archCount !== 1 ? 's' : ''}`;
  } else {
    const col = state.collections.find((c) => c.id === state.currentView);
    if (col) {
      const active = col.tabs.filter((t) => !t.archived).length;
      title.textContent = col.name;
      count.textContent = `${active} tab${active !== 1 ? 's' : ''}`;
    } else {
      title.textContent = 'Not found';
      count.textContent = '';
    }
  }
}

// ── Inline rename ──────────────────────────────────────
function startInlineRename(blockEl, col) {
  const nameEl = blockEl.querySelector('.collection-name');
  const current = nameEl.textContent;

  const input = document.createElement('input');
  input.className = 'inline-rename';
  input.value = current;

  nameEl.replaceWith(input);
  input.focus();
  input.select();

  const finish = async () => {
    const newName = input.value.trim();
    if (newName && newName !== current) {
      await TabStashStorage.renameCollection(col.id, newName);
      await loadData();
    }
    render();
  };

  input.addEventListener('blur', finish);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') {
      input.value = current;
      input.blur();
    }
  });
}

// ── Move modal ─────────────────────────────────────────
function openMoveModal(tabId, sourceColId) {
  state.moveTabId = tabId;
  state.moveSourceColId = sourceColId;
  const list = $('#move-list');
  list.innerHTML = '';

  for (const col of state.collections) {
    if (col.id === sourceColId) continue;
    const item = document.createElement('div');
    item.className = 'move-item';
    item.textContent = col.name;
    item.addEventListener('click', async () => {
      await TabStashStorage.moveTab(tabId, col.id);
      closeMoveModal();
      await loadData();
      render();
      showToast(`Moved to ${col.name}`);
    });
    list.appendChild(item);
  }

  if (list.children.length === 0) {
    list.innerHTML = '<div style="padding:12px;color:var(--text-tertiary);font-size:13px;text-align:center">No other collections. Create one first.</div>';
  }

  $('#move-modal').classList.remove('hidden');
}

function closeMoveModal() {
  $('#move-modal').classList.add('hidden');
  state.moveTabId = null;
}

// ── Settings overlay ───────────────────────────────────
function openSettings() {
  const s = state.settings;

  // Archive days dropdown
  const archiveSelect = $('#setting-archive-days');
  if (!s.archiveEnabled) {
    archiveSelect.value = '0';
  } else {
    // Snap to closest preset
    const presets = [7, 30, 90];
    const closest = presets.reduce((a, b) =>
      Math.abs(b - s.archiveDays) < Math.abs(a - s.archiveDays) ? b : a
    );
    archiveSelect.value = String(closest);
  }

  // Close after save
  $('#setting-close-after').value = s.closeAfterSave || 'ask';

  // Show dupes
  $('#setting-show-dupes').checked = s.showDuplicateWarnings !== false;

  // Bind change handlers (remove old ones by cloning)
  const newArchive = archiveSelect.cloneNode(true);
  archiveSelect.replaceWith(newArchive);
  newArchive.addEventListener('change', async () => {
    const val = parseInt(newArchive.value, 10);
    await TabStashStorage.saveSettings({
      ...state.settings,
      archiveEnabled: val > 0,
      archiveDays: val > 0 ? val : state.settings.archiveDays,
    });
    state.settings = await TabStashStorage.getSettings();
    showToast('Settings saved');
  });

  const closeSelect = $('#setting-close-after');
  const newClose = closeSelect.cloneNode(true);
  closeSelect.replaceWith(newClose);
  newClose.addEventListener('change', async () => {
    await TabStashStorage.saveSettings({
      ...state.settings,
      closeAfterSave: newClose.value,
    });
    state.settings = await TabStashStorage.getSettings();
    showToast('Settings saved');
  });

  const dupCheck = $('#setting-show-dupes');
  const newDup = dupCheck.cloneNode(true);
  dupCheck.replaceWith(newDup);
  newDup.addEventListener('change', async () => {
    await TabStashStorage.saveSettings({
      ...state.settings,
      showDuplicateWarnings: newDup.checked,
    });
    state.settings = await TabStashStorage.getSettings();
    render();
    showToast('Settings saved');
  });

  // Export button
  const exportBtn = $('#setting-export-btn');
  const newExport = exportBtn.cloneNode(true);
  exportBtn.replaceWith(newExport);
  newExport.addEventListener('click', async () => {
    const data = await TabStashStorage.getAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tabstash-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Exported');
  });

  $('#settings-overlay').classList.remove('hidden');
}

function closeSettings() {
  $('#settings-overlay').classList.add('hidden');
}

// ── Command palette (Cmd+K) ───────────────────────────
const PALETTE_COMMANDS = [
  { label: 'Save all tabs', hint: 'Save current window', action: () => saveAllTabs() },
  { label: 'Merge all duplicates', hint: 'Consolidate duplicate URLs', action: async () => {
    const n = await TabStashStorage.mergeAllDuplicates();
    await loadData(); render();
    showToast(n > 0 ? `Merged ${n} duplicate${n !== 1 ? 's' : ''}` : 'No duplicates');
  }},
  { label: 'View all tabs', hint: '', action: () => { state.currentView = 'all'; render(); }},
  { label: 'View duplicates', hint: '', action: () => { state.currentView = 'duplicates'; render(); }},
  { label: 'View archived', hint: '', action: () => { state.currentView = 'archived'; render(); }},
  { label: 'Open settings', hint: '', action: () => openSettings() },
  { label: 'Export all data', hint: 'Download JSON backup', action: async () => {
    const data = await TabStashStorage.getAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url;
    a.download = `tabstash-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click(); URL.revokeObjectURL(url);
    showToast('Exported');
  }},
  { label: 'New collection', hint: 'Create empty collection', action: async () => {
    const name = prompt('Collection name:');
    if (name?.trim()) {
      const col = await TabStashStorage.addCollection(name.trim(), []);
      await loadData(); state.currentView = col.id; render();
    }
  }},
];

let paletteSelected = 0;

function openPalette() {
  $('#command-palette').classList.remove('hidden');
  const input = $('#palette-input');
  input.value = '';
  input.focus();
  paletteSelected = 0;
  renderPaletteResults('');

  // Fresh event listeners
  input.oninput = () => {
    paletteSelected = 0;
    renderPaletteResults(input.value);
  };
  input.onkeydown = (e) => {
    const items = $$('.palette-item');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      paletteSelected = Math.min(paletteSelected + 1, items.length - 1);
      updatePaletteSelection();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      paletteSelected = Math.max(paletteSelected - 1, 0);
      updatePaletteSelection();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const sel = items[paletteSelected];
      if (sel) sel.click();
    }
  };
}

function closePalette() {
  $('#command-palette').classList.add('hidden');
}

function renderPaletteResults(query) {
  const q = query.toLowerCase().trim();
  const container = $('#palette-results');
  container.innerHTML = '';

  // Add dynamic collection navigation
  const allCommands = [
    ...PALETTE_COMMANDS,
    ...state.collections.map((col) => ({
      label: `Go to: ${col.name}`,
      hint: `${col.tabs.filter((t) => !t.archived).length} tabs`,
      action: () => { state.currentView = col.id; render(); },
    })),
  ];

  const filtered = q
    ? allCommands.filter((c) => c.label.toLowerCase().includes(q))
    : allCommands;

  for (let i = 0; i < filtered.length; i++) {
    const cmd = filtered[i];
    const div = document.createElement('div');
    div.className = `palette-item${i === paletteSelected ? ' selected' : ''}`;
    div.innerHTML = `
      <span class="palette-item-label">${escHtml(cmd.label)}</span>
      ${cmd.hint ? `<span class="palette-item-hint">${escHtml(cmd.hint)}</span>` : ''}
    `;
    div.addEventListener('click', () => {
      closePalette();
      cmd.action();
    });
    container.appendChild(div);
  }
}

function updatePaletteSelection() {
  $$('.palette-item').forEach((el, i) => {
    el.classList.toggle('selected', i === paletteSelected);
  });
}

// ── Toast ──────────────────────────────────────────────
function showToast(msg) {
  const toast = $('#toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  toast.offsetHeight; // force reflow
  toast.classList.add('visible');

  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.classList.add('hidden'), 200);
  }, 2000);
}

// ── Utility helpers ────────────────────────────────────
function formatCollectionName() {
  const d = new Date();
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} · ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function relativeDate(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname !== '/' ? u.pathname : '';
    const display = u.hostname + path;
    return display.length > 60 ? display.slice(0, 57) + '…' : display;
  } catch {
    return url;
  }
}

function escHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escAttr(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
