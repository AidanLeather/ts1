/**
 * WhyTab – Background Service Worker
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
 * Keep logic event-driven so the worker can be terminated and restarted safely.
 */

importScripts('../lib/time.js', '../lib/storage.js');

// ── Install / update ───────────────────────────────────
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log(`[WhyTab SW] onInstalled: ${details.reason}`);

  if (details.reason === 'install') {
    await chrome.tabs.create({
      url: chrome.runtime.getURL('whytab.html'),
      pinned: true,
      index: 0,
    });

    await ensureStarterCollections();
  }

  // Rebuild URL index on install/update (ensures consistency)
  await WhyTabStorage.rebuildUrlIndex();

});

// ── Suggested pinned templates ─────────────────────────

async function ensureStarterCollections() {
  const data = await chrome.storage.local.get(['collections', 'hasCompletedOnboarding']);
  if (data.hasCompletedOnboarding) return;

  const collections = Array.isArray(data.collections) ? data.collections : [];
  const tabCount = collections.reduce((sum, col) => sum + ((col.tabs || []).length), 0);
  if (collections.length > 0 || tabCount > 0) {
    await chrome.storage.local.set({ hasCompletedOnboarding: true });
    return;
  }

  await WhyTabStorage.addCollection(
    'Reading list',
    [
      {
        title: 'When to Do What You Love — Paul Graham',
        url: 'https://paulgraham.com/when.html',
      },
      {
        title: 'This Is Water — David Foster Wallace',
        url: 'https://fs.blog/david-foster-wallace-this-is-water/',
      },
      {
        title: 'Berkshire Hathaway 2022 Annual Report — Warren Buffett',
        url: 'https://www.berkshirehathaway.com/2022ar/linksannual22.html',
      },
    ],
    { isPinned: true, isUserNamed: true },
  );

  await WhyTabStorage.addCollection(
    'Inspiration',
    [
      { title: 'Wonder', url: 'https://www.wondercard.co' },
      { title: "People's Graphic Design Archive", url: 'https://peoplesgdarchive.org/' },
      { title: 'Deck Gallery', url: 'https://www.deck.gallery/' },
    ],
    { isPinned: true, isUserNamed: true },
  );

  await chrome.storage.local.set({ hasCompletedOnboarding: true });
  console.log('[WhyTab SW] Created starter pinned collections.');
}

// ── Message handling ───────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'openFullPage') {
    openWhyTabPage()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        console.error('[WhyTab SW] openFullPage error:', err);
        sendResponse({ ok: false, error: err.message });
      });
    return true; // keep channel open for async sendResponse
  }

  if (msg.action === 'closeTabs') {
    const ids = (msg.tabIds || []).filter(Boolean);
    if (ids.length > 0) {
      chrome.tabs.remove(ids)
        .then(() => {
          console.log(`[WhyTab SW] Closed ${ids.length} tabs`);
          sendResponse({ ok: true });
        })
        .catch((err) => {
          console.warn('[WhyTab SW] closeTabs error:', err);
          sendResponse({ ok: false, error: err.message });
        });
    } else {
      sendResponse({ ok: true });
    }
    return true; // keep channel open for async sendResponse
  }
});

async function openWhyTabPage() {
  const pageUrl = chrome.runtime.getURL('page/tabstash.html');

  // Check if the page is already open in any window
  const existing = await chrome.tabs.query({ url: pageUrl });
  if (existing.length > 0) {
    const tab = existing[0];
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    console.log('[WhyTab SW] Focused existing WhyTab page');
    return;
  }

  // Create new tab, pin it, move to position 0
  const tab = await chrome.tabs.create({ url: pageUrl, active: true });
  await chrome.tabs.update(tab.id, { pinned: true });
  await chrome.tabs.move(tab.id, { index: 0 });
  console.log('[WhyTab SW] Opened new WhyTab page');
}
