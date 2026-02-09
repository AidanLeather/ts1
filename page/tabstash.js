/**
 * TabStash – Full-page management UI
 *
 * Architecture:
 *   - State from chrome.storage.local via lib/storage.js
 *   - Real-time updates via chrome.storage.onChanged listener
 *   - Views: "all" or a specific collection id
 *   - Keyboard: / = search, Esc = clear/close, Cmd+K = command palette
 *   - Favicons via Google's service for reliability
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// ── State ──────────────────────────────────────────────
let state = {
  collections: [],
  urlIndex: {},
  settings: {},
  currentView: 'all',
  searchQuery: '',
  recentSearches: [],
  searchFilters: {
    pinnedOnly: false,
    last7Days: false,
    domain: '',
  },
};

const RECENT_SEARCHES_KEY = 'recentSearches';

function getAccordionState() {
  return state.settings.accordionState || {};
}

async function setAccordionState(nextState) {
  try {
    await TabStashStorage.saveSettings({ ...state.settings, accordionState: nextState });
    state.settings = await TabStashStorage.getSettings();
  } catch (err) {
    console.error('[TabStash] save accordion state error:', err);
  }
}

// ── Init ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadData();
  await loadRecentSearches();
  render();
  bindEvents();
  bindKeyboard();
  bindStorageListener();
  console.log('[TabStash] Page loaded, listening for storage changes');
});

async function loadData() {
  try {
    const data = await TabStashStorage.getAll();
    state.collections = TabStashStorage.sortCollections(data.collections);
    state.urlIndex = data.urlIndex;
    state.settings = data.settings;
    console.log(`[TabStash] Loaded ${state.collections.length} collections`);
  } catch (err) {
    console.error('[TabStash] loadData error:', err);
  }
}

// ── Real-time storage listener ─────────────────────────
function bindStorageListener() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.collections || changes.urlIndex || changes.settings) {
      console.log('[TabStash] Storage changed, refreshing...');
      loadData().then(() => render());
    }
  });
}

// ── Favicon ────────────────────────────────────────────
function faviconUrl(url) {
  try {
    const domain = new URL(url).hostname;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`;
  } catch {
    return '';
  }
}

// ── Events ─────────────────────────────────────────────
function bindEvents() {
  // Sidebar: "All Tabs"
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
  $('#search').addEventListener('focus', () => {
    openSearchPanel();
  });
  $('#search').addEventListener('blur', () => {
    setTimeout(() => {
      if (!document.activeElement || !document.activeElement.closest('.search-bar')) {
        closeSearchPanel();
      }
    }, 120);
    if (state.searchQuery.trim()) {
      saveRecentSearch(state.searchQuery);
    }
  });
  $('#search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (state.searchQuery.trim()) {
        saveRecentSearch(state.searchQuery);
      }
      $('#search').blur();
    }
  });

  $('#search-panel').addEventListener('mousedown', (e) => {
    e.preventDefault();
  });

  $$('.search-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const filter = chip.dataset.filter;
      if (filter === 'pinned') {
        state.searchFilters.pinnedOnly = !state.searchFilters.pinnedOnly;
      } else if (filter === 'last7') {
        state.searchFilters.last7Days = !state.searchFilters.last7Days;
      } else if (filter === 'domain') {
        if (state.searchFilters.domain) {
          state.searchFilters.domain = '';
        } else {
          const domain = prompt('Filter by domain (e.g. example.com):');
          if (domain && domain.trim()) {
            state.searchFilters.domain = domain.trim();
          }
        }
      }
      updateSearchPanel();
      if (state.searchQuery.trim()) {
        render();
      }
    });
  });

  $('#clear-search-history')?.addEventListener('click', async () => {
    await clearRecentSearches();
  });

  // Save open tabs (sidebar link)
  $('#save-tabs-btn').addEventListener('click', saveAllTabs);

  // Empty state CTA
  $('#empty-cta-btn')?.addEventListener('click', saveAllTabs);

  // New collection
  $('#new-collection-btn').addEventListener('click', async () => {
    const name = prompt('Collection name:');
    if (name && name.trim()) {
      try {
        const col = await TabStashStorage.addCollection(name.trim(), []);
        await loadData();
        state.currentView = col.id;
        render();
      } catch (err) {
        console.error('[TabStash] New collection error:', err);
      }
    }
  });

  // Settings
  $('#settings-btn').addEventListener('click', openSettings);
  $('#settings-close-btn').addEventListener('click', closeSettings);
  $('#settings-overlay .modal-backdrop').addEventListener('click', closeSettings);

  // Move modal
  $('#move-close-btn').addEventListener('click', closeMoveModal);
  $('#move-modal .modal-backdrop').addEventListener('click', closeMoveModal);

  // Command palette
  $('#command-palette .modal-backdrop').addEventListener('click', closePalette);

  // Filter clear
  $('#filter-clear').addEventListener('click', () => {
    state.searchQuery = '';
    $('#search').value = '';
    render();
  });

  // Accordion controls
  $('#collapse-all-btn').addEventListener('click', async () => {
    await setAllAccordionState(true);
    render();
  });
  $('#expand-all-btn').addEventListener('click', async () => {
    await setAllAccordionState(false);
    render();
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-bar')) {
      closeSearchPanel();
    }
  });
}

// ── Keyboard ───────────────────────────────────────────
function bindKeyboard() {
  document.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName;
    const inInput = tag === 'INPUT' || tag === 'TEXTAREA';

    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      openPalette();
      return;
    }

    if (e.key === 'Escape') {
      if (!$('#command-palette').classList.contains('hidden')) { closePalette(); return; }
      if (!$('#settings-overlay').classList.contains('hidden')) { closeSettings(); return; }
      if (!$('#move-modal').classList.contains('hidden')) { closeMoveModal(); return; }
      if (state.searchQuery) {
        state.searchQuery = '';
        $('#search').value = '';
        $('#search').blur();
        render();
        return;
      }
      if (inInput) { document.activeElement.blur(); return; }
    }

    if (e.key === '/' && !inInput) {
      e.preventDefault();
      $('#search').focus();
    }
  });
}

// ── Save all tabs ──────────────────────────────────────
async function saveAllTabs() {
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const saveable = tabs.filter(
      (t) => t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://')
    );
    if (saveable.length === 0) {
      showToast('No saveable tabs');
      return;
    }

    const createdAt = Date.now();
    const name = formatCollectionName(new Date(createdAt));
    const col = await TabStashStorage.addCollection(name, saveable, {
      createdAt,
      autoTitleType: 'timeOfDay',
    });
    console.log(`[TabStash] Saved ${saveable.length} tabs as "${name}"`);
    await loadData();
    render();
    showToast(`Saved ${saveable.length} tab${saveable.length !== 1 ? 's' : ''}`);
  } catch (err) {
    console.error('[TabStash] saveAllTabs error:', err);
    showToast('Error saving tabs');
  }
}

// ── Render ─────────────────────────────────────────────
function render() {
  updateSidebar();
  updateViewHeader();

  const content = $('#content');
  const empty = $('#empty-state');
  const filterBar = $('#filter-bar');

  // Search mode
  if (state.searchQuery.trim()) {
    const results = TabStashStorage.search(state.collections, state.searchQuery, state.searchFilters);
    const count = results.length;
    $('#filter-text').textContent = `${count} result${count !== 1 ? 's' : ''} for "${state.searchQuery}"`;
    filterBar.classList.remove('hidden');

    if (count === 0) {
      content.innerHTML = '';
      setEmptyState({
        title: 'No results',
        sub: `Nothing matching "${state.searchQuery}"`,
      });
      empty.classList.remove('hidden');
    } else {
      empty.classList.add('hidden');
      content.innerHTML = '';
      renderSearchResults(content, results);
    }
    return;
  }

  filterBar.classList.add('hidden');
  setEmptyState({
    title: 'Save your first session',
    description: 'TabStash turns your open tabs into saved sessions you can revisit anytime.',
    sub: 'Use the button below or click "Save open tabs" in the sidebar.',
    showDescription: true,
    showCta: true,
  });

  if (state.currentView === 'all') {
    renderAllView(content, empty);
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
  const pinned = state.collections.filter((c) => c.isPinned);
  const unpinned = state.collections.filter((c) => !c.isPinned);

  if (pinned.length > 0) {
    content.appendChild(buildCollectionSectionLabel('Pinned'));
    for (const col of pinned) {
      content.appendChild(buildCollectionBlock(col, false, true));
    }
  }

  if (unpinned.length > 0) {
    if (pinned.length > 0) {
      content.appendChild(buildCollectionSectionLabel('Collections'));
    }
    for (const col of unpinned) {
      content.appendChild(buildCollectionBlock(col, false, true));
    }
  }
}

function renderCollectionView(content, empty, colId) {
  const col = state.collections.find((c) => c.id === colId);
  if (!col) {
    content.innerHTML = '';
    setEmptyState({ title: 'Collection not found', sub: '' });
    empty.classList.remove('hidden');
    return;
  }

  if (col.tabs.length === 0) {
    content.innerHTML = '';
    // Still show the add-tab form even when empty
    const wrapper = document.createElement('div');
    wrapper.appendChild(buildAddTabForm(col.id));
    content.appendChild(wrapper);
    setEmptyState({ title: 'Empty collection', sub: 'Add tabs manually or move tabs here.' });
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  content.innerHTML = '';
  // Single collection view: no accordion, flat list
  content.appendChild(buildCollectionBlock(col, false, false));
}

function renderSearchResults(content, results) {
  const groups = {};
  for (const r of results) {
    if (!groups[r.collectionId]) {
      groups[r.collectionId] = { name: r.collectionName, id: r.collectionId, tabs: [] };
    }
    groups[r.collectionId].tabs.push(r);
  }
  for (const group of Object.values(groups)) {
    content.appendChild(buildCollectionBlock(group, true, true));
  }
}

function setEmptyState({ title, sub, description = '', showDescription = false, showCta = false }) {
  $('#empty-title').textContent = title;
  $('#empty-sub').textContent = sub;

  const descEl = $('#empty-desc');
  if (descEl) {
    descEl.textContent = description;
    descEl.classList.toggle('hidden', !showDescription);
  }

  const ctaBtn = $('#empty-cta-btn');
  if (ctaBtn) {
    ctaBtn.classList.toggle('hidden', !showCta);
  }
}

function buildCollectionSectionLabel(text) {
  const div = document.createElement('div');
  div.className = 'collection-section';
  div.textContent = text;
  return div;
}

async function setAllAccordionState(collapsed) {
  const next = { ...getAccordionState() };
  for (const col of state.collections) {
    next[col.id] = collapsed;
  }
  await setAccordionState(next);
}

// ── Collection block ───────────────────────────────────
function buildCollectionBlock(col, readOnly, collapsible) {
  const div = document.createElement('div');
  div.className = 'collection-block';
  div.dataset.id = col.id;

  const activeTabs = col.tabs.filter((t) => !t.archived);
  const archivedTabs = col.tabs.filter((t) => t.archived);
  const totalActive = activeTabs.length;

  const countText = totalActive === 1 ? '1 tab' : `${totalActive} tabs`;

  if (collapsible) {
    // Collapsible header for "all" view
    const arrow = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3.5 4.5L6 7L8.5 4.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const preciseTimestamp = col.createdAt ? formatPreciseTimestamp(col.createdAt) : '';
    const timestampHtml = preciseTimestamp
      ? `<span class="collection-meta" title="${escAttr(preciseTimestamp)}">${escHtml(preciseTimestamp)}</span>`
      : '';

    const header = document.createElement('div');
    header.className = 'collection-header';
    header.innerHTML = `
      <span class="collapse-icon">${arrow}</span>
      <span class="collection-name">${escHtml(col.name)}</span>
      <span class="collection-tab-count"></span>
      <span class="collection-spacer"></span>
      ${readOnly ? '' : `
      <div class="col-actions">
        <button class="icon-btn restore-all-btn" title="Restore all">
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M2 6.5H10.5M10.5 6.5L7 3M10.5 6.5L7 10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button class="icon-btn rename-btn" title="Rename">
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M9.5 2L11 3.5L4.5 10H3V8.5L9.5 2Z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/></svg>
        </button>
        <button class="icon-btn export-btn" title="Export as Markdown">
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M3 9V11H10V9" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/><path d="M6.5 2V8M6.5 8L4 5.5M6.5 8L9 5.5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button class="icon-btn danger delete-btn" title="Delete">
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M3 3.5L10 10.5M10 3.5L3 10.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
        </button>
      </div>`}
      ${timestampHtml}
    `;
    const countBadge = buildCountBadge(countText, col.isPinned ? 'pinned' : null);
    if (countBadge) {
      header.querySelector('.collection-tab-count')?.appendChild(countBadge);
    }

    const accordionState = getAccordionState();
    if (accordionState[col.id]) {
      div.classList.add('collapsed');
    }

    header.addEventListener('click', async (e) => {
      if (e.target.closest('.col-actions')) return;
      div.classList.toggle('collapsed');
      await setAccordionState({
        ...getAccordionState(),
        [col.id]: div.classList.contains('collapsed'),
      });
    });

    bindCollectionActions(header, col, activeTabs, div);
    div.appendChild(header);
  }

  // Tab list body
  const body = document.createElement('div');
  body.className = 'collection-body';
  for (const tab of [...activeTabs, ...archivedTabs]) {
    body.appendChild(buildTabRow(tab, col.id));
  }

  // Add manual tab form (only in single-collection detail view)
  if (!collapsible && !readOnly) {
    body.appendChild(buildAddTabForm(col.id));
  }

  div.appendChild(body);
  return div;
}

function bindCollectionActions(header, col, activeTabs, blockEl) {
  header.querySelector('.restore-all-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    for (const t of activeTabs) {
      chrome.tabs.create({ url: t.url, active: false }).catch((err) => {
        console.warn('[TabStash] Error opening tab:', err);
      });
    }
    TabStashStorage.logAction('open', { collectionId: col.id, tabCount: activeTabs.length });
    showToast(`Opened ${activeTabs.length} tab${activeTabs.length !== 1 ? 's' : ''}`);
  });

  header.querySelector('.rename-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    startInlineRename(blockEl, col);
  });

  header.querySelector('.export-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const real = state.collections.find((c) => c.id === col.id);
    if (!real) return;
    downloadText(`${col.name}.md`, TabStashStorage.exportCollectionAsMarkdown(real), 'text/markdown');
    showToast('Exported');
  });

  header.querySelector('.delete-btn')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (confirm(`Delete "${col.name}"? This can't be undone.`)) {
      try {
        await TabStashStorage.removeCollection(col.id);
        if (state.currentView === col.id) state.currentView = 'all';
        await loadData();
        render();
      } catch (err) {
        console.error('[TabStash] Delete collection error:', err);
      }
    }
  });
}

// ── Add tab form ───────────────────────────────────────
function buildAddTabForm(collectionId) {
  const form = document.createElement('div');
  form.className = 'add-tab-form';

  const toggle = document.createElement('button');
  toggle.className = 'add-tab-toggle';
  toggle.innerHTML = `
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 2V10M2 6H10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
    Add tab manually
  `;

  const fields = document.createElement('div');
  fields.className = 'add-tab-fields hidden';
  fields.innerHTML = `
    <input type="text" class="add-tab-input" placeholder="Tab title" data-field="title">
    <input type="url" class="add-tab-input" placeholder="URL (https://...)" data-field="url">
    <div class="add-tab-actions">
      <button class="add-tab-submit">Add</button>
      <button class="add-tab-cancel">Cancel</button>
    </div>
  `;

  toggle.addEventListener('click', () => {
    toggle.classList.add('hidden');
    fields.classList.remove('hidden');
    fields.querySelector('[data-field="title"]').focus();
  });

  fields.querySelector('.add-tab-cancel').addEventListener('click', () => {
    fields.classList.add('hidden');
    toggle.classList.remove('hidden');
    fields.querySelector('[data-field="title"]').value = '';
    fields.querySelector('[data-field="url"]').value = '';
  });

  fields.querySelector('.add-tab-submit').addEventListener('click', async () => {
    const title = fields.querySelector('[data-field="title"]').value.trim();
    const url = fields.querySelector('[data-field="url"]').value.trim();
    if (!url) {
      fields.querySelector('[data-field="url"]').focus();
      return;
    }

    // Ensure URL has protocol
    const finalUrl = url.match(/^https?:\/\//) ? url : `https://${url}`;

    try {
      await TabStashStorage.addManualTab(collectionId, title || finalUrl, finalUrl);
      console.log(`[TabStash] Added manual tab: ${finalUrl}`);
      fields.querySelector('[data-field="title"]').value = '';
      fields.querySelector('[data-field="url"]').value = '';
      fields.classList.add('hidden');
      toggle.classList.remove('hidden');
      await loadData();
      render();
    } catch (err) {
      console.error('[TabStash] addManualTab error:', err);
      showToast('Error adding tab');
    }
  });

  // Enter to submit
  fields.querySelectorAll('.add-tab-input').forEach((input) => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') fields.querySelector('.add-tab-submit').click();
      if (e.key === 'Escape') fields.querySelector('.add-tab-cancel').click();
    });
  });

  form.appendChild(toggle);
  form.appendChild(fields);
  return form;
}

// ── Tab row ────────────────────────────────────────────
function buildTabRow(tab, collectionId) {
  const row = document.createElement('div');
  row.className = `tab-row${tab.archived ? ' archived' : ''}`;

  const tags = tab.tags || [];

  const icon = faviconUrl(tab.url);
  const favicon = icon
    ? `<img class="tab-favicon" src="${escAttr(icon)}" alt="" loading="lazy">`
    : '<div class="tab-favicon-placeholder"></div>';

  const tagHtml = tags.map((t) =>
    `<span class="tag-chip" data-tag="${escAttr(t)}">${escHtml(t)}<button class="tag-remove" title="Remove tag">\u00d7</button></span>`
  ).join('');

  row.innerHTML = `
    ${favicon}
    <div class="tab-info">
      <div class="tab-title-row">
        <span class="tab-title" title="${escAttr(tab.url)}">${escHtml(tab.title)}</span>
        <div class="tag-container">
          ${tagHtml}
          <button class="tag-add-btn" title="Add tag">+</button>
        </div>
      </div>
      <div class="tab-url">${escHtml(shortUrl(tab.url))}</div>
    </div>
    <div class="tab-meta">
      <span class="tab-date">${relativeDate(tab.savedAt)}</span>
    </div>
    <div class="tab-actions">
      <button class="icon-btn open-btn" title="Open">
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M2 6.5H10.5M10.5 6.5L7 3M10.5 6.5L7 10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <button class="icon-btn edit-btn" title="Edit">
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M9.5 2L11 3.5L4.5 10H3V8.5L9.5 2Z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/></svg>
      </button>
      <button class="icon-btn move-tab-btn" title="Move to collection">
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><circle cx="6.5" cy="6.5" r="5" stroke="currentColor" stroke-width="1.1" fill="none"/><path d="M6.5 4V9M4 6.5H9" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>
      </button>
      <button class="icon-btn danger del-tab-btn" title="Delete">
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M3 3.5L10 10.5M10 3.5L3 10.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
      </button>
    </div>
  `;

  // Open tab
  row.querySelector('.tab-title').addEventListener('click', () => {
    chrome.tabs.create({ url: tab.url }).catch((err) => console.warn('[TabStash] open error:', err));
    TabStashStorage.logAction('open', { tabId: tab.id });
  });
  row.querySelector('.open-btn').addEventListener('click', () => {
    chrome.tabs.create({ url: tab.url }).catch((err) => console.warn('[TabStash] open error:', err));
    TabStashStorage.logAction('open', { tabId: tab.id });
  });

  // Edit tab
  row.querySelector('.edit-btn').addEventListener('click', async () => {
    const nextTitle = prompt('Edit tab title:', tab.title);
    if (nextTitle === null) return;
    const nextUrlRaw = prompt('Edit tab URL:', tab.url);
    if (nextUrlRaw === null) return;
    const nextUrl = nextUrlRaw.trim();
    if (!nextUrl) {
      showToast('URL required');
      return;
    }
    const finalUrl = nextUrl.match(/^https?:\/\//) ? nextUrl : `https://${nextUrl}`;
    try {
      await TabStashStorage.updateTab(tab.id, {
        title: nextTitle.trim() || finalUrl,
        url: finalUrl,
      });
      await loadData();
      render();
    } catch (err) {
      console.error('[TabStash] updateTab error:', err);
      showToast('Error updating tab');
    }
  });

  // Delete tab
  row.querySelector('.del-tab-btn').addEventListener('click', async () => {
    try {
      await TabStashStorage.removeTab(tab.id);
      await loadData();
      render();
    } catch (err) {
      console.error('[TabStash] removeTab error:', err);
    }
  });

  // Move tab
  row.querySelector('.move-tab-btn').addEventListener('click', () => {
    openMoveModal(tab.id, collectionId);
  });

  // Tag: remove
  row.querySelectorAll('.tag-remove').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const tagName = btn.closest('.tag-chip').dataset.tag;
      try {
        await TabStashStorage.removeTag(tab.id, tagName);
        await loadData();
        render();
      } catch (err) {
        console.error('[TabStash] removeTag error:', err);
      }
    });
  });

  // Tag: add
  row.querySelector('.tag-add-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const btn = e.currentTarget;
    const input = document.createElement('input');
    input.className = 'tag-inline-input';
    input.placeholder = 'tag';
    input.maxLength = 20;
    btn.replaceWith(input);
    input.focus();

    const finish = async () => {
      const val = input.value.trim();
      if (val) {
        try {
          await TabStashStorage.addTag(tab.id, val);
          await loadData();
        } catch (err) {
          console.error('[TabStash] addTag error:', err);
        }
      }
      render();
    };

    input.addEventListener('blur', finish);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') input.blur();
      if (ev.key === 'Escape') { input.value = ''; input.blur(); }
    });
  });

  return row;
}

// ── Sidebar ────────────────────────────────────────────
function updateSidebar() {
  const countEl = $('#nav-all-count');
  if (countEl) countEl.textContent = '';

  $$('.nav-item[data-view]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === state.currentView);
  });

  const list = $('#sidebar-collections');
  list.innerHTML = '';

  const pinned = state.collections.filter((c) => c.isPinned);
  const unpinned = state.collections.filter((c) => !c.isPinned);

  const addSidebarSection = (labelText, items, emptyText) => {
    const label = document.createElement('div');
    label.className = 'sidebar-section-label';
    label.textContent = labelText;
    list.appendChild(label);

    if (items.length > 0) {
      for (const col of items) {
        list.appendChild(buildSidebarItem(col));
      }
      return;
    }

    const placeholder = document.createElement('div');
    placeholder.className = 'sidebar-section-placeholder';
    placeholder.textContent = emptyText;
    list.appendChild(placeholder);
  };

  addSidebarSection('Pinned', pinned, 'No pinned sessions yet.');

  if (unpinned.length > 0) {
    const label = document.createElement('div');
    label.className = 'sidebar-section-label';
    label.textContent = 'Collections';
    list.appendChild(label);
    for (const col of unpinned) {
      list.appendChild(buildSidebarItem(col));
    }
  }
}

function buildSidebarItem(col) {
  const btn = document.createElement('button');
  const isPinned = Boolean(col.isPinned);
  btn.className = `sidebar-col-item sidebar-col-item--${isPinned ? 'pinned' : 'standard'}${state.currentView === col.id ? ' active' : ''}`;

  const pinSvg = isPinned
    ? '<svg class="sidebar-pin-icon" width="11" height="11" viewBox="0 0 13 13" fill="none"><path d="M3.5 1.5H9.5V11.5L6.5 9L3.5 11.5V1.5Z" stroke="currentColor" stroke-width="1.1" fill="currentColor" stroke-linejoin="round"/></svg>'
    : '';

  const activeCount = Array.isArray(col.tabs)
    ? col.tabs.filter((t) => !t.archived).length
    : 0;
  const countBadge = activeCount > 0
    ? `<span class="sidebar-col-count${isPinned ? ' sidebar-col-count--pinned' : ''}">${activeCount}</span>`
    : '';

  // Hover actions: pin toggle + delete
  const hoverPinIcon = isPinned
    ? '<svg width="11" height="11" viewBox="0 0 13 13" fill="none"><path d="M3.5 1.5H9.5V11.5L6.5 9L3.5 11.5V1.5Z" stroke="currentColor" stroke-width="1.1" fill="currentColor" stroke-linejoin="round"/></svg>'
    : '<svg width="11" height="11" viewBox="0 0 13 13" fill="none"><path d="M3.5 1.5H9.5V11.5L6.5 9L3.5 11.5V1.5Z" stroke="currentColor" stroke-width="1.1" fill="none" stroke-linejoin="round"/></svg>';

  btn.innerHTML = `
    ${pinSvg}
    <span class="sidebar-col-name">${escHtml(col.name)}</span>
    ${countBadge}
    <span class="sidebar-col-actions">
      <button class="sidebar-hover-pin${isPinned ? ' sidebar-hover-pin-active' : ''}" title="${isPinned ? 'Unpin' : 'Pin'}">${hoverPinIcon}</button>
      <button class="sidebar-hover-delete" title="Delete collection">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 2L8 8M8 2L2 8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
      </button>
    </span>
  `;

  btn.addEventListener('click', (e) => {
    if (e.target.closest('.sidebar-col-actions')) return;
    state.currentView = col.id;
    state.searchQuery = '';
    $('#search').value = '';
    render();
  });

  // Pin toggle
  btn.querySelector('.sidebar-hover-pin')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await TabStashStorage.togglePin(col.id);
      await loadData();
      render();
    } catch (err) {
      console.error('[TabStash] togglePin error:', err);
    }
  });

  // Delete from sidebar
  btn.querySelector('.sidebar-hover-delete')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (confirm(`Delete "${col.name}"? This can't be undone.`)) {
      try {
        await TabStashStorage.removeCollection(col.id);
        if (state.currentView === col.id) state.currentView = 'all';
        await loadData();
        render();
      } catch (err) {
        console.error('[TabStash] Delete error:', err);
      }
    }
  });

  return btn;
}

function updateViewHeader() {
  const title = $('#view-title');
  const count = $('#view-count');
  const actions = $('#view-actions');

  if (state.searchQuery.trim()) {
    title.textContent = 'Search';
    count.innerHTML = '';
    actions.classList.add('hidden');
    return;
  }

  if (state.currentView === 'all') {
    const total = state.collections.reduce((s, c) => s + c.tabs.filter((t) => !t.archived).length, 0);
    title.textContent = 'All Tabs';
    count.innerHTML = '';
    if (total) {
      count.appendChild(buildCountBadge(`${total} tab${total !== 1 ? 's' : ''}`));
    }
    actions.classList.toggle('hidden', state.collections.length === 0);
  } else {
    const col = state.collections.find((c) => c.id === state.currentView);
    if (col) {
      const n = col.tabs.filter((t) => !t.archived).length;
      title.textContent = col.name;
      count.innerHTML = '';
      if (n) {
        count.appendChild(buildCountBadge(`${n} tab${n !== 1 ? 's' : ''}`));
      }
    } else {
      title.textContent = 'Not found';
      count.innerHTML = '';
    }
    actions.classList.add('hidden');
  }
}

function buildCountBadge(text, variant) {
  if (!text) return null;
  const badge = document.createElement('span');
  badge.className = `count-badge${variant ? ` count-badge--${variant}` : ''}`;
  badge.textContent = text;
  return badge;
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
    const v = input.value.trim();
    if (v && v !== current) {
      try {
        await TabStashStorage.renameCollection(col.id, v);
        await loadData();
      } catch (err) {
        console.error('[TabStash] rename error:', err);
      }
    }
    render();
  };

  input.addEventListener('blur', finish);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { input.value = current; input.blur(); }
  });
}

// ── Move modal ─────────────────────────────────────────
function openMoveModal(tabId, sourceColId) {
  const list = $('#move-list');
  list.innerHTML = '';

  for (const col of state.collections) {
    if (col.id === sourceColId) continue;
    const item = document.createElement('div');
    item.className = 'move-item';
    item.textContent = col.name;
    item.addEventListener('click', async () => {
      try {
        await TabStashStorage.moveTab(tabId, col.id);
        closeMoveModal();
        await loadData();
        render();
        showToast(`Moved to ${col.name}`);
      } catch (err) {
        console.error('[TabStash] moveTab error:', err);
      }
    });
    list.appendChild(item);
  }

  if (!list.children.length) {
    list.innerHTML = '<div style="padding:14px;color:var(--text-tertiary);font-size:13px;text-align:center">No other collections yet.</div>';
  }

  $('#move-modal').classList.remove('hidden');
}

function closeMoveModal() {
  $('#move-modal').classList.add('hidden');
}

// ── Settings ───────────────────────────────────────────
function openSettings() {
  const s = state.settings;

  const archiveEl = $('#setting-archive-days');
  archiveEl.value = !s.archiveEnabled ? '0' : String([7,30,90].reduce((a,b) => Math.abs(b-s.archiveDays) < Math.abs(a-s.archiveDays) ? b : a));

  replaceWithClone('#setting-archive-days', async (el) => {
    const v = parseInt(el.value, 10);
    try {
      await TabStashStorage.saveSettings({ ...state.settings, archiveEnabled: v > 0, archiveDays: v > 0 ? v : state.settings.archiveDays });
      state.settings = await TabStashStorage.getSettings();
      showToast('Saved');
    } catch (err) {
      console.error('[TabStash] save settings error:', err);
    }
  }, 'change');

  replaceWithClone('#setting-export-btn', async () => {
    try {
      const data = await TabStashStorage.getAll();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `tabstash-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('Exported');
    } catch (err) {
      console.error('[TabStash] export error:', err);
    }
  }, 'click');

  $('#settings-overlay').classList.remove('hidden');
}

function closeSettings() {
  $('#settings-overlay').classList.add('hidden');
}

function replaceWithClone(sel, handler, event) {
  const el = $(sel);
  const clone = el.cloneNode(true);
  el.replaceWith(clone);
  clone.addEventListener(event, () => handler(clone));
}

// ── Command palette ────────────────────────────────────
const COMMANDS = [
  { label: 'Save open tabs', action: () => saveAllTabs() },
  { label: 'View all tabs', action: () => { state.currentView = 'all'; render(); }},
  { label: 'New collection', action: async () => {
    const name = prompt('Collection name:');
    if (name?.trim()) {
      const col = await TabStashStorage.addCollection(name.trim(), []);
      await loadData(); state.currentView = col.id; render();
    }
  }},
  { label: 'Open settings', action: () => openSettings() },
  { label: 'Export data', action: async () => {
    const data = await TabStashStorage.getAll();
    downloadText(`tabstash-${new Date().toISOString().slice(0,10)}.json`, JSON.stringify(data, null, 2), 'application/json');
    showToast('Exported');
  }},
];

let paletteSel = 0;

function openPalette() {
  $('#command-palette').classList.remove('hidden');
  const input = $('#palette-input');
  input.value = '';
  input.focus();
  paletteSel = 0;
  renderPalette('');

  input.oninput = () => { paletteSel = 0; renderPalette(input.value); };
  input.onkeydown = (e) => {
    const items = $$('.palette-item');
    if (e.key === 'ArrowDown') { e.preventDefault(); paletteSel = Math.min(paletteSel + 1, items.length - 1); highlightPalette(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); paletteSel = Math.max(paletteSel - 1, 0); highlightPalette(); }
    else if (e.key === 'Enter') { e.preventDefault(); items[paletteSel]?.click(); }
  };
}

function closePalette() { $('#command-palette').classList.add('hidden'); }

// ── Search panel ───────────────────────────────────────
async function loadRecentSearches() {
  try {
    const data = await chrome.storage.local.get(RECENT_SEARCHES_KEY);
    const items = data[RECENT_SEARCHES_KEY];
    state.recentSearches = Array.isArray(items) ? items : [];
  } catch (err) {
    console.error('[TabStash] load recent searches error:', err);
    state.recentSearches = [];
  }
}

async function saveRecentSearch(query) {
  const trimmed = query.trim();
  if (!trimmed) return;
  const next = [trimmed, ...state.recentSearches.filter((q) => q !== trimmed)].slice(0, 5);
  state.recentSearches = next;
  try {
    await chrome.storage.local.set({ [RECENT_SEARCHES_KEY]: next });
  } catch (err) {
    console.error('[TabStash] save recent searches error:', err);
  }
  updateSearchPanel();
}

async function removeRecentSearch(query) {
  const next = state.recentSearches.filter((q) => q !== query);
  state.recentSearches = next;
  try {
    await chrome.storage.local.set({ [RECENT_SEARCHES_KEY]: next });
  } catch (err) {
    console.error('[TabStash] remove recent search error:', err);
  }
  updateSearchPanel();
}

async function clearRecentSearches() {
  state.recentSearches = [];
  try {
    await chrome.storage.local.set({ [RECENT_SEARCHES_KEY]: [] });
  } catch (err) {
    console.error('[TabStash] clear recent searches error:', err);
  }
  updateSearchPanel();
}

function openSearchPanel() {
  loadRecentSearches().then(() => updateSearchPanel());
  $('#search-panel').classList.remove('hidden');
  $('.search-bar').classList.add('is-focused');
}

function closeSearchPanel() {
  $('#search-panel').classList.add('hidden');
  $('.search-bar').classList.remove('is-focused');
}

function updateSearchPanel() {
  renderRecentSearches();
  updateFilterChips();
}

function renderRecentSearches() {
  const container = $('#recent-searches');
  const clearBtn = $('#clear-search-history');
  container.innerHTML = '';
  if (!state.recentSearches.length) {
    container.innerHTML = '<div class="recent-empty">No recent searches yet.</div>';
    clearBtn?.classList.add('hidden');
    return;
  }

  for (const query of state.recentSearches) {
    const item = document.createElement('div');
    item.className = 'recent-search-item';
    item.tabIndex = 0;
    item.innerHTML = `
      <span class="recent-search-text">${escHtml(query)}</span>
      <span class="recent-search-actions">
        <button class="recent-search-delete" title="Remove search" type="button">&times;</button>
      </span>
    `;
    item.addEventListener('click', () => {
      state.searchQuery = query;
      $('#search').value = query;
      render();
      closeSearchPanel();
    });
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        item.click();
      }
    });
    item.querySelector('.recent-search-delete')?.addEventListener('click', (e) => {
      e.stopPropagation();
      removeRecentSearch(query);
    });
    container.appendChild(item);
  }
  clearBtn?.classList.remove('hidden');
}

function updateFilterChips() {
  const pinnedChip = $('.search-chip[data-filter="pinned"]');
  const last7Chip = $('.search-chip[data-filter="last7"]');
  const domainChip = $('.search-chip[data-filter="domain"]');

  if (!pinnedChip || !last7Chip || !domainChip) {
    return;
  }

  pinnedChip.classList.toggle('active', state.searchFilters.pinnedOnly);
  last7Chip.classList.toggle('active', state.searchFilters.last7Days);
  domainChip.classList.toggle('active', Boolean(state.searchFilters.domain));

  const domainValue = $('#domain-filter-value');
  domainValue.textContent = state.searchFilters.domain ? state.searchFilters.domain : '';
}

function renderPalette(q) {
  const container = $('#palette-results');
  container.innerHTML = '';
  q = q.toLowerCase().trim();

  const all = [
    ...COMMANDS,
    ...state.collections.map((c) => ({
      label: `Go to: ${c.name}`,
      hint: `${c.tabs.filter((t) => !t.archived).length} tabs`,
      action: () => { state.currentView = c.id; render(); },
    })),
  ];

  const filtered = q ? all.filter((c) => c.label.toLowerCase().includes(q)) : all;

  for (let i = 0; i < filtered.length; i++) {
    const cmd = filtered[i];
    const div = document.createElement('div');
    div.className = `palette-item${i === paletteSel ? ' selected' : ''}`;
    div.innerHTML = `<span class="palette-item-label">${escHtml(cmd.label)}</span>${cmd.hint ? `<span class="palette-item-hint">${escHtml(cmd.hint)}</span>` : ''}`;
    div.addEventListener('click', () => { closePalette(); cmd.action(); });
    container.appendChild(div);
  }
}

function highlightPalette() {
  $$('.palette-item').forEach((el, i) => el.classList.toggle('selected', i === paletteSel));
}

// ── Toast ──────────────────────────────────────────────
function showToast(msg) {
  const toast = $('#toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  toast.offsetHeight;
  toast.classList.add('visible');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.classList.add('hidden'), 200);
  }, 2000);
}

// ── Helpers ────────────────────────────────────────────
function formatCollectionName(d = new Date()) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const hour = d.getHours();
  const period = hour < 12 ? 'AM' : 'PM';
  return `${months[d.getMonth()]} ${d.getDate()}, ${period}`;
}

function formatPreciseTimestamp(ts) {
  const d = new Date(ts);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} \u00b7 ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
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
  return `${Math.floor(days / 30)}mo ago`;
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    const p = u.pathname !== '/' ? u.pathname : '';
    const s = u.hostname + p;
    return s.length > 55 ? s.slice(0, 52) + '\u2026' : s;
  } catch { return url; }
}

function escHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function escAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function downloadText(name, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
