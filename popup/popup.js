/**
 * TabStash – Popup (quick launcher)
 *
 * Three actions:
 *   1. Save and close all tabs (primary) – save, close, navigate to TabStash
 *   2. Save all tabs – save only, keep tabs open
 *   3. Open TabStash – open full management page
 *
 * Reliability:
 *   - Double-click guard on both save buttons
 *   - try/catch on every Chrome API call
 *   - Console logging for debugging
 */

const $ = (sel) => document.querySelector(sel);
let _saving = false; // double-click guard

document.addEventListener('DOMContentLoaded', () => {
  // ── Primary: Save and close all tabs ──────────────────
  $('#save-close-btn').addEventListener('click', async () => {
    if (_saving) return;
    _saving = true;
    const btn = $('#save-close-btn');
    btn.disabled = true;

    try {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const pageUrl = chrome.runtime.getURL('page/tabstash.html');
      const saveable = tabs.filter(
        (t) => t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://')
      );

      if (saveable.length === 0) {
        showStatus('No saveable tabs');
        btn.disabled = false;
        _saving = false;
        return;
      }

      console.log(`[TabStash popup] Saving ${saveable.length} tabs...`);

      const name = formatName();
      const col = await TabStashStorage.addCollection(name, saveable);
      console.log(`[TabStash popup] Saved collection "${name}" (${col.id}), ${saveable.length} tabs`);

      // Close all tabs except TabStash page itself
      const closeIds = tabs
        .filter((t) => t.id && !t.url?.startsWith(pageUrl))
        .map((t) => t.id)
        .filter(Boolean);

      if (closeIds.length > 0) {
        try {
          await chrome.tabs.remove(closeIds);
          console.log(`[TabStash popup] Closed ${closeIds.length} tabs`);
        } catch (err) {
          console.warn('[TabStash popup] Error closing tabs:', err);
        }
      }

      // Open/focus TabStash page
      try {
        await chrome.runtime.sendMessage({ action: 'openFullPage' });
      } catch (err) {
        console.warn('[TabStash popup] Error opening full page:', err);
      }

      window.close();
    } catch (err) {
      console.error('[TabStash popup] Save-and-close failed:', err);
      showStatus('Error saving tabs');
      btn.disabled = false;
      _saving = false;
    }
  });

  // ── Secondary: Save all tabs (keep open) ──────────────
  $('#save-btn').addEventListener('click', async () => {
    if (_saving) return;
    _saving = true;
    const btn = $('#save-btn');
    btn.disabled = true;

    try {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const saveable = tabs.filter(
        (t) => t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://')
      );

      if (saveable.length === 0) {
        showStatus('No saveable tabs');
        btn.disabled = false;
        _saving = false;
        return;
      }

      console.log(`[TabStash popup] Saving ${saveable.length} tabs (keep open)...`);

      const name = formatName();
      const col = await TabStashStorage.addCollection(name, saveable);
      console.log(`[TabStash popup] Saved collection "${name}" (${col.id})`);

      showStatus(`Saved ${saveable.length} tab${saveable.length !== 1 ? 's' : ''}`);
    } catch (err) {
      console.error('[TabStash popup] Save failed:', err);
      showStatus('Error saving tabs');
    } finally {
      btn.disabled = false;
      _saving = false;
    }
  });

  // ── Tertiary: Open TabStash ───────────────────────────
  $('#open-btn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'openFullPage' }).catch((err) => {
      console.warn('[TabStash popup] Error opening full page:', err);
    });
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
  setTimeout(() => el.classList.add('hidden'), 2500);
}
