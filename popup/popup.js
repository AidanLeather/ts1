/**
 * WhyTab – Popup (quick launcher)
 *
 * Actions:
 *   1. Save & close tabs (primary) – save, close, navigate to WhyTab
 *   2. Save this tab – save active tab as a new collection
 *   3. Add this tab to a collection – add active tab to an existing collection
 *   4. More options accordion:
 *      - Save & close tabs to the left/right
 *      - Save all tabs (don’t close)
 *   5. Open WhyTab – open full management page
 *
 * Reliability:
 *   - Double-click guard on both save buttons
 *   - try/catch on every Chrome API call
 *   - Console logging for debugging
 */

const $ = (sel) => document.querySelector(sel);
let _saving = false; // double-click guard
const SAVED_BUTTON_HOLD_MS = 1200;

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

      console.log(`[WhyTab popup] Saving ${saveable.length} tabs...`);

      const createdAt = Date.now();
      const titleMeta = WhyTabTime.generateSessionCollectionTitle(saveable, new Date(createdAt));
      const col = await WhyTabStorage.addCollection(titleMeta.name, saveable, {
        createdAt,
        autoTitleType: titleMeta.autoTitleType,
      });
      console.log(`[WhyTab popup] Saved collection "${titleMeta.name}" (${col.id}), ${saveable.length} tabs`);

      await closeTabs(tabs.filter((t) => !t.url?.startsWith(pageUrl)));

      try {
        await chrome.runtime.sendMessage({ action: 'openFullPage' });
      } catch (err) {
        console.warn('[WhyTab popup] Error opening full page:', err);
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

      const createdAt = Date.now();
      const titleMeta = WhyTabTime.generateSessionCollectionTitle(saveable, new Date(createdAt));
      await WhyTabStorage.addCollection(`${titleMeta.name} · Left`, saveable, {
        createdAt,
        autoTitleType: titleMeta.autoTitleType,
      });
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

      const createdAt = Date.now();
      const titleMeta = WhyTabTime.generateSessionCollectionTitle(saveable, new Date(createdAt));
      await WhyTabStorage.addCollection(`${titleMeta.name} · Right`, saveable, {
        createdAt,
        autoTitleType: titleMeta.autoTitleType,
      });
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

      console.log(`[WhyTab popup] Saving ${saveable.length} tabs (keep open)...`);

      const createdAt = Date.now();
      const titleMeta = WhyTabTime.generateSessionCollectionTitle(saveable, new Date(createdAt));
      const col = await WhyTabStorage.addCollection(titleMeta.name, saveable, {
        createdAt,
        autoTitleType: titleMeta.autoTitleType,
      });
      console.log(`[WhyTab popup] Saved collection "${titleMeta.name}" (${col.id})`);

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
      const createdAt = Date.now();
      const titleMeta = WhyTabTime.generateSessionCollectionTitle([active], new Date(createdAt));
      await WhyTabStorage.addCollection(titleMeta.name, [active], {
        createdAt,
        autoTitleType: titleMeta.autoTitleType,
      });
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

    const collections = await WhyTabStorage.getCollections();
    if (!collections.length) {
      showStatus('No collections yet');
      return;
    }
    const sorted = WhyTabStorage.sortCollections(collections);
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

  $('#more-options-toggle').addEventListener('click', async () => {
    const toggle = $('#more-options-toggle');
    const panel = $('#more-options');
    const nextOpen = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(nextOpen));
    panel.classList.toggle('hidden', !nextOpen);
    await chrome.storage.local.set({ popupAccordionOpen: nextOpen });
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
      await WhyTabStorage.addManualTab(collectionId, active.title || active.url, active.url);
      showStatus('Added tab to collection');
      $('#collection-picker').classList.add('hidden');
    }, false)
  );

  // ── Tertiary: Open WhyTab ───────────────────────────
  $('#open-btn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'openFullPage' }).catch((err) => {
      console.warn('[WhyTab popup] Error opening full page:', err);
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
    console.warn('[WhyTab popup] Error loading accordion state:', err);
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
      console.log(`[WhyTab popup] Closed ${closeIds.length} tabs`);
    } catch (err) {
      console.warn('[WhyTab popup] Error closing tabs:', err);
    }
  }
}

async function runWithSaving(btn, action, showSavedState = true) {
  if (_saving) return;
  _saving = true;
  const labelEl = btn?.querySelector('.btn-label');
  const originalLabel = btn ? (btn.dataset.originalLabel || labelEl?.textContent?.trim() || btn.textContent.trim()) : '';

  if (btn) {
    btn.dataset.originalLabel = originalLabel;
    btn.classList.add('is-saving');
    btn.disabled = true;
  }

  try {
    await action();
    if (btn && showSavedState && labelEl) {
      labelEl.classList.add('label-fade-out');
      await new Promise((resolve) => setTimeout(resolve, 150));
      labelEl.textContent = 'Saved';
      labelEl.classList.remove('label-fade-out');
      btn.classList.add('is-saved');
      await new Promise((resolve) => setTimeout(resolve, SAVED_BUTTON_HOLD_MS));
      labelEl.classList.add('label-fade-out');
      await new Promise((resolve) => setTimeout(resolve, 150));
      labelEl.textContent = originalLabel;
      labelEl.classList.remove('label-fade-out');
    }
  } catch (err) {
    console.error('[WhyTab popup] Action failed:', err);
    showStatus('Error performing action');
  } finally {
    if (btn) {
      if (labelEl && labelEl.textContent !== originalLabel) {
        labelEl.textContent = originalLabel;
        labelEl.classList.remove('label-fade-out');
      }
      btn.classList.remove('is-saved');
      btn.disabled = false;
      btn.classList.remove('is-saving');
    }
    _saving = false;
  }
}


function showStatus(msg) {
  const el = $('#status');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 2500);
}
