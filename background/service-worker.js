/**
 * TabStash – Background Service Worker
 *
 * In Manifest V3, background scripts are service workers. Key differences
 * from MV2 background pages:
 *
 *   1. No persistent state – the worker gets terminated after ~30s of
 *      inactivity. All state must live in chrome.storage.
 *   2. No DOM access – no document, no window, no localStorage.
 *   3. Event-driven – register listeners at the top level so Chrome
 *      knows to wake the worker when those events fire.
 *
 * We use chrome.alarms for periodic tasks (auto-archive) because
 * setInterval/setTimeout don't survive worker termination.
 */

importScripts('../lib/storage.js');

// ── Install / update ───────────────────────────────────
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log(`[TabStash SW] onInstalled: ${details.reason}`);

  // Set up daily auto-archive alarm (idempotent)
  chrome.alarms.create('auto-archive', { periodInMinutes: 1440 });

  // Run immediately to catch any backlog
  archiveOldTabs();

  // Rebuild URL index on install/update (ensures consistency)
  await TabStashStorage.rebuildUrlIndex();

  // Ensure an "Unsorted" collection exists
  await TabStashStorage.ensureUnsorted();

  // On first install, create suggested pinned collections
  if (details.reason === 'install') {
    await createSuggestedTemplates();
  }
});

// ── Alarm: auto-archive old tabs ───────────────────────
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'auto-archive') {
    archiveOldTabs();
  }
});

async function archiveOldTabs() {
  try {
    const count = await TabStashStorage.archiveOldTabs();
    if (count > 0) {
      console.log(`[TabStash SW] Auto-archived ${count} tab(s).`);
    }
  } catch (err) {
    console.error('[TabStash SW] archiveOldTabs error:', err);
  }
}

// ── Suggested pinned templates ─────────────────────────

async function createSuggestedTemplates() {
  const collections = await TabStashStorage.getCollections();
  const realCollections = collections.filter((c) => c.name !== 'Unsorted');
  if (realCollections.length > 0) return;

  const templates = [
    { name: 'Morning routine', isPinned: true },
    { name: 'Deep work', isPinned: true },
    { name: 'Research stack', isPinned: true },
  ];

  for (const tmpl of templates) {
    await TabStashStorage.addCollection(tmpl.name, [], { isPinned: true, type: 'collection' });
  }
  console.log('[TabStash SW] Created suggested pinned collections.');
}

// ── Message handling ───────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'openFullPage') {
    openTabStashPage()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        console.error('[TabStash SW] openFullPage error:', err);
        sendResponse({ ok: false, error: err.message });
      });
    return true; // keep channel open for async sendResponse
  }

  if (msg.action === 'closeTabs') {
    const ids = (msg.tabIds || []).filter(Boolean);
    if (ids.length > 0) {
      chrome.tabs.remove(ids)
        .then(() => {
          console.log(`[TabStash SW] Closed ${ids.length} tabs`);
          sendResponse({ ok: true });
        })
        .catch((err) => {
          console.warn('[TabStash SW] closeTabs error:', err);
          sendResponse({ ok: false, error: err.message });
        });
    } else {
      sendResponse({ ok: true });
    }
    return true; // keep channel open for async sendResponse
  }
});

async function openTabStashPage() {
  const pageUrl = chrome.runtime.getURL('page/tabstash.html');

  // Check if the page is already open in any window
  const existing = await chrome.tabs.query({ url: pageUrl });
  if (existing.length > 0) {
    const tab = existing[0];
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    console.log('[TabStash SW] Focused existing TabStash page');
    return;
  }

  // Create new tab, pin it, move to position 0
  const tab = await chrome.tabs.create({ url: pageUrl, active: true });
  await chrome.tabs.update(tab.id, { pinned: true });
  await chrome.tabs.move(tab.id, { index: 0 });
  console.log('[TabStash SW] Opened new TabStash page');
}
