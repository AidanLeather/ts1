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

// ── Alarm: auto-archive old tabs ───────────────────────

// Register the alarm on install. chrome.alarms.create() is idempotent –
// calling it again with the same name just updates the alarm.
chrome.runtime.onInstalled.addListener(() => {
  // Run the archiver once a day (periodInMinutes).
  chrome.alarms.create('auto-archive', { periodInMinutes: 1440 });

  // Also run immediately on install/update to catch any backlog.
  archiveOldTabs();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'auto-archive') {
    archiveOldTabs();
  }
});

async function archiveOldTabs() {
  const count = await TabStashStorage.archiveOldTabs();
  if (count > 0) {
    console.log(`[TabStash] Auto-archived ${count} tab(s).`);
  }
}
