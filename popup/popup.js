/**
 * TabStash – Popup (quick launcher)
 *
 * Three actions:
 *   1. Save and close all tabs (primary) – save, close, navigate to TabStash
 *   2. Save all tabs – save only, keep tabs open
 *   3. Open TabStash – open full management page
 */

const $ = (sel) => document.querySelector(sel);

document.addEventListener('DOMContentLoaded', () => {
  // Primary: Save and close all tabs
  $('#save-close-btn').addEventListener('click', async () => {
    const btn = $('#save-close-btn');
    btn.disabled = true;

    const tabs = await chrome.tabs.query({ currentWindow: true });
    const pageUrl = chrome.runtime.getURL('page/tabstash.html');
    const saveable = tabs.filter(
      (t) => t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://')
    );

    if (saveable.length === 0) {
      showStatus('No saveable tabs');
      btn.disabled = false;
      return;
    }

    const name = formatName();
    await TabStashStorage.addCollection(name, saveable);

    // Close all tabs except TabStash page
    const tabIds = tabs
      .filter((t) => t.id && !t.url?.startsWith(pageUrl))
      .map((t) => t.id)
      .filter(Boolean);

    if (tabIds.length > 0) {
      chrome.runtime.sendMessage({ action: 'closeTabs', tabIds });
    }

    // Navigate to TabStash
    chrome.runtime.sendMessage({ action: 'openFullPage' });
    window.close();
  });

  // Secondary: Save all tabs (keep open)
  $('#save-btn').addEventListener('click', async () => {
    const btn = $('#save-btn');
    btn.disabled = true;

    const tabs = await chrome.tabs.query({ currentWindow: true });
    const saveable = tabs.filter(
      (t) => t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://')
    );

    if (saveable.length === 0) {
      showStatus('No saveable tabs');
      btn.disabled = false;
      return;
    }

    const name = formatName();
    await TabStashStorage.addCollection(name, saveable);
    showStatus(`Saved ${saveable.length} tab${saveable.length !== 1 ? 's' : ''}`);
    btn.disabled = false;
  });

  // Tertiary: Open TabStash
  $('#open-btn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'openFullPage' });
    window.close();
  });
});

function formatName() {
  const d = new Date();
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} \u00b7 ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function showStatus(msg) {
  const el = $('#status');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 2000);
}
