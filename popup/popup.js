/**
 * TabStash – Popup (quick launcher)
 *
 * Actions:
 *   1. Save session & close tabs (primary) – save, close, navigate to TabStash
 *   2. Save this tab – save active tab as a new collection
 *   3. Add this tab to a collection – add active tab to an existing collection
 *   4. More options accordion:
 *      - Save & close tabs to the left/right
 *      - Save all tabs (don’t close)
 *   5. Open TabStash – open full management page
 *
 * Reliability:
 *   - Double-click guard on both save buttons
 *   - try/catch on every Chrome API call
 *   - Console logging for debugging
 */

const $ = (sel) => document.querySelector(sel);
let _saving = false; // double-click guard

document.addEventListener('DOMContentLoaded', async () => {
  await initAccordionState();

  // ── Primary: Save and close all tabs ──────────────────
  $('#save-close-btn').addEventListener('click', () =>
    runWithSaving($('#save-close-btn'), async () => {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const pageUrl = chrome.runtime.getURL('page/tabstash.html');
      const saveable = getSaveableTabs(tabs);

      if (saveable.length === 0) {
        showStatus('No saveable tabs');
        return;
      }

      console.log(`[TabStash popup] Saving ${saveable.length} tabs...`);

      const name = formatName();
      const col = await TabStashStorage.addCollection(name, saveable);
      console.log(`[TabStash popup] Saved collection "${name}" (${col.id}), ${saveable.length} tabs`);

      await closeTabs(tabs.filter((t) => !t.url?.startsWith(pageUrl)));

      try {
        await chrome.runtime.sendMessage({ action: 'openFullPage' });
      } catch (err) {
        console.warn('[TabStash popup] Error opening full page:', err);
      }

      window.close();
    })
  );

  // ── Save and close left/right tabs ────────────────────
  $('#save-close-left-btn').addEventListener('click', () =>
    runWithSaving($('#save-close-left-btn'), async () => {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const active = tabs.find((t) => t.active);
      if (!active) return;
      const leftTabs = tabs.filter((t) => t.index < active.index);
      const saveable = getSaveableTabs(leftTabs);

      if (saveable.length === 0) {
        showStatus('No saveable tabs to the left');
        return;
      }

      const name = `${formatName()} \u00b7 Left`;
      await TabStashStorage.addCollection(name, saveable);
      await closeTabs(leftTabs);
      showStatus(`Saved ${saveable.length} tab${saveable.length !== 1 ? 's' : ''} from the left`);
    })
  );

  $('#save-close-right-btn').addEventListener('click', () =>
    runWithSaving($('#save-close-right-btn'), async () => {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const active = tabs.find((t) => t.active);
      if (!active) return;
      const rightTabs = tabs.filter((t) => t.index > active.index);
      const saveable = getSaveableTabs(rightTabs);

      if (saveable.length === 0) {
        showStatus('No saveable tabs to the right');
        return;
      }

      const name = `${formatName()} \u00b7 Right`;
      await TabStashStorage.addCollection(name, saveable);
      await closeTabs(rightTabs);
      showStatus(`Saved ${saveable.length} tab${saveable.length !== 1 ? 's' : ''} from the right`);
    })
  );

  // ── Save all tabs (keep open) ─────────────────────────
  $('#save-btn').addEventListener('click', () =>
    runWithSaving($('#save-btn'), async () => {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const saveable = getSaveableTabs(tabs);

      if (saveable.length === 0) {
        showStatus('No saveable tabs');
        return;
      }

      console.log(`[TabStash popup] Saving ${saveable.length} tabs (keep open)...`);

      const name = formatName();
      const col = await TabStashStorage.addCollection(name, saveable);
      console.log(`[TabStash popup] Saved collection "${name}" (${col.id})`);

      showStatus(`Saved ${saveable.length} tab${saveable.length !== 1 ? 's' : ''}`);
    })
  );

  // ── Save this tab ─────────────────────────────────────
  $('#save-tab-btn').addEventListener('click', () =>
    runWithSaving($('#save-tab-btn'), async () => {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const active = tabs.find((t) => t.active);
      if (!active || !isSaveableTab(active)) {
        showStatus('No saveable active tab');
        return;
      }
      const name = active.title?.trim() || formatName();
      await TabStashStorage.addCollection(name, [active]);
      showStatus('Saved this tab');
    })
  );

  // ── Add this tab to a collection ──────────────────────
  $('#add-tab-btn').addEventListener('click', async () => {
    const picker = $('#collection-picker');
    if (!picker.classList.contains('hidden')) {
      picker.classList.add('hidden');
      return;
    }

    const collections = await TabStashStorage.getCollections();
    if (!collections.length) {
      showStatus('No collections yet');
      return;
    }
    const sorted = TabStashStorage.sortCollections(collections);
    const select = $('#collection-select');
    select.innerHTML = '';
    for (const col of sorted) {
      const opt = document.createElement('option');
      opt.value = col.id;
      opt.textContent = col.name;
      select.appendChild(opt);
    }
    picker.classList.remove('hidden');
  });

  $('#collection-add-confirm').addEventListener('click', () =>
    runWithSaving($('#collection-add-confirm'), async () => {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const active = tabs.find((t) => t.active);
      if (!active || !isSaveableTab(active)) {
        showStatus('No saveable active tab');
        return;
      }
      const collectionId = $('#collection-select').value;
      if (!collectionId) {
        showStatus('Choose a collection');
        return;
      }
      await TabStashStorage.addManualTab(collectionId, active.title || active.url, active.url);
      showStatus('Added tab to collection');
      $('#collection-picker').classList.add('hidden');
    })
  );

  $('#more-options-toggle').addEventListener('click', async () => {
    const toggle = $('#more-options-toggle');
    const panel = $('#more-options');
    const nextOpen = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(nextOpen));
    panel.classList.toggle('hidden', !nextOpen);
    await chrome.storage.local.set({ popupAccordionOpen: nextOpen });
  });

  // ── Tertiary: Open TabStash ───────────────────────────
  $('#open-btn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'openFullPage' }).catch((err) => {
      console.warn('[TabStash popup] Error opening full page:', err);
    });
    window.close();
  });
});

async function initAccordionState() {
  try {
    const { popupAccordionOpen } = await chrome.storage.local.get('popupAccordionOpen');
    const isOpen = Boolean(popupAccordionOpen);
    $('#more-options-toggle').setAttribute('aria-expanded', String(isOpen));
    $('#more-options').classList.toggle('hidden', !isOpen);
  } catch (err) {
    console.warn('[TabStash popup] Error loading accordion state:', err);
  }
}

function getSaveableTabs(tabs) {
  return tabs.filter(isSaveableTab);
}

function isSaveableTab(tab) {
  return tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://');
}

async function closeTabs(tabs) {
  const closeIds = tabs
    .filter((t) => t.id)
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
}

async function runWithSaving(btn, action) {
  if (_saving) return;
  _saving = true;
  if (btn) btn.disabled = true;

  try {
    await action();
  } catch (err) {
    console.error('[TabStash popup] Action failed:', err);
    showStatus('Error performing action');
  } finally {
    if (btn) btn.disabled = false;
    _saving = false;
  }
}

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
