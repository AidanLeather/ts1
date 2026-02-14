/**
 * WhyTab – Full-page management UI
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
  pendingSidebarCollectionId: null,
  archivedExpanded: {},
  hasAutoArchiveCheckRun: false,
  pruneMode: {
    active: false,
    unpinnedOrderIds: [],
    archivedCount: 0,
    deletedCount: 0,
    exitDisplayUntil: 0,
  },
};

let dragState = {
  type: null,
  collectionId: null,
  source: null,
  collectionPinned: null,
  tabId: null,
  tabCollectionId: null,
  tabSourceRow: null,
  tabDragImage: null,
  tabDropCollectionId: null,
  tabDropIndex: null,
  suppressTabClickId: null,
  autoScrollRaf: null,
  autoScrollVelocity: 0,
};

const RECENT_SEARCHES_KEY = 'recentSearches';
const PRUNE_TALLY_HOLD_MS = 2000;
let inlineEditSession = null;
let inlineInputModalSession = null;
const COLLECTION_SORT_OPTIONS = [
  { value: 'newest', label: 'Newest', menuLabel: 'Newest first' },
  { value: 'oldest', label: 'Oldest', menuLabel: 'Oldest first' },
  { value: 'az', label: 'A–Z', menuLabel: 'Alphabetical (A–Z)' },
  { value: 'za', label: 'Z–A', menuLabel: 'Alphabetical (Z–A)' },
];

function getAccordionState() {
  return state.settings.accordionState || {};
}

async function setAccordionState(nextState) {
  try {
    await WhyTabStorage.saveSettings({ ...state.settings, accordionState: nextState });
    state.settings = await WhyTabStorage.getSettings();
  } catch (err) {
    console.error('[WhyTab] save accordion state error:', err);
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
  console.log('[WhyTab] Page loaded, listening for storage changes');
});

async function loadData() {
  try {
    const settings = await WhyTabStorage.getSettings();
    if (!state.hasAutoArchiveCheckRun && settings.autoArchiveInactiveSessions) {
      await WhyTabStorage.autoArchiveInactiveSessions();
    }
    state.hasAutoArchiveCheckRun = true;

    const data = await WhyTabStorage.getAll();
    state.settings = data.settings;
    state.collections = getCollectionsForCurrentMode(data.collections, state.settings.collectionSort);
    state.urlIndex = data.urlIndex;
    console.log(`[WhyTab] Loaded ${state.collections.length} collections`);
  } catch (err) {
    console.error('[WhyTab] loadData error:', err);
  }
}

// ── Real-time storage listener ─────────────────────────
function bindStorageListener() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.collections || changes.urlIndex || changes.settings) {
      console.log('[WhyTab] Storage changed, refreshing...');
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
  document.addEventListener('dragover', handleGlobalDragOver);

  // Sidebar: "All Tabs"
  $$('.nav-item[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.currentView = btn.dataset.view;
      state.searchQuery = '';
      $('#search').value = '';
      render();
      if (btn.dataset.view === 'all') {
        scrollMainToTop();
      }
    });
  });

  // Search
  $('#search').addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    if (!state.searchQuery.trim()) {
      setSearchFocusState(false);
    } else if (document.activeElement === $('#search')) {
      setSearchFocusState(true);
    }
    render();
  });
  $('#search-clear-btn')?.addEventListener('click', () => {
    state.searchQuery = '';
    $('#search').value = '';
    render();
    $('#search').focus();
    setSearchFocusState(false);
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
    chip.addEventListener('click', async () => {
      const filter = chip.dataset.filter;
      if (filter === 'pinned') {
        state.searchFilters.pinnedOnly = !state.searchFilters.pinnedOnly;
      } else if (filter === 'last7') {
        state.searchFilters.last7Days = !state.searchFilters.last7Days;
      } else if (filter === 'domain') {
        if (state.searchFilters.domain) {
          state.searchFilters.domain = '';
        } else {
          const domain = await openInlineInputModal({
            title: 'Filter by domain',
            placeholder: 'example.com',
            confirmLabel: 'Apply',
            initialValue: state.searchFilters.domain,
          });
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
  $('#save-tabs-btn').addEventListener('click', saveAndCloseTabs);

  // Empty state CTA
  $('#empty-cta-btn')?.addEventListener('click', saveAllTabs);

  // New collection
  $('#new-collection-btn').addEventListener('click', async () => {
    const name = await openInlineInputModal({
      title: 'New collection',
      placeholder: 'Collection name',
      confirmLabel: 'Create',
    });
    if (name && name.trim()) {
      try {
        const col = await WhyTabStorage.addCollection(name.trim(), [], { isUserNamed: true });
        await loadData();
        state.currentView = col.id;
        render();
      } catch (err) {
        console.error('[WhyTab] New collection error:', err);
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

  // Inline input modal
  $('#inline-input-modal-cancel').addEventListener('click', closeInlineInputModal);
  $('#inline-input-modal .modal-backdrop').addEventListener('click', closeInlineInputModal);
  $('#inline-input-modal-confirm').addEventListener('click', submitInlineInputModal);
  $('#inline-input-modal-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitInlineInputModal();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeInlineInputModal();
    }
  });

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

  $('#prune-mode-btn')?.addEventListener('click', async () => {
    if (state.pruneMode.active) {
      exitPruneMode();
      await loadData();
      render();
      return;
    }
    enterPruneMode();
    await loadData();
    render();
  });

  const sortMenu = $('#collection-sort-menu');
  sortMenu?.querySelectorAll('.collection-sort-item').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const nextSort = btn.dataset.sort;
      if (!nextSort || nextSort === state.settings.collectionSort) {
        sortMenu.removeAttribute('open');
        return;
      }
      await saveCollectionSortPreference(nextSort);
      sortMenu.removeAttribute('open');
      await loadData();
      render();
    });
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.inline-menu')) {
      $$('.inline-menu[open]').forEach((menu) => menu.removeAttribute('open'));
    }
    if (!e.target.closest('.search-bar')) {
      closeSearchPanel();
    }
  });
}

function getSavedCollections() {
  return state.collections
    .filter((c) => c.isUserNamed && !c.archived)
    .sort((a, b) => (b.lastInteractedAt || b.createdAt || 0) - (a.lastInteractedAt || a.createdAt || 0));
}


function getPruneSortedUnpinnedCollections(collections) {
  return [...collections].sort((a, b) => {
    const aNever = a.lastInteractedAt == null;
    const bNever = b.lastInteractedAt == null;
    if (aNever !== bNever) return aNever ? -1 : 1;

    const aTs = a.lastInteractedAt ?? 0;
    const bTs = b.lastInteractedAt ?? 0;
    if (aTs !== bTs) return aTs - bTs;

    if (a.isUserNamed !== b.isUserNamed) return a.isUserNamed ? 1 : -1;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
}

function getCollectionsForCurrentMode(collections, sortMode) {
  if (!state.pruneMode.active) {
    return getCollectionsForDisplay(collections, sortMode);
  }

  const visibleCollections = collections.filter((c) => c.name !== 'Unsorted');
  const pinned = visibleCollections.filter((c) => c.isPinned);
  const archived = visibleCollections.filter((c) => c.archived);
  const unpinnedActive = visibleCollections.filter((c) => !c.isPinned && !c.archived);

  const frozenOrder = state.pruneMode.unpinnedOrderIds
    .map((id) => unpinnedActive.find((col) => col.id === id))
    .filter(Boolean);
  const existingIds = new Set(frozenOrder.map((col) => col.id));
  const overflow = unpinnedActive.filter((col) => !existingIds.has(col.id));

  return [...pinned, ...frozenOrder, ...overflow, ...archived];
}

function enterPruneMode() {
  const visibleCollections = state.collections.filter((c) => c.name !== 'Unsorted');
  const unpinnedActive = visibleCollections.filter((c) => !c.isPinned && !c.archived);
  state.pruneMode.active = true;
  state.pruneMode.unpinnedOrderIds = getPruneSortedUnpinnedCollections(unpinnedActive).map((c) => c.id);
  state.pruneMode.archivedCount = 0;
  state.pruneMode.deletedCount = 0;
  state.pruneMode.exitDisplayUntil = 0;
}

function exitPruneMode() {
  state.pruneMode.active = false;
  state.pruneMode.unpinnedOrderIds = [];
  state.pruneMode.exitDisplayUntil = Date.now() + PRUNE_TALLY_HOLD_MS;
  renderPruneTally();
  setTimeout(() => {
    if (Date.now() < state.pruneMode.exitDisplayUntil || state.pruneMode.active) return;
    state.pruneMode.archivedCount = 0;
    state.pruneMode.deletedCount = 0;
    state.pruneMode.exitDisplayUntil = 0;
    renderPruneTally();
  }, PRUNE_TALLY_HOLD_MS + 330);
}

function incrementPruneTally(type) {
  if (!state.pruneMode.active) return;
  if (type === 'archived') state.pruneMode.archivedCount += 1;
  if (type === 'deleted') state.pruneMode.deletedCount += 1;
  animatePruneTally();
}

function formatRelativeActivity(timestamp) {
  if (timestamp == null) return 'Never opened';
  const diffMs = Date.now() - timestamp;
  const dayMs = 24 * 60 * 60 * 1000;
  if (diffMs < dayMs) return 'Active today';
  const days = Math.floor(diffMs / dayMs);
  if (days < 7) return `Active ${days} day${days === 1 ? '' : 's'} ago`;
  if (days < 30) {
    const weeks = Math.floor(days / 7);
    return `Active ${weeks} week${weeks === 1 ? '' : 's'} ago`;
  }
  const months = Math.floor(days / 30);
  return `Active ${months} month${months === 1 ? '' : 's'} ago`;
}

function shouldShowUntouchedHint(collection) {
  if (!state.pruneMode.active || collection.isPinned || collection.isUserNamed) return false;
  if (collection.lastInteractedAt == null) return true;
  const diffMs = Date.now() - collection.lastInteractedAt;
  return diffMs >= 7 * 24 * 60 * 60 * 1000;
}
function getCollectionsForDisplay(collections, sortMode) {
  const visibleCollections = collections.filter((c) => c.name !== 'Unsorted');
  const pinned = visibleCollections.filter((c) => c.isPinned);
  const unpinnedActive = WhyTabStorage.sortCollections(
    visibleCollections.filter((c) => !c.isPinned && !c.archived),
    sortMode,
  );
  const archived = visibleCollections.filter((c) => c.archived);
  return [...pinned, ...unpinnedActive, ...archived];
}

async function saveCollectionSortPreference(sortMode) {
  await WhyTabStorage.saveSettings({
    ...state.settings,
    collectionSort: sortMode,
  });
  state.settings.collectionSort = sortMode;
}

function getSortMeta(sortMode = 'newest') {
  return COLLECTION_SORT_OPTIONS.find((opt) => opt.value === sortMode) || COLLECTION_SORT_OPTIONS[0];
}

function renderSortControl() {
  const sortLabel = $('#collection-sort-label');
  if (!sortLabel) return;
  const activeSort = state.settings.collectionSort || 'newest';
  const activeMeta = getSortMeta(activeSort);
  sortLabel.textContent = activeMeta.label;
  $$('.collection-sort-item').forEach((item) => {
    const isActive = item.dataset.sort === activeSort;
    item.classList.toggle('active', isActive);
    item.setAttribute('aria-checked', String(isActive));
  });
}

function clearTabDropIndicator() {
  document.querySelectorAll('.tab-drop-indicator').forEach((el) => el.remove());
  dragState.tabDropCollectionId = null;
  dragState.tabDropIndex = null;
}

function resetTabDragState() {
  clearTabDropIndicator();
  dragState.type = null;
  dragState.tabId = null;
  dragState.tabCollectionId = null;
  dragState.tabSourceRow?.classList.remove('is-dragging');
  dragState.tabSourceRow = null;
  $$('.tab-row').forEach((el) => el.classList.remove('drag-target', 'is-dragging'));
  $$('.collection-block').forEach((el) => el.classList.remove('drag-target'));
  $$('.sidebar-col-item').forEach((el) => el.classList.remove('drag-target'));
  if (dragState.tabDragImage?.parentNode) {
    dragState.tabDragImage.parentNode.removeChild(dragState.tabDragImage);
  }
  dragState.tabDragImage = null;
  stopAutoScroll();
}

function startAutoScroll() {
  if (dragState.autoScrollRaf) return;
  const tick = () => {
    const content = $('#content');
    if (!content || !dragState.autoScrollVelocity) {
      dragState.autoScrollRaf = null;
      return;
    }
    content.scrollTop += dragState.autoScrollVelocity;
    dragState.autoScrollRaf = requestAnimationFrame(tick);
  };
  dragState.autoScrollRaf = requestAnimationFrame(tick);
}

function stopAutoScroll() {
  dragState.autoScrollVelocity = 0;
  if (dragState.autoScrollRaf) {
    cancelAnimationFrame(dragState.autoScrollRaf);
    dragState.autoScrollRaf = null;
  }
}

function handleGlobalDragOver(e) {
  if (dragState.type !== 'tab') return;
  const content = $('#content');
  if (!content) return;
  const rect = content.getBoundingClientRect();
  const edgeThreshold = 56;
  const maxVelocity = 12;

  if (e.clientY < rect.top + edgeThreshold) {
    const factor = (rect.top + edgeThreshold - e.clientY) / edgeThreshold;
    dragState.autoScrollVelocity = -Math.max(2, Math.round(maxVelocity * factor));
    startAutoScroll();
    return;
  }

  if (e.clientY > rect.bottom - edgeThreshold) {
    const factor = (e.clientY - (rect.bottom - edgeThreshold)) / edgeThreshold;
    dragState.autoScrollVelocity = Math.max(2, Math.round(maxVelocity * factor));
    startAutoScroll();
    return;
  }

  stopAutoScroll();
}

function createTabDragPreview(title, faviconSrc) {
  const ghost = document.createElement('div');
  ghost.className = 'tab-drag-ghost';
  ghost.innerHTML = `
    ${faviconSrc ? `<img class="tab-favicon" src="${escAttr(faviconSrc)}" alt=""/>` : '<div class="tab-favicon-placeholder"></div>'}
    <span class="tab-drag-ghost-title">${escHtml(title)}</span>
  `;
  document.body.appendChild(ghost);
  return ghost;
}

async function moveDraggedTabToCollection(targetCollectionId, targetIndex = null) {
  if (!dragState.tabId || !dragState.tabCollectionId || !targetCollectionId) return;
  await WhyTabStorage.moveTab(dragState.tabId, targetCollectionId, targetIndex);
  await loadData();
  render();
}

function getDropIndexInCollectionBody(body, clientY) {
  const rows = [...body.querySelectorAll('.tab-row')]
    .filter((el) => el.dataset.id !== dragState.tabId);

  for (let i = 0; i < rows.length; i += 1) {
    const rect = rows[i].getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    if (clientY < midpoint) return i;
  }

  return rows.length;
}

function updateTabDropIndicator(collectionId, body, dropIndex) {
  clearTabDropIndicator();
  const indicator = document.createElement('div');
  indicator.className = 'tab-drop-indicator';

  const rows = [...body.querySelectorAll('.tab-row')]
    .filter((el) => el.dataset.id !== dragState.tabId);
  if (dropIndex >= rows.length) {
    body.appendChild(indicator);
  } else {
    body.insertBefore(indicator, rows[dropIndex]);
  }

  dragState.tabDropCollectionId = collectionId;
  dragState.tabDropIndex = dropIndex;
}

function scrollMainToTop() {
  const content = $('#content');
  if (content) {
    content.scrollTo({ top: 0, behavior: 'smooth' });
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
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
function getSaveableTabs(tabs) {
  return tabs.filter(
    (t) => t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://')
  );
}

async function closeTabs(tabs, pageUrl) {
  const closeIds = tabs
    .filter((t) => t.id && (!pageUrl || !t.url?.startsWith(pageUrl)))
    .map((t) => t.id)
    .filter(Boolean);

  if (closeIds.length > 0) {
    await chrome.tabs.remove(closeIds);
  }
}


async function saveTabsToCollection(saveable, createdAt) {
  const baseName = formatCollectionName(new Date(createdAt));
  const allCollections = await WhyTabStorage.getCollections();
  const duplicate = allCollections.find((c) => c.autoTitleType === 'timeOfDay' && c.name === baseName);

  if (duplicate && Math.abs(createdAt - (duplicate.createdAt || createdAt)) <= (30 * 60 * 1000)) {
    for (const tab of saveable) {
      await WhyTabStorage.addManualTab(duplicate.id, tab.title || tab.url, tab.url);
    }
    return { name: duplicate.name, merged: true };
  }

  const hasSameName = allCollections.some((c) => c.name === baseName);
  const name = hasSameName ? formatCollectionNameWithTime(new Date(createdAt)) : baseName;
  await WhyTabStorage.addCollection(name, saveable, {
    createdAt,
    autoTitleType: hasSameName ? undefined : 'timeOfDay',
  });
  return { name, merged: false };
}

async function saveAllTabs() {
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const saveable = getSaveableTabs(tabs);
    if (saveable.length === 0) {
      showToast('No saveable tabs');
      return;
    }

    const createdAt = Date.now();
    const result = await saveTabsToCollection(saveable, createdAt);
    console.log(`[WhyTab] Saved ${saveable.length} tabs as "${result.name}"`);
    await loadData();
    render();
    showToast(`Saved ${saveable.length} tab${saveable.length !== 1 ? 's' : ''}`);
  } catch (err) {
    console.error('[WhyTab] saveAllTabs error:', err);
    showToast('Error saving tabs');
  }
}

async function saveAndCloseTabs() {
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const saveable = getSaveableTabs(tabs);
    if (saveable.length === 0) {
      showToast('No saveable tabs');
      return;
    }

    const createdAt = Date.now();
    await saveTabsToCollection(saveable, createdAt);
    const pageUrl = chrome.runtime.getURL('page/tabstash.html');
    await closeTabs(tabs, pageUrl);
    await loadData();
    render();
    showToast(`Saved ${saveable.length} tab${saveable.length !== 1 ? 's' : ''}`);
  } catch (err) {
    console.error('[WhyTab] saveAndCloseTabs error:', err);
    showToast('Error saving tabs');
  }
}

// ── Render ─────────────────────────────────────────────
function render() {
  updateSidebar();
  updateViewHeader();
  updateSearchPlaceholder();
  renderPruneTally();
  $('#search-clear-btn')?.classList.toggle('hidden', !state.searchQuery.trim());

  const content = $('#content');
  const empty = $('#empty-state');
  const filterBar = $('#filter-bar');

  // Search mode
  if (state.searchQuery.trim()) {
    const results = WhyTabStorage.search(state.collections, state.searchQuery, state.searchFilters);
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
    description: 'WhyTab turns your open tabs into saved sessions you can revisit anytime.',
    sub: 'Use the button below or click "Save open tabs" in the sidebar.',
    showDescription: true,
    showCta: true,
  });

  if (state.currentView === 'all') {
    renderAllView(content, empty);
    flushPendingSidebarNavigation();
  } else if (state.currentView === 'saved') {
    renderSavedView(content, empty);
  } else if (state.currentView === 'archived') {
    renderArchivedView(content, empty);
  } else {
    renderCollectionView(content, empty, state.currentView);
  }
}

function renderAllView(content, empty) {
  const activeCollections = state.collections.filter((c) => !c.archived);
  if (activeCollections.length === 0) {
    content.innerHTML = '';
    if (state.pruneMode.active) {
      setEmptyState({
        title: 'All clear',
        sub: '',
        showDescription: false,
        showCta: false,
      });
    }
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  content.innerHTML = '';
  const pinned = activeCollections.filter((c) => c.isPinned);
  const unpinned = activeCollections.filter((c) => !c.isPinned);

  if (pinned.length > 0) {
    content.appendChild(buildCollectionSectionLabel('Pinned'));
    for (const col of pinned) {
      content.appendChild(buildCollectionBlock(col, false, true));
    }
  }

  if (unpinned.length > 0) {
    content.appendChild(buildCollectionSectionLabel('Collections', pinned.length > 0));
    for (const col of unpinned) {
      content.appendChild(buildCollectionBlock(col, false, true));
    }
  }
}


function renderSavedView(content, empty) {
  const savedCollections = getSavedCollections();
  content.innerHTML = '';
  if (!savedCollections.length) {
    setEmptyState({
      title: 'No named collections',
      sub: 'Rename any collection to include it here.',
      showDescription: false,
      showCta: false,
    });
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  content.appendChild(buildCollectionSectionLabel('Named'));
  for (const col of savedCollections) {
    content.appendChild(buildCollectionBlock(col, false, true));
  }
}

function renderArchivedView(content, empty) {
  const archivedCollections = state.collections.filter((c) => c.archived);
  content.innerHTML = '';
  if (!archivedCollections.length) {
    setEmptyState({ title: 'No archived collections', sub: '' });
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  for (const col of archivedCollections) {
    content.appendChild(buildCollectionBlock(col, false, true));
  }
}

function getCollectionIdsByPinned(isPinned) {
  return state.collections
    .filter((c) => Boolean(c.isPinned) === Boolean(isPinned) && !c.archived)
    .map((c) => c.id);
}

async function reorderCollectionsWithinGroup(isPinned, sourceId, targetId) {
  const group = getCollectionIdsByPinned(isPinned);
  const from = group.indexOf(sourceId);
  const to = group.indexOf(targetId);
  if (from === -1 || to === -1 || from === to) return;

  const nextGroup = [...group];
  const [moved] = nextGroup.splice(from, 1);
  nextGroup.splice(to, 0, moved);

  const pinnedIds = isPinned ? nextGroup : getCollectionIdsByPinned(true);
  const unpinnedIds = isPinned ? getCollectionIdsByPinned(false) : nextGroup;
  await WhyTabStorage.reorderCollections([...pinnedIds, ...unpinnedIds]);
  await loadData();
  render();
}

function renderCollectionView(content, empty, colId) {
  const col = state.collections.find((c) => c.id === colId);
  if (!col || col.archived) {
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
  content.appendChild(buildCollectionBlock(col, false, true));
}

function renderSearchResults(content, results) {
  const groups = {};
  for (const r of results) {
    if (!groups[r.collectionId]) {
      const source = state.collections.find((col) => col.id === r.collectionId);
      groups[r.collectionId] = source
        ? { ...source, tabs: [] }
        : { name: r.collectionName, id: r.collectionId, tabs: [], archived: Boolean(r.collectionArchived), isPinned: false, isUserNamed: true };
    }
    groups[r.collectionId].tabs.push(r);
  }
  for (const group of Object.values(groups)) {
    const isReadOnly = !state.pruneMode.active;
    content.appendChild(buildCollectionBlock(group, isReadOnly, true));
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

function buildCollectionSectionLabel(text, withBoundary = false) {
  const div = document.createElement('div');
  div.className = `collection-section${withBoundary ? ' section-boundary' : ''}`;
  div.textContent = text;
  return div;
}

async function expandCollectionIfCollapsed(collectionId) {
  const accordionState = getAccordionState();
  if (!accordionState[collectionId]) return;

  await setAccordionState({
    ...accordionState,
    [collectionId]: false,
  });
}

function flushPendingSidebarNavigation() {
  if (!state.pendingSidebarCollectionId) return;

  const collectionId = state.pendingSidebarCollectionId;
  state.pendingSidebarCollectionId = null;

  const block = document.getElementById(`collection-${collectionId}`);
  if (!block) return;

  const header = block.querySelector('.collection-header');
  block.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' });
  header?.classList.add('highlight');
  setTimeout(() => header?.classList.remove('highlight'), 1000);
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
  div.className = `collection-block${state.pruneMode.active ? ' prune-mode' : ''}`;
  div.dataset.id = col.id;
  div.dataset.pinned = col.isPinned ? '1' : '0';
  div.id = `collection-${col.id}`;

  const activeTabs = (col.tabs || []).filter((tab) => !tab.archived);
  const archivedTabs = (col.tabs || []).filter((tab) => tab.archived);
  const showArchived = Boolean(state.archivedExpanded[col.id]);
  const visibleTabs = readOnly ? (col.tabs || []) : activeTabs;
  const countText = `(${activeTabs.length})`;
  const collectionName = state.pruneMode.active && (col.name || '').length > 50
    ? `${(col.name || '').slice(0, 50).trimEnd()}…`
    : (col.name || '');

  const preciseTimestamp = col.createdAt ? formatPreciseTimestamp(col.createdAt) : '';
  const timestampHtml = collapsible && preciseTimestamp
    ? `<span class="collection-meta" title="${escAttr(preciseTimestamp)}">${escHtml(preciseTimestamp)}</span>`
    : '';

  const nameClass = col.autoTitleType
    ? 'collection-name auto-named'
    : 'collection-name user-named';
  const header = document.createElement('div');
  header.className = `collection-header${collapsible ? '' : ' collection-header--single'}${col.archived ? ' is-archived' : ''}${state.pruneMode.active ? ' prune-active' : ''}`;
  const isArchivedView = state.currentView === 'archived';

  const archivedToggleMenuItem = archivedTabs.length > 0
    ? `<button class="inline-menu-item toggle-archived-tabs-btn">${showArchived ? 'Hide archived' : 'Show archived'}</button>`
    : '';
  const pinIcon = `<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M3.5 1.5H9.5V11.5L6.5 9L3.5 11.5V1.5Z" stroke="currentColor" stroke-width="1.1" fill="${col.isPinned ? 'currentColor' : 'none'}" stroke-linejoin="round"/></svg>`;
  const archiveIcon = col.archived
    ? '<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M2 4.5H11V11H2V4.5Z" stroke="currentColor" stroke-width="1.1"/><path d="M1.5 2H11.5V4.5H1.5V2Z" stroke="currentColor" stroke-width="1.1"/><path d="M6.5 9V5.5M6.5 5.5L4.8 7.2M6.5 5.5L8.2 7.2" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    : '<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M2 4.5H11V11H2V4.5Z" stroke="currentColor" stroke-width="1.1"/><path d="M1.5 2H11.5V4.5H1.5V2Z" stroke="currentColor" stroke-width="1.1"/><path d="M6.5 5V8.5M6.5 8.5L4.8 6.8M6.5 8.5L8.2 6.8" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  const primaryActions = [];
  const menuActions = [archivedToggleMenuItem].filter(Boolean);

  if (!readOnly) {
    primaryActions.push(`
      <button class="icon-btn restore-all-btn" title="Restore all">
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M2 6.5H10.5M10.5 6.5L7 3M10.5 6.5L7 10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    `);
    primaryActions.push(`
      <button class="icon-btn rename-btn" title="Rename">
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M9.5 2L11 3.5L4.5 10H3V8.5L9.5 2Z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/></svg>
      </button>
    `);

    if (col.isPinned) {
      primaryActions.push(`<button class="icon-btn pin-btn" title="Unpin">${pinIcon}</button>`);
      menuActions.push(`<button class="inline-menu-item archive-col-btn">${col.archived ? 'Unarchive' : 'Archive'}</button>`);
    } else if (col.isUserNamed) {
      primaryActions.push(`<button class="icon-btn pin-btn" title="Pin">${pinIcon}</button>`);
      menuActions.push(`<button class="inline-menu-item archive-col-btn">${col.archived ? 'Unarchive' : 'Archive'}</button>`);
    } else {
      primaryActions.push(`<button class="icon-btn archive-col-btn" title="${col.archived ? 'Unarchive' : 'Archive'}">${archiveIcon}</button>`);
      menuActions.push('<button class="inline-menu-item pin-btn">Pin</button>');
    }

    menuActions.push('<button class="inline-menu-item delete-col-btn">Delete collection</button>');
  }

  const collectionMenu = readOnly
    ? ''
    : `<details class="inline-menu col-menu"><summary class="icon-btn menu-btn" title="More"><svg width="13" height="13" viewBox="0 0 13 13" fill="none"><circle cx="2.5" cy="6.5" r="1" fill="currentColor"/><circle cx="6.5" cy="6.5" r="1" fill="currentColor"/><circle cx="10.5" cy="6.5" r="1" fill="currentColor"/></svg></summary><div class="inline-menu-panel">${menuActions.join('')}</div></details>`;

  const archivedNameLabel = readOnly && col.archived ? '<span class="archived-search-label">(archived)</span>' : '';
  const pruneMetaHtml = state.pruneMode.active && !readOnly
    ? `<span class="collection-activity" title="${escAttr(formatRelativeActivity(col.lastInteractedAt))}">${escHtml(formatRelativeActivity(col.lastInteractedAt))}${shouldShowUntouchedHint(col) ? '<span class="collection-untouched">Untouched</span>' : ''}</span>`
    : '';

  header.innerHTML = `
    ${collapsible ? `<span class="collapse-icon" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4 2.5L8 6L4 9.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></span>` : '<span class="collapse-icon placeholder"></span>'}
    <div class="collection-main">
      <span class="${nameClass}">${escHtml(collectionName)}</span>${archivedNameLabel}
      <span class="collection-tab-count">${countText}</span>
      ${pruneMetaHtml}
    </div>
    <div class="collection-right">
      ${timestampHtml}
      ${readOnly ? '' : `
      <div class="col-actions${state.pruneMode.active && !col.isPinned ? ' persistent' : ''}">
        ${primaryActions.join('')}
        ${collectionMenu}
      </div>`}
    </div>
  `;

  if (collapsible) {
    const accordionState = getAccordionState();
    if (accordionState[col.id]) {
      div.classList.add('collapsed');
    }

    header.addEventListener('click', async (e) => {
      if (e.target.closest('.col-actions') || e.target.closest('.inline-menu')) return;
      div.classList.toggle('collapsed');
      await setAccordionState({
        ...getAccordionState(),
        [col.id]: div.classList.contains('collapsed'),
      });
    });
  }

  if (!readOnly && collapsible && state.currentView === 'all' && !state.pruneMode.active) {
    header.draggable = true;
    header.classList.add('draggable-collection');
    header.addEventListener('dragstart', (e) => {
      dragState.type = 'collection';
      dragState.collectionId = col.id;
      dragState.collectionPinned = Boolean(col.isPinned);
      dragState.source = 'main';
      div.classList.add('is-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', col.id);
    });
    header.addEventListener('dragend', () => {
      dragState.type = null;
      dragState.collectionId = null;
      dragState.collectionPinned = null;
      dragState.source = null;
      $$('.collection-block').forEach((el) => el.classList.remove('is-dragging', 'drag-target'));
    });
    header.addEventListener('dragover', (e) => {
      if (dragState.type === 'collection') {
        if (!dragState.collectionId || dragState.collectionPinned !== Boolean(col.isPinned)) return;
        if (dragState.collectionId === col.id) return;
        e.preventDefault();
        div.classList.add('drag-target');
      }
      if (dragState.type === 'tab') {
        e.preventDefault();
        div.classList.add('drag-target');
      }
    });
    header.addEventListener('dragleave', () => {
      div.classList.remove('drag-target');
    });
    header.addEventListener('drop', async (e) => {
      e.preventDefault();
      div.classList.remove('drag-target');
      if (dragState.type === 'collection') {
        if (!dragState.collectionId || dragState.collectionId === col.id) return;
        await reorderCollectionsWithinGroup(Boolean(col.isPinned), dragState.collectionId, col.id);
      }
      if (dragState.type === 'tab') {
        clearTabDropIndicator();
        await moveDraggedTabToCollection(col.id);
      }
    });
  }

  bindCollectionActions(header, col, activeTabs, div);
  div.appendChild(header);

  const body = document.createElement('div');
  body.className = 'collection-body';

  if (!readOnly) {
    body.addEventListener('dragover', (e) => {
      if (dragState.type !== 'tab' || !dragState.tabId || div.classList.contains('collapsed')) return;
      e.preventDefault();
      e.stopPropagation();
      const dropIndex = getDropIndexInCollectionBody(body, e.clientY);
      updateTabDropIndicator(col.id, body, dropIndex);
    });
    body.addEventListener('drop', async (e) => {
      if (dragState.type !== 'tab' || !dragState.tabId) return;
      e.preventDefault();
      e.stopPropagation();
      const dropIndex = getDropIndexInCollectionBody(body, e.clientY);
      clearTabDropIndicator();
      await moveDraggedTabToCollection(col.id, dropIndex);
    });
  }

  if (!readOnly && activeTabs.length === 0 && archivedTabs.length > 0) {
    const emptyArchived = document.createElement('div');
    emptyArchived.className = 'collection-empty-archived';
    if (state.pruneMode.active) {
      emptyArchived.innerHTML = `All tabs archived — <button type="button" class="empty-archive-collection-btn">Archive collection</button>?`;
      emptyArchived.querySelector('.empty-archive-collection-btn')?.addEventListener('click', async (event) => {
        event.stopPropagation();
        await archiveCollectionWithUndo(col.id, true);
      });
    } else {
      emptyArchived.textContent = 'All tabs archived';
    }
    body.appendChild(emptyArchived);
  }

  for (const tab of visibleTabs) {
    body.appendChild(buildTabRow(tab, col.id, { inSearch: readOnly }));
  }

  if (!readOnly && archivedTabs.length > 0 && showArchived) {
    archivedTabs.forEach((tab, index) => {
      const row = buildTabRow(tab, col.id, { archived: true });
      if (index === 0) {
        row.classList.add('tab-row-archived-start');
      }
      body.appendChild(row);
    });
  }

  if (!collapsible && !readOnly && !isArchivedView) {
    body.appendChild(buildAddTabForm(col.id));
  }

  div.appendChild(body);
  return div;
}

function bindCollectionActions(header, col, activeTabs, blockEl) {
  header.querySelector('.toggle-archived-tabs-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    state.archivedExpanded[col.id] = !state.archivedExpanded[col.id];
    render();
  });

  header.querySelector('.restore-all-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    for (const t of activeTabs) {
      chrome.tabs.create({ url: t.url, active: false }).catch((err) => {
        console.warn('[WhyTab] Error opening tab:', err);
      });
    }
    WhyTabStorage.logAction('open', { collectionId: col.id, tabCount: activeTabs.length });
    WhyTabStorage.markCollectionInteracted(col.id);
    showToast(`Opened ${activeTabs.length} tab${activeTabs.length !== 1 ? 's' : ''}`);
  });

  header.querySelector('.rename-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    startInlineRename(blockEl, col);
  });

  header.querySelector('.pin-btn')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await WhyTabStorage.togglePin(col.id);
      await loadData();
      render();
    } catch (err) {
      console.error('[WhyTab] togglePin error:', err);
    }
  });

  header.querySelector('.archive-col-btn')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (col.archived) {
      await WhyTabStorage.setCollectionArchived(col.id, false);
      await loadData();
      if (state.currentView === 'archived') {
        render();
      } else {
        state.currentView = 'all';
        render();
      }
      return;
    }
    await archiveCollectionWithUndo(col.id, true);
  });

  header.querySelector('.delete-col-btn')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    await deleteCollectionWithUndo(col.id);
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
      await WhyTabStorage.addManualTab(collectionId, title || finalUrl, finalUrl);
      console.log(`[WhyTab] Added manual tab: ${finalUrl}`);
      fields.querySelector('[data-field="title"]').value = '';
      fields.querySelector('[data-field="url"]').value = '';
      fields.classList.add('hidden');
      toggle.classList.remove('hidden');
      await loadData();
      render();
    } catch (err) {
      console.error('[WhyTab] addManualTab error:', err);
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
function buildTabRow(tab, collectionId, options = {}) {
  const { archived = Boolean(tab.archived), inSearch = false } = options;
  const row = document.createElement('div');
  row.className = `tab-row${archived || tab.collectionArchived ? ' tab-row-archived' : ''}${state.pruneMode.active ? ' prune-active' : ''}`;
  row.dataset.id = tab.id;
  row.draggable = !inSearch && !state.pruneMode.active;

  const tags = tab.tags || [];

  const icon = faviconUrl(tab.url);
  const favicon = icon
    ? `<img class="tab-favicon" src="${escAttr(icon)}" alt="" loading="lazy">`
    : '<div class="tab-favicon-placeholder"></div>';

  const tagHtml = tags.map((t) =>
    `<span class="tag-chip" data-tag="${escAttr(t)}">${escHtml(t)}<button class="tag-remove" title="Remove tag">×</button></span>`
  ).join('');

  const showDate = shouldShowTimestamp(tab.savedAt);
  const tabActivityText = state.pruneMode.active ? formatRelativeActivity(tab.lastAccessedAt ?? null) : '';
  const archiveTitle = archived ? 'Unarchive' : 'Archive';
  const archiveIcon = archived
    ? '<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M6.5 10.5V4.2M6.5 4.2L4.5 6.2M6.5 4.2L8.5 6.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 2.5H11V10.5H2V2.5Z" stroke="currentColor" stroke-width="1.1"/></svg>'
    : '<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M6.5 2.5V8.8M6.5 8.8L4.5 6.8M6.5 8.8L8.5 6.8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 2.5H11V10.5H2V2.5Z" stroke="currentColor" stroke-width="1.1"/></svg>';
  const archivedLabel = (archived || tab.collectionArchived) ? '<span class="archived-search-label">(archived)</span>' : '';

  row.innerHTML = `
    ${inSearch ? '' : `<span class="tab-drag-handle" aria-hidden="true" title="Drag tab">
      <svg width="10" height="14" viewBox="0 0 10 14" fill="none">
        <circle cx="2" cy="2" r="1" fill="currentColor"/><circle cx="8" cy="2" r="1" fill="currentColor"/>
        <circle cx="2" cy="7" r="1" fill="currentColor"/><circle cx="8" cy="7" r="1" fill="currentColor"/>
        <circle cx="2" cy="12" r="1" fill="currentColor"/><circle cx="8" cy="12" r="1" fill="currentColor"/>
      </svg>
    </span>`}
    ${favicon}
    <div class="tab-info">
      <div class="tab-title-row">
        <span class="tab-title" data-url="${escAttr(tab.url)}">${escHtml(tab.title)}</span>
        ${inSearch ? archivedLabel : ''}
        <div class="tag-container">
          ${tagHtml}
          <button class="tag-add-btn" title="Add tag">+</button>
        </div>
      </div>
      ${state.settings.showItemUrls ? `<div class="tab-url">${escHtml(tab.url)}</div>` : ''}
    </div>
    <div class="tab-meta">
      ${state.pruneMode.active ? `<span class="tab-activity">${escHtml(tabActivityText)}</span>` : ''}
      ${showDate ? `<span class="tab-date">${relativeDate(tab.savedAt)}</span>` : ''}
    </div>
    <div class="tab-actions${state.pruneMode.active ? ' persistent' : ''}">
      <button class="icon-btn open-btn" title="Open">
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M2 6.5H10.5M10.5 6.5L7 3M10.5 6.5L7 10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <button class="icon-btn edit-btn" title="Edit">
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M9.5 2L11 3.5L4.5 10H3V8.5L9.5 2Z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/></svg>
      </button>
      <button class="icon-btn archive-tab-btn" title="${archiveTitle}">${archiveIcon}</button>
      <details class="inline-menu tab-menu"><summary class="icon-btn menu-btn" title="More"><svg width="13" height="13" viewBox="0 0 13 13" fill="none"><circle cx="2.5" cy="6.5" r="1" fill="currentColor"/><circle cx="6.5" cy="6.5" r="1" fill="currentColor"/><circle cx="10.5" cy="6.5" r="1" fill="currentColor"/></svg></summary><div class="inline-menu-panel"><button class="inline-menu-item move-tab-btn">Move to collection</button><button class="inline-menu-item del-tab-btn">Delete</button></div></details>
    </div>
  `;

  if (!inSearch && !state.pruneMode.active) {
    row.draggable = true;

    row.addEventListener('dragstart', (e) => {
      dragState.type = 'tab';
      dragState.tabId = tab.id;
      dragState.tabCollectionId = collectionId;
      dragState.tabSourceRow = row;
      dragState.suppressTabClickId = tab.id;
      row.classList.add('is-dragging');
      const faviconSrc = row.querySelector('.tab-favicon')?.getAttribute('src') || '';
      const ghost = createTabDragPreview(tab.title, faviconSrc);
      dragState.tabDragImage = ghost;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', tab.id);
      e.dataTransfer.setDragImage(ghost, 16, 16);
    });
    row.addEventListener('dragend', () => {
      resetTabDragState();
      setTimeout(() => {
        dragState.suppressTabClickId = null;
      }, 0);
    });
  }

  row.querySelector('.tab-title').addEventListener('click', () => {
    if (dragState.suppressTabClickId === tab.id) return;
    chrome.tabs.create({ url: tab.url }).catch((err) => console.warn('[WhyTab] open error:', err));
    WhyTabStorage.logAction('open', { tabId: tab.id });
    WhyTabStorage.markCollectionInteracted(collectionId);
  });
  bindUrlTooltip(row.querySelector('.tab-title'));
  row.querySelector('.open-btn').addEventListener('click', () => {
    if (dragState.suppressTabClickId === tab.id) return;
    chrome.tabs.create({ url: tab.url }).catch((err) => console.warn('[WhyTab] open error:', err));
    WhyTabStorage.logAction('open', { tabId: tab.id });
    WhyTabStorage.markCollectionInteracted(collectionId);
  });

  row.querySelector('.archive-tab-btn').addEventListener('click', async () => {
    try {
      await archiveTabWithUndo(tab.id, !archived);
    } catch (err) {
      console.error('[WhyTab] archive tab error:', err);
    }
  });

  if (inSearch) {
    row.querySelector('.edit-btn')?.remove();
    row.querySelector('.archive-tab-btn')?.remove();
    row.querySelector('.tab-menu')?.remove();
    row.querySelector('.tag-container')?.classList.add('hidden');
    return row;
  }

  row.querySelector('.edit-btn').addEventListener('click', () => startInlineTabEdit(row, tab, 'title'));

  row.querySelector('.del-tab-btn').addEventListener('click', async () => {
    try {
      await deleteTabWithUndo(tab.id);
    } catch (err) {
      console.error('[WhyTab] removeTab error:', err);
    }
  });

  row.querySelector('.move-tab-btn').addEventListener('click', () => {
    openMoveModal(tab.id, collectionId);
  });

  row.querySelectorAll('.tag-remove').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const tagName = btn.closest('.tag-chip').dataset.tag;
      try {
        await WhyTabStorage.removeTag(tab.id, tagName);
        await loadData();
        render();
      } catch (err) {
        console.error('[WhyTab] removeTag error:', err);
      }
    });
  });

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
          await WhyTabStorage.addTag(tab.id, val);
          await loadData();
        } catch (err) {
          console.error('[WhyTab] addTag error:', err);
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

async function startInlineTabEdit(row, tab, field) {
  await flushInlineEdit();

  const target = field === 'title' ? row.querySelector('.tab-title') : row.querySelector('.tab-url');
  let mountPoint = target;
  if (!mountPoint && field === 'url') {
    mountPoint = document.createElement('div');
    mountPoint.className = 'tab-url tab-url-edit-slot';
    row.querySelector('.tab-info')?.appendChild(mountPoint);
  }
  if (!mountPoint) return;

  const originalValue = field === 'title' ? (tab.title || '') : (tab.url || '');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = `tab-inline-input ${field === 'title' ? 'tab-inline-input-title' : 'tab-inline-input-url'}`;
  input.value = originalValue;
  input.setAttribute('aria-label', field === 'title' ? 'Edit title' : 'Edit URL');

  mountPoint.replaceWith(input);
  input.focus();
  input.select();

  let finished = false;
  const finish = async ({ save }) => {
    if (finished) return;
    finished = true;
    inlineEditSession = null;

    const nextRaw = input.value;
    let nextVal = nextRaw;
    if (field === 'url') {
      const trimmed = nextRaw.trim();
      if (!trimmed) {
        showToast('URL required');
        save = false;
      }
      nextVal = trimmed.match(/^https?:\/\//) ? trimmed : `https://${trimmed}`;
    }

    if (save) {
      try {
        if (field === 'title' && nextRaw.trim() !== originalValue.trim()) {
          await WhyTabStorage.updateTab(tab.id, { title: nextRaw.trim() || tab.url });
          await loadData();
        }
        if (field === 'url' && nextVal !== originalValue) {
          await WhyTabStorage.updateTab(tab.id, {
            url: nextVal,
            title: tab.title?.trim() || nextVal,
          });
          await loadData();
        }
      } catch (err) {
        console.error('[WhyTab] inline updateTab error:', err);
        showToast('Error updating tab');
      }
    }

    render();
  };

  inlineEditSession = {
    save: () => finish({ save: true }),
    cancel: () => finish({ save: false }),
  };

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      finish({ save: true });
    }
    if (ev.key === 'Escape') {
      ev.preventDefault();
      finish({ save: false });
    }
  });
  input.addEventListener('blur', () => finish({ save: true }));
}

async function flushInlineEdit() {
  if (!inlineEditSession) return;
  await inlineEditSession.save();
}

function openInlineInputModal({ title, placeholder, confirmLabel, initialValue = '' }) {
  closeInlineInputModal();
  const modal = $('#inline-input-modal');
  const titleEl = $('#inline-input-modal-title');
  const inputEl = $('#inline-input-modal-input');
  const confirmEl = $('#inline-input-modal-confirm');
  titleEl.textContent = title;
  inputEl.placeholder = placeholder || '';
  confirmEl.textContent = confirmLabel || 'Create';
  inputEl.value = initialValue;
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  setTimeout(() => inputEl.focus(), 0);
  inputEl.select();

  return new Promise((resolve) => {
    inlineInputModalSession = { resolve };
  });
}

function submitInlineInputModal() {
  if (!inlineInputModalSession) return;
  const value = $('#inline-input-modal-input').value;
  const { resolve } = inlineInputModalSession;
  inlineInputModalSession = null;
  $('#inline-input-modal').classList.add('hidden');
  $('#inline-input-modal').setAttribute('aria-hidden', 'true');
  resolve(value);
}

function closeInlineInputModal() {
  if (!inlineInputModalSession) {
    $('#inline-input-modal').classList.add('hidden');
    $('#inline-input-modal').setAttribute('aria-hidden', 'true');
    return;
  }
  const { resolve } = inlineInputModalSession;
  inlineInputModalSession = null;
  $('#inline-input-modal').classList.add('hidden');
  $('#inline-input-modal').setAttribute('aria-hidden', 'true');
  resolve(null);
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
  const systemList = $('#sidebar-system');
  if (systemList) {
    systemList.innerHTML = '';
    const savedBtn = document.createElement('button');
    savedBtn.className = 'nav-item nav-item-muted nav-item-archived';
    savedBtn.dataset.view = 'saved';
    savedBtn.textContent = 'Named';
    savedBtn.classList.toggle('active', state.currentView === 'saved');
    savedBtn.addEventListener('click', () => {
      state.currentView = 'saved';
      state.searchQuery = '';
      $('#search').value = '';
      render();
    });
    systemList.appendChild(savedBtn);
  }

  const pinned = state.collections.filter((c) => c.isPinned && !c.archived);
  const unpinned = state.collections.filter((c) => !c.isPinned && !c.archived);
  const addSidebarSection = (labelText, items, emptyText) => {
    const label = document.createElement('div');
    label.className = 'sidebar-section-label';
    label.textContent = labelText;
    list.appendChild(label);

    if (items.length > 0) {
      items.forEach((col, index) => {
        list.appendChild(buildSidebarItem(col, {
          dayBoundary: false,
          sectionStart: index === 0,
        }));
      });
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
    label.className = 'sidebar-section-label sidebar-section-label--collections';
    label.textContent = 'Collections';
    list.appendChild(label);

    unpinned.forEach((col, index) => {
      list.appendChild(buildSidebarItem(col, {
        dayBoundary: false,
        sectionStart: index === 0,
      }));
    });
  }

}

function buildSidebarItem(col, { dayBoundary = false, sectionStart = false } = {}) {
  const btn = document.createElement('button');
  const isPinned = Boolean(col.isPinned);
  btn.className = `sidebar-col-item sidebar-col-item--${isPinned ? 'pinned' : 'standard'}${dayBoundary ? ' day-boundary' : ''}${sectionStart ? ' section-start' : ''}${state.currentView === col.id ? ' active' : ''}`;

  const pinSvg = isPinned
    ? '<svg class="sidebar-pin-icon" width="11" height="11" viewBox="0 0 13 13" fill="none"><path d="M3.5 1.5H9.5V11.5L6.5 9L3.5 11.5V1.5Z" stroke="currentColor" stroke-width="1.1" fill="currentColor" stroke-linejoin="round"/></svg>'
    : '';

  const activeCount = Array.isArray(col.tabs)
    ? col.tabs.filter((tab) => !tab.archived).length
    : 0;
  const countBadge = activeCount > 0
    ? `<span class="sidebar-col-count${isPinned ? ' sidebar-col-count--pinned' : ''}">(${activeCount})</span>`
    : '';

  // Hover actions: pin toggle + delete
  const hoverPinIcon = isPinned
    ? '<svg width="11" height="11" viewBox="0 0 13 13" fill="none"><path d="M3.5 1.5H9.5V11.5L6.5 9L3.5 11.5V1.5Z" stroke="currentColor" stroke-width="1.1" fill="currentColor" stroke-linejoin="round"/></svg>'
    : '<svg width="11" height="11" viewBox="0 0 13 13" fill="none"><path d="M3.5 1.5H9.5V11.5L6.5 9L3.5 11.5V1.5Z" stroke="currentColor" stroke-width="1.1" fill="none" stroke-linejoin="round"/></svg>';

  btn.innerHTML = `
    ${pinSvg}
    <span class="sidebar-col-name ${col.autoTitleType ? 'auto-named' : 'user-named'}">${escHtml(col.name)}</span>
    ${countBadge}
    <span class="sidebar-col-actions">
      <button class="sidebar-hover-pin${isPinned ? ' sidebar-hover-pin-active' : ''}" title="${isPinned ? 'Unpin' : 'Pin'}">${hoverPinIcon}</button>

    </span>
  `;

  btn.draggable = true;
  btn.dataset.id = col.id;
  btn.dataset.pinned = isPinned ? '1' : '0';
  btn.addEventListener('dragstart', (e) => {
    dragState.type = 'collection';
    dragState.collectionId = col.id;
    dragState.collectionPinned = isPinned;
    dragState.source = 'sidebar';
    btn.classList.add('is-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', col.id);
  });
  btn.addEventListener('dragend', () => {
    dragState.type = null;
    dragState.collectionId = null;
    dragState.collectionPinned = null;
    dragState.source = null;
    $$('.sidebar-col-item').forEach((el) => el.classList.remove('is-dragging', 'drag-target'));
  });
  btn.addEventListener('dragover', (e) => {
    if (dragState.type === 'collection') {
      if (!dragState.collectionId || dragState.collectionPinned !== isPinned) return;
      if (dragState.collectionId === col.id) return;
      e.preventDefault();
      btn.classList.add('drag-target');
    }
    if (dragState.type === 'tab') {
      e.preventDefault();
      btn.classList.add('drag-target');
    }
  });
  btn.addEventListener('dragleave', () => {
    btn.classList.remove('drag-target');
  });
  btn.addEventListener('drop', async (e) => {
    e.preventDefault();
    btn.classList.remove('drag-target');
    if (dragState.type === 'collection') {
      if (!dragState.collectionId || dragState.collectionId === col.id) return;
      await reorderCollectionsWithinGroup(isPinned, dragState.collectionId, col.id);
    }
    if (dragState.type === 'tab') {
      await moveDraggedTabToCollection(col.id);
    }
  });

  btn.addEventListener('click', async (e) => {
    if (e.target.closest('.sidebar-col-actions')) return;
    state.currentView = 'all';
    state.searchQuery = '';
    $('#search').value = '';
    await expandCollectionIfCollapsed(col.id);
    state.pendingSidebarCollectionId = col.id;
    render();
  });

  // Pin toggle
  btn.querySelector('.sidebar-hover-pin')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await WhyTabStorage.togglePin(col.id);
      await loadData();
      render();
    } catch (err) {
      console.error('[WhyTab] togglePin error:', err);
    }
  });


  return btn;
}

function updateViewHeader() {
  const viewHeader = $('.view-header');
  const title = $('#view-title');
  const count = $('#view-count');
  const actions = $('#view-actions');
  const sortControl = $('#collection-sort-menu');
  const sortDivider = $('#collection-sort-divider');
  const pruneDivider = $('#prune-divider');
  const pruneBtn = $('#prune-mode-btn');
  const isAllView = state.currentView === 'all' && !state.searchQuery.trim();
  const showSortControl = isAllView && Boolean(state.settings.showSortControl) && !state.pruneMode.active;
  const showPruneButton = state.currentView === 'all' && (!state.searchQuery.trim() || state.pruneMode.active);

  sortControl?.classList.toggle('hidden', !showSortControl);
  sortDivider?.classList.toggle('hidden', !showSortControl);
  pruneBtn?.classList.toggle('hidden', !showPruneButton);
  pruneDivider?.classList.toggle('hidden', !showPruneButton);
  pruneBtn?.classList.toggle('active', state.pruneMode.active);
  if (pruneBtn) pruneBtn.textContent = state.pruneMode.active ? 'Done' : 'Prune';
  renderSortControl();

  if (state.searchQuery.trim()) {
    viewHeader.classList.remove('hidden');
    title.textContent = 'Search';
    count.innerHTML = '';
    actions.classList.toggle('hidden', state.collections.length === 0);
    return;
  }

  if (state.currentView === 'all') {
    viewHeader.classList.remove('hidden');
    const total = state.collections
      .filter((c) => !c.archived)
      .reduce((s, c) => s + c.tabs.filter((tab) => !tab.archived).length, 0);
    title.textContent = 'All Tabs';
    count.textContent = total ? `(${total})` : '';
    actions.classList.toggle('hidden', state.collections.length === 0);
  } else if (state.currentView === 'saved') {
    viewHeader.classList.remove('hidden');
    const savedCount = getSavedCollections().length;
    title.textContent = 'Named';
    count.textContent = savedCount ? `(${savedCount})` : '';
    actions.classList.toggle('hidden', state.collections.length === 0);
  } else if (state.currentView === 'archived') {
    viewHeader.classList.remove('hidden');
    const totalArchived = state.collections.filter((c) => c.archived).length;
    title.textContent = 'Archived';
    count.textContent = totalArchived ? `(${totalArchived})` : '';
    actions.classList.toggle('hidden', true);
  } else {
    viewHeader.classList.add('hidden');
    const col = state.collections.find((c) => c.id === state.currentView);
    if (col) {
      const n = col.tabs.length;
      title.textContent = col.name;
      count.textContent = n ? `(${n})` : '';
    } else {
      title.textContent = 'Not found';
      count.innerHTML = '';
    }
    actions.classList.toggle('hidden', state.collections.length === 0);
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
    const v = input.value.trim();
    if (v && v !== current) {
      try {
        await WhyTabStorage.renameCollection(col.id, v);
        await loadData();
      } catch (err) {
        console.error('[WhyTab] rename error:', err);
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
    if (col.id === sourceColId || col.archived) continue;
    const item = document.createElement('div');
    item.className = 'move-item';
    item.textContent = col.name;
    item.addEventListener('click', async () => {
      try {
        await WhyTabStorage.moveTab(tabId, col.id);
        closeMoveModal();
        await loadData();
        render();
        showToast(`Moved to ${col.name}`);
      } catch (err) {
        console.error('[WhyTab] moveTab error:', err);
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

  const showUrlsEl = $('#setting-show-item-urls');
  showUrlsEl.checked = Boolean(s.showItemUrls);

  const contextualTitlesEl = $('#setting-contextual-auto-titles');
  contextualTitlesEl.checked = Boolean(s.useContextualAutoTitles);

  const showSortControlEl = $('#setting-show-sort-control');
  showSortControlEl.checked = Boolean(s.showSortControl);

  const autoArchiveEl = $('#setting-auto-archive-inactive');
  autoArchiveEl.checked = s.autoArchiveInactiveSessions !== false;

  replaceWithClone('#setting-show-item-urls', async (el) => {
    try {
      await WhyTabStorage.saveSettings({ ...state.settings, showItemUrls: el.checked });
      state.settings = await WhyTabStorage.getSettings();
      render();
      showToast('Saved');
    } catch (err) {
      console.error('[WhyTab] save settings error:', err);
    }
  }, 'change');

  replaceWithClone('#setting-contextual-auto-titles', async (el) => {
    try {
      await WhyTabStorage.saveSettings({ ...state.settings, useContextualAutoTitles: el.checked });
      state.settings = await WhyTabStorage.getSettings();
      showToast('Saved');
    } catch (err) {
      console.error('[WhyTab] save settings error:', err);
    }
  }, 'change');

  replaceWithClone('#setting-show-sort-control', async (el) => {
    try {
      await WhyTabStorage.saveSettings({ ...state.settings, showSortControl: el.checked });
      state.settings = await WhyTabStorage.getSettings();
      render();
      showToast('Saved');
    } catch (err) {
      console.error('[WhyTab] save settings error:', err);
    }
  }, 'change');


  replaceWithClone('#setting-auto-archive-inactive', async (el) => {
    try {
      await WhyTabStorage.saveSettings({ ...state.settings, autoArchiveInactiveSessions: el.checked });
      state.settings = await WhyTabStorage.getSettings();
      if (state.settings.autoArchiveInactiveSessions) {
        await WhyTabStorage.autoArchiveInactiveSessions();
        await loadData();
      }
      render();
      showToast('Saved');
    } catch (err) {
      console.error('[WhyTab] save settings error:', err);
    }
  }, 'change');

  replaceWithClone('#setting-export-btn', async () => {
    try {
      const data = await WhyTabStorage.getAll();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `tabstash-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('Exported');
    } catch (err) {
      console.error('[WhyTab] export error:', err);
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
  { label: 'Save & close tabs', action: () => saveAndCloseTabs() },
  { label: 'View all tabs', action: () => { state.currentView = 'all'; render(); }},
  { label: 'New collection', action: async () => {
    const name = await openInlineInputModal({
      title: 'New collection',
      placeholder: 'Collection name',
      confirmLabel: 'Create',
    });
    if (name?.trim()) {
      const col = await WhyTabStorage.addCollection(name.trim(), [], { isUserNamed: true });
      await loadData(); state.currentView = col.id; render();
    }
  }},
  { label: 'Open settings', action: () => openSettings() },
  { label: 'Export data', action: async () => {
    const data = await WhyTabStorage.getAll();
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
    console.error('[WhyTab] load recent searches error:', err);
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
    console.error('[WhyTab] save recent searches error:', err);
  }
  updateSearchPanel();
}

async function removeRecentSearch(query) {
  const next = state.recentSearches.filter((q) => q !== query);
  state.recentSearches = next;
  try {
    await chrome.storage.local.set({ [RECENT_SEARCHES_KEY]: next });
  } catch (err) {
    console.error('[WhyTab] remove recent search error:', err);
  }
  updateSearchPanel();
}

async function clearRecentSearches() {
  state.recentSearches = [];
  try {
    await chrome.storage.local.set({ [RECENT_SEARCHES_KEY]: [] });
  } catch (err) {
    console.error('[WhyTab] clear recent searches error:', err);
  }
  updateSearchPanel();
}

function openSearchPanel() {
  loadRecentSearches().then(() => updateSearchPanel());
  $('#search-panel').classList.remove('hidden');
  $('.search-bar').classList.add('is-focused');
  setSearchFocusState(true);
}

function closeSearchPanel() {
  $('#search-panel').classList.add('hidden');
  $('.search-bar').classList.remove('is-focused');
  setSearchFocusState(false);
}

function setSearchFocusState(isFocused) {
  $('.app')?.classList.toggle('search-focused', isFocused);
}

function updateSearchPanel() {
  renderRecentSearches();
  updateFilterChips();
}


let urlTooltipTimer = null;
let urlTooltipEl = null;

function bindUrlTooltip(titleEl) {
  if (!titleEl) return;

  titleEl.addEventListener('mouseenter', () => {
    clearTimeout(urlTooltipTimer);
    urlTooltipTimer = setTimeout(() => {
      showUrlTooltip(titleEl);
    }, 300);
  });

  titleEl.addEventListener('mouseleave', () => {
    clearTimeout(urlTooltipTimer);
    hideUrlTooltip();
  });
}

function showUrlTooltip(el) {
  const url = el.dataset.url;
  if (!url) return;
  if (!urlTooltipEl) {
    urlTooltipEl = document.createElement('div');
    urlTooltipEl.className = 'url-tooltip';
    document.body.appendChild(urlTooltipEl);
  }

  urlTooltipEl.textContent = url;
  const rect = el.getBoundingClientRect();
  urlTooltipEl.style.left = `${rect.left}px`;
  urlTooltipEl.style.top = `${rect.bottom + 6}px`;
  urlTooltipEl.classList.add('visible');
}

function hideUrlTooltip() {
  if (urlTooltipEl) {
    urlTooltipEl.classList.remove('visible');
  }
}

function updateSearchPlaceholder() {
  const input = $('#search');
  if (!input) return;
  const total = state.collections
    .filter((col) => !col.archived)
    .reduce((sum, col) => sum + col.tabs.filter((tab) => !tab.archived).length, 0);
  input.placeholder = state.pruneMode.active
    ? `Pruning ${total} tabs...`
    : `Search ${total} tabs...`;
}

function animatePruneTally() {
  const tally = $('#prune-tally');
  if (!tally) return;
  tally.classList.remove('tick');
  tally.offsetHeight;
  tally.classList.add('tick');
}

function renderPruneTally() {
  const tally = $('#prune-tally');
  if (!tally) return;

  tally.textContent = `${state.pruneMode.archivedCount} archived · ${state.pruneMode.deletedCount} deleted`;
  const shouldShow = state.pruneMode.active || Date.now() < state.pruneMode.exitDisplayUntil;
  tally.classList.toggle('hidden', !shouldShow);
  tally.classList.toggle('fade-out', !state.pruneMode.active && shouldShow);
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
      hint: `${c.tabs.length} tabs`,
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



async function archiveTabWithUndo(tabId, archive = true) {
  const snapshot = await WhyTabStorage.getAll();
  const hasTab = snapshot.collections.some((col) => col.tabs.some((tab) => tab.id === tabId));
  if (!hasTab) return;

  await WhyTabStorage.setTabArchived(tabId, archive);
  await loadData();
  render();
  if (archive) incrementPruneTally('archived');

  showToast(`Tab ${archive ? 'archived' : 'restored'}`, {
    actionLabel: 'Undo',
    duration: 4000,
    onAction: async () => {
      await WhyTabStorage.replaceState(snapshot.collections, snapshot.urlIndex);
      await loadData();
      render();
    },
  });
}

async function deleteTabWithUndo(tabId) {
  const snapshot = await WhyTabStorage.getAll();
  const hasTab = snapshot.collections.some((col) => col.tabs.some((tab) => tab.id === tabId));
  if (!hasTab) return;

  await WhyTabStorage.removeTab(tabId);
  await loadData();
  render();
  incrementPruneTally('deleted');

  showToast('Tab deleted', {
    actionLabel: 'Undo',
    duration: 4000,
    onAction: async () => {
      await WhyTabStorage.replaceState(snapshot.collections, snapshot.urlIndex);
      await loadData();
      render();
    },
  });
}

async function archiveCollectionWithUndo(collectionId, archive = true) {
  const snapshot = await WhyTabStorage.getAll();
  const target = snapshot.collections.find((c) => c.id === collectionId);
  if (!target) return;
  await WhyTabStorage.setCollectionArchived(collectionId, archive);
  await loadData();
  if (state.currentView === collectionId) state.currentView = 'all';
  render();
  if (archive) incrementPruneTally('archived');

  showToast(`Collection ${archive ? 'archived' : 'restored'}`, {
    actionLabel: 'Undo',
    duration: 4000,
    onAction: async () => {
      await WhyTabStorage.replaceState(snapshot.collections, snapshot.urlIndex);
      await loadData();
      render();
    },
  });
}

async function deleteCollectionWithUndo(collectionId) {
  const snapshot = await WhyTabStorage.getAll();
  const target = snapshot.collections.find((c) => c.id === collectionId);
  if (!target) return;
  await WhyTabStorage.removeCollection(collectionId);
  if (state.currentView === collectionId) state.currentView = 'all';
  await loadData();
  render();
  incrementPruneTally('deleted');

  showToast('Collection deleted', {
    actionLabel: 'Undo',
    duration: 4000,
    onAction: async () => {
      await WhyTabStorage.replaceState(snapshot.collections, snapshot.urlIndex);
      await loadData();
      render();
    },
  });
}

// ── Toast ──────────────────────────────────────────────
let toastIdCounter = 0;
const activeToasts = [];

function hideToast(toastId) {
  const index = activeToasts.findIndex((entry) => entry.id === toastId);
  if (index === -1) return;
  const [entry] = activeToasts.splice(index, 1);
  clearTimeout(entry.timer);
  entry.el.classList.remove('visible');
  setTimeout(() => {
    entry.el.remove();
  }, 200);
}

function showToast(msg, options = {}) {
  const { actionLabel = '', onAction = null, duration = 2000 } = options;
  const stack = $('#toast-stack');
  if (!stack) return;

  if (activeToasts.length >= 3) {
    hideToast(activeToasts[0].id);
  }

  const toast = document.createElement('div');
  toast.className = 'toast';

  const text = document.createElement('span');
  text.textContent = msg;
  toast.appendChild(text);

  const toastId = ++toastIdCounter;
  if (actionLabel && onAction) {
    const action = document.createElement('button');
    action.className = 'toast-action';
    action.type = 'button';
    action.textContent = actionLabel;
    action.addEventListener('click', async () => {
      try {
        await onAction();
      } finally {
        hideToast(toastId);
      }
    });
    toast.appendChild(action);
  }

  stack.appendChild(toast);
  toast.offsetHeight;
  toast.classList.add('visible');

  const timer = setTimeout(() => {
    hideToast(toastId);
  }, duration);

  activeToasts.push({ id: toastId, el: toast, timer });
}

// ── Helpers ────────────────────────────────────────────
function formatCollectionName(d = new Date()) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[d.getMonth()]} ${d.getDate()} ${WhyTabTime.timeOfDayLabel(d)}`;
}

function formatCollectionNameWithTime(d = new Date()) {
  const hour = d.getHours() % 12 || 12;
  const mins = String(d.getMinutes()).padStart(2, '0');
  const suffix = d.getHours() >= 12 ? 'pm' : 'am';
  return `${formatCollectionName(d)} ${hour}:${mins}${suffix}`;
}

function formatPreciseTimestamp(ts) {
  const d = new Date(ts);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} \u00b7 ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function relativeDate(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  const d = new Date(ts);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}

function shouldShowTimestamp(ts) {
  return (Date.now() - ts) >= 60 * 60 * 1000;
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    const maxLen = 40;
    const parts = u.pathname.split('/').filter(Boolean);
    const host = u.hostname;
    let display = host;
    if (parts.length === 1) {
      display = `${host}/${parts[0]}`;
    } else if (parts.length > 1) {
      display = `${host}/\u2026/${parts[parts.length - 1]}`;
    }
    if (display.length <= maxLen) return display;
    const keep = Math.max(10, Math.floor((maxLen - 1) / 2));
    return `${display.slice(0, keep)}\u2026${display.slice(-keep)}`;
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
