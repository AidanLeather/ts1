/**
 * TabStash – Popup main script
 *
 * This runs every time the popup opens. It reads from chrome.storage.local,
 * renders the UI, and attaches event handlers.
 *
 * Key Chrome APIs used:
 *   chrome.tabs.query()   – reads the current window's tabs
 *   chrome.tabs.create()  – opens a URL in a new tab (for restore)
 *   chrome.tabs.remove()  – closes a tab after saving (optional)
 *   chrome.storage.local  – persistent key-value store (via lib/storage.js)
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ── State ──────────────────────────────────────────────
let collections = [];
let dupCounts = new Map();
let searchQuery = '';
let moveTabId = null; // tab being moved

// ── Init ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadData();
  render();
  bindEvents();
});

async function loadData() {
  collections = await TabStashStorage.getCollections();
  dupCounts = await TabStashStorage.getDuplicateCounts();
}

// ── Event binding ──────────────────────────────────────
function bindEvents() {
  // Save all tabs (quick save – auto-named by date/time)
  $('#save-all-btn').addEventListener('click', async () => {
    const tabs = await getCurrentTabs();
    if (tabs.length === 0) return;

    const name = formatCollectionName();
    await TabStashStorage.addCollection(name, tabs);
    await loadData();
    render();
  });

  // Save to named collection – show input
  $('#save-named-btn').addEventListener('click', () => {
    $('#name-input-wrap').classList.remove('hidden');
    $('#collection-name').focus();
  });

  $('#name-cancel-btn').addEventListener('click', () => {
    $('#name-input-wrap').classList.add('hidden');
    $('#collection-name').value = '';
  });

  $('#name-confirm-btn').addEventListener('click', saveNamedCollection);
  $('#collection-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveNamedCollection();
    if (e.key === 'Escape') $('#name-cancel-btn').click();
  });

  // Search
  $('#search').addEventListener('input', (e) => {
    searchQuery = e.target.value;
    render();
  });

  // Settings
  $('#settings-btn').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // Open full page
  $('#open-full-btn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'openFullPage' });
    window.close();
  });

  // Move modal cancel
  $('#move-cancel-btn').addEventListener('click', closeMoveModal);
  $('.modal-backdrop').addEventListener('click', closeMoveModal);
}

async function saveNamedCollection() {
  const name = $('#collection-name').value.trim();
  if (!name) return;

  const tabs = await getCurrentTabs();
  if (tabs.length === 0) return;

  await TabStashStorage.addCollection(name, tabs);
  $('#name-input-wrap').classList.add('hidden');
  $('#collection-name').value = '';
  await loadData();
  render();
}

// ── Get current window's tabs ──────────────────────────
async function getCurrentTabs() {
  /**
   * chrome.tabs.query({ currentWindow: true }) returns all tabs in the
   * window that opened this popup. We filter out chrome:// internal pages
   * since those can't be restored and aren't useful to save.
   */
  const tabs = await chrome.tabs.query({ currentWindow: true });
  return tabs.filter(
    (t) => t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://')
  );
}

// ── Render ─────────────────────────────────────────────
function render() {
  const collectionsEl = $('#collections');
  const emptyEl = $('#empty-state');
  const searchResultsEl = $('#search-results');

  // Search mode
  if (searchQuery.trim()) {
    const results = TabStashStorage.search(collections, searchQuery);
    collectionsEl.classList.add('hidden');
    emptyEl.classList.add('hidden');
    searchResultsEl.classList.remove('hidden');
    renderSearchResults(searchResultsEl, results);
    return;
  }

  searchResultsEl.classList.add('hidden');

  if (collections.length === 0) {
    collectionsEl.classList.add('hidden');
    emptyEl.classList.remove('hidden');
    return;
  }

  emptyEl.classList.add('hidden');
  collectionsEl.classList.remove('hidden');
  collectionsEl.innerHTML = '';

  for (const col of collections) {
    collectionsEl.appendChild(renderCollection(col));
  }
}

function renderCollection(col) {
  const div = document.createElement('div');
  div.className = 'collection';
  div.dataset.id = col.id;

  const activeTabs = col.tabs.filter((t) => !t.archived);
  const archivedTabs = col.tabs.filter((t) => t.archived);

  div.innerHTML = `
    <div class="collection-header">
      <span class="collapse-arrow">▼</span>
      <span class="collection-name">${escHtml(col.name)}</span>
      <span class="collection-count">${activeTabs.length} tab${activeTabs.length !== 1 ? 's' : ''}${archivedTabs.length ? ` · ${archivedTabs.length} archived` : ''}</span>
      <div class="collection-actions">
        <button class="icon-btn restore-all-btn" title="Restore all tabs">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M2 7H12M12 7L8 3M12 7L8 11" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <button class="icon-btn rename-btn" title="Rename">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M10 2L12 4L5 11H3V9L10 2Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
          </svg>
        </button>
        <button class="icon-btn delete-col-btn btn-danger" title="Delete collection">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M3 4H11L10.3 12H3.7L3 4Z" stroke="currentColor" stroke-width="1.2"/>
            <path d="M2 4H12" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
            <path d="M5 4V2.5C5 2.2 5.2 2 5.5 2H8.5C8.8 2 9 2.2 9 2.5V4" stroke="currentColor" stroke-width="1.2"/>
          </svg>
        </button>
      </div>
    </div>
    <div class="collection-body"></div>
  `;

  // Collapse toggle
  div.querySelector('.collection-header').addEventListener('click', (e) => {
    // Don't toggle if clicking action buttons
    if (e.target.closest('.collection-actions')) return;
    div.classList.toggle('collapsed');
  });

  // Restore all
  div.querySelector('.restore-all-btn').addEventListener('click', async (e) => {
    e.stopPropagation();
    for (const tab of activeTabs) {
      chrome.tabs.create({ url: tab.url, active: false });
    }
  });

  // Rename
  div.querySelector('.rename-btn').addEventListener('click', async (e) => {
    e.stopPropagation();
    const nameEl = div.querySelector('.collection-name');
    const current = nameEl.textContent;
    const newName = prompt('Rename collection:', current);
    if (newName && newName.trim() && newName.trim() !== current) {
      await TabStashStorage.renameCollection(col.id, newName.trim());
      await loadData();
      render();
    }
  });

  // Delete collection
  div.querySelector('.delete-col-btn').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (confirm(`Delete "${col.name}" and all its tabs?`)) {
      await TabStashStorage.removeCollection(col.id);
      await loadData();
      render();
    }
  });

  // Render tabs
  const body = div.querySelector('.collection-body');
  const allTabs = [...activeTabs, ...archivedTabs];
  for (const tab of allTabs) {
    body.appendChild(renderTabRow(tab, col.id));
  }

  return div;
}

function renderTabRow(tab, collectionId) {
  const row = document.createElement('div');
  row.className = `tab-row${tab.archived ? ' archived' : ''}`;
  row.dataset.tabId = tab.id;

  const count = dupCounts.get(tab.url) || 0;
  const dupBadge =
    count > 1 ? `<span class="dup-badge">×${count}</span>` : '';

  const faviconHtml = tab.favIconUrl
    ? `<img class="tab-favicon" src="${escAttr(tab.favIconUrl)}" alt="">`
    : `<div class="tab-favicon-placeholder"></div>`;

  row.innerHTML = `
    ${faviconHtml}
    <div class="tab-info">
      <div class="tab-title" title="${escAttr(tab.url)}">${escHtml(tab.title)}</div>
      <div class="tab-url">${escHtml(shortUrl(tab.url))}</div>
    </div>
    <div class="tab-meta">
      <span class="tab-date">${relativeDate(tab.savedAt)}</span>
      ${dupBadge}
    </div>
    <div class="tab-actions">
      <button class="icon-btn restore-btn" title="Open tab">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M2 6H10M10 6L7 3M10 6L7 9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
      <button class="icon-btn move-btn" title="Move to collection">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <rect x="1" y="2" width="10" height="8" rx="1" stroke="currentColor" stroke-width="1.1" fill="none"/>
          <path d="M1 4.5H11" stroke="currentColor" stroke-width="1.1"/>
        </svg>
      </button>
      <button class="icon-btn delete-btn btn-danger" title="Delete tab">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M3 3L9 9M9 3L3 9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
        </svg>
      </button>
    </div>
  `;

  // Open/restore tab
  row.querySelector('.tab-title').addEventListener('click', () => {
    chrome.tabs.create({ url: tab.url });
  });
  row.querySelector('.restore-btn').addEventListener('click', () => {
    chrome.tabs.create({ url: tab.url });
  });

  // Delete tab
  row.querySelector('.delete-btn').addEventListener('click', async () => {
    await TabStashStorage.removeTab(tab.id);
    await loadData();
    render();
  });

  // Move tab
  row.querySelector('.move-btn').addEventListener('click', () => {
    openMoveModal(tab.id, collectionId);
  });

  return row;
}

function renderSearchResults(container, results) {
  if (results.length === 0) {
    container.innerHTML = `
      <div class="search-results-title">Search results</div>
      <div class="empty-state" style="padding: 20px 0">
        <p class="empty-sub">No tabs matching "${escHtml(searchQuery)}"</p>
      </div>
    `;
    return;
  }

  container.innerHTML = `<div class="search-results-title">${results.length} result${results.length !== 1 ? 's' : ''}</div>`;

  for (const tab of results) {
    const row = renderTabRow(tab, tab.collectionId);
    // Add collection label
    const info = row.querySelector('.tab-info');
    const colLabel = document.createElement('div');
    colLabel.className = 'search-result-collection';
    colLabel.textContent = tab.collectionName;
    info.appendChild(colLabel);
    container.appendChild(row);
  }
}

// ── Move modal ─────────────────────────────────────────
function openMoveModal(tabId, currentCollectionId) {
  moveTabId = tabId;
  const list = $('#move-list');
  list.innerHTML = '';

  for (const col of collections) {
    if (col.id === currentCollectionId) continue;
    const item = document.createElement('div');
    item.className = 'move-item';
    item.textContent = col.name;
    item.addEventListener('click', async () => {
      await TabStashStorage.moveTab(tabId, col.id);
      closeMoveModal();
      await loadData();
      render();
    });
    list.appendChild(item);
  }

  if (list.children.length === 0) {
    list.innerHTML = '<div style="padding:8px;color:var(--text-tertiary);font-size:12px">No other collections to move to.</div>';
  }

  $('#move-modal').classList.remove('hidden');
}

function closeMoveModal() {
  $('#move-modal').classList.add('hidden');
  moveTabId = null;
}

// ── Helpers ────────────────────────────────────────────
function formatCollectionName() {
  const d = new Date();
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} · ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function relativeDate(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  return `${months}mo`;
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname !== '/' ? u.pathname : '');
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
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
