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
let _settings = null;
let _pickerCollections = [];
let _pickerOpen = false;

const TITLE_STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from',
  'is', 'it', 'this', 'that', 'are', 'was', 'were', 'be', 'been', 'has', 'have', 'had', 'do', 'does',
  'did', 'will', 'would', 'could', 'should', 'can', 'may', 'not', 'no', 'so', 'if', 'as', 'into',
  'than', 'its', 'our', 'my', 'your', 'how', 'what', 'when', 'where', 'who', 'which', 'why', 'all',
  'each', 'new', 'about', 'up', 'out', 'just', 'more', 'also', 'get', 'one', 'two', 'like', 'make',
  'over', 'such', 'after', 'before', 'between', 'through', 'during', 'only', 'other', 'some', 'them',
  'then', 'these', 'those', 'very', 'most', 'own', 'same', 'both', 'few', 'any', 'many', 'us', 'home',
  'page', 'site', 'app', 'web', 'online', 'free', 'best', 'top', 'official', 'welcome', 'log', 'sign',
  'dashboard', 'untitled', 'contact', 'null', 'undefined',
]);

const FRIENDLY_DOMAINS = {
  'github.com': 'GitHub',
  'dribbble.com': 'Dribbble',
  'youtube.com': 'YouTube',
  'google.com': 'Google',
  'stackoverflow.com': 'Stack Overflow',
  'reddit.com': 'Reddit',
  'twitter.com': 'Twitter',
  'x.com': 'X',
};

document.addEventListener('DOMContentLoaded', async () => {
  await initAccordionState();
  _settings = await WhyTabStorage.getSettings();
  await updateWindowTabCount();

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
      const generated = generateSessionCollectionTitle(saveable, createdAt);
      const name = generated.name;
      const col = await WhyTabStorage.addCollection(name, saveable, {
        createdAt,
        autoTitleType: generated.autoTitleType,
      });
      console.log(`[WhyTab popup] Saved collection "${name}" (${col.id}), ${saveable.length} tabs`);

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
      const name = `${formatName(new Date(createdAt))} \u00b7 Left`;
      await WhyTabStorage.addCollection(name, saveable, {
        createdAt,
        autoTitleType: 'timeOfDay',
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
      const name = `${formatName(new Date(createdAt))} \u00b7 Right`;
      await WhyTabStorage.addCollection(name, saveable, {
        createdAt,
        autoTitleType: 'timeOfDay',
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
      const generated = generateSessionCollectionTitle(saveable, createdAt);
      const name = generated.name;
      const col = await WhyTabStorage.addCollection(name, saveable, {
        createdAt,
        autoTitleType: generated.autoTitleType,
      });
      console.log(`[WhyTab popup] Saved collection "${name}" (${col.id})`);

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
      const fallbackName = _settings?.useContextualAutoTitles
        ? formatName(new Date(createdAt))
        : formatClassicTimeOfDayName(new Date(createdAt));
      const name = active.title?.trim() || fallbackName;
      const options = active.title?.trim()
        ? {}
        : { createdAt, autoTitleType: 'timeOfDay' };
      await WhyTabStorage.addCollection(name, [active], options);
      showStatus('Saved this tab');
    })
  );

  // ── Add this tab to a collection ──────────────────────
  $('#add-tab-btn').addEventListener('click', async () => {
    if (_pickerOpen) {
      closeCollectionPicker();
      return;
    }

    const collections = await WhyTabStorage.getCollections();
    const eligible = getPickerCollections(collections);
    if (!eligible.length) {
      showStatus('No pinned or named collections');
      return;
    }

    _pickerCollections = eligible;
    renderCollectionPicker();
    openCollectionPicker();
  });

  $('#new-collection-btn').addEventListener('click', () => {
    const inline = $('#new-collection-inline');
    inline.classList.remove('hidden');
    $('#new-collection-input').focus();
  });

  $('#new-collection-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      createNewCollectionFromPicker();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeCollectionPicker();
    }
  });

  document.addEventListener('click', (event) => {
    if (!_pickerOpen) return;
    const picker = $('#collection-picker');
    const toggle = $('#add-tab-btn');
    if (picker.contains(event.target) || toggle.contains(event.target)) return;
    closeCollectionPicker();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && _pickerOpen) {
      closeCollectionPicker();
    }
  });

  $('#more-options-toggle').addEventListener('click', async () => {
    const toggle = $('#more-options-toggle');
    const panel = $('#more-options');
    const nextOpen = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(nextOpen));
    panel.classList.toggle('hidden', !nextOpen);
    await chrome.storage.local.set({ popupAccordionOpen: nextOpen });
  });



  // ── Tertiary: Open WhyTab ───────────────────────────
  $('#open-btn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'openFullPage' }).catch((err) => {
      console.warn('[WhyTab popup] Error opening full page:', err);
    });
    window.close();
  });
});


async function updateWindowTabCount() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const count = tabs.length;
  $('#window-tab-count').textContent = `${count} tab${count === 1 ? '' : 's'} in this window`;
}

function getPickerCollections(collections) {
  const pinned = collections.filter((col) => col.isPinned);
  const named = collections
    .filter((col) => !col.isPinned && col.isUserNamed)
    .sort((a, b) => (b.lastInteractedAt || b.createdAt || 0) - (a.lastInteractedAt || a.createdAt || 0));
  return [...pinned, ...named];
}

function openCollectionPicker() {
  _pickerOpen = true;
  $('#collection-picker').classList.remove('hidden');
  $('#add-tab-btn').setAttribute('aria-expanded', 'true');
}

function closeCollectionPicker() {
  _pickerOpen = false;
  $('#collection-picker').classList.add('hidden');
  $('#add-tab-btn').setAttribute('aria-expanded', 'false');
  $('#new-collection-inline').classList.add('hidden');
  $('#new-collection-input').value = '';
}

function renderCollectionPicker() {
  const list = $('#collection-list');
  list.innerHTML = '';

  for (const col of _pickerCollections) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'popup-collection-item';
    row.dataset.collectionId = col.id;
    row.innerHTML = `<span>${escapeHtml(col.name || 'Untitled')}</span><span class="popup-collection-count">(${(col.tabs || []).length})</span>`;
    row.addEventListener('click', () => addCurrentTabToCollection(col, row));
    list.appendChild(row);
  }

  list.classList.toggle('scrollable', _pickerCollections.length > 8);
}

async function addCurrentTabToCollection(collection, rowEl) {
  if (_saving) return;
  await runWithSaving(rowEl, async () => {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const active = tabs.find((t) => t.active);
    if (!active || !isSaveableTab(active)) {
      showStatus('No saveable active tab');
      return;
    }

    await WhyTabStorage.addManualTab(collection.id, active.title || active.url, active.url);
    rowEl.classList.add('added');
    rowEl.textContent = 'Added ✓';
    await sleep(800);
    closeCollectionPicker();
    showStatus('Added tab to collection');
  });
}

async function createNewCollectionFromPicker() {
  const input = $('#new-collection-input');
  const name = input.value.trim();
  if (!name) return;

  await runWithSaving($('#new-collection-btn'), async () => {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const active = tabs.find((t) => t.active);
    if (!active || !isSaveableTab(active)) {
      showStatus('No saveable active tab');
      return;
    }

    await WhyTabStorage.addCollection(name, [active], { isUserNamed: true });
    closeCollectionPicker();
    showStatus('Added tab to new collection');
  });
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

async function runWithSaving(btn, action) {
  if (_saving) return;
  _saving = true;
  if (btn) btn.disabled = true;

  try {
    await action();
  } catch (err) {
    console.error('[WhyTab popup] Action failed:', err);
    showStatus('Error performing action');
  } finally {
    if (btn) btn.disabled = false;
    _saving = false;
  }
}

function formatName(d = new Date()) {
  return WhyTabTime.formatWeekdayTimeName(d);
}

function formatClassicTimeOfDayName(date = new Date()) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[date.getMonth()]} ${date.getDate()} ${WhyTabTime.timeOfDayLabel(date)}`;
}

function generateSessionCollectionTitle(tabs, createdAt = Date.now()) {
  const timestamp = formatName(new Date(createdAt));
  const classicTimestamp = formatClassicTimeOfDayName(new Date(createdAt));
  const usableTabs = tabs.filter((tab) => typeof tab.url === 'string');

  if (!_settings?.useContextualAutoTitles) {
    return { name: classicTimestamp, autoTitleType: 'timeOfDay' };
  }

  if (usableTabs.length === 1) {
    const oneTitle = (usableTabs[0].title || '').trim() || usableTabs[0].url;
    return { name: truncateTitle(oneTitle, 50), autoTitleType: 'singleTab' };
  }

  if (usableTabs.length && usableTabs.every((tab) => isInternalOnlyUrl(tab.url))) {
    return { name: timestamp, autoTitleType: 'timeOfDay' };
  }

  const domainTitle = buildDomainTitle(usableTabs, timestamp);
  if (domainTitle) return { name: domainTitle, autoTitleType: 'domainCluster' };

  const keywordTitle = buildKeywordTitle(usableTabs, timestamp);
  if (keywordTitle) return { name: keywordTitle, autoTitleType: 'keywordCluster' };

  return { name: timestamp, autoTitleType: 'timeOfDay' };
}

function buildDomainTitle(tabs, timestamp) {
  const hosts = tabs
    .map((tab) => getNormalizedHostname(tab.url))
    .filter(Boolean);
  if (!hosts.length) return null;

  const counts = new Map();
  for (const host of hosts) counts.set(host, (counts.get(host) || 0) + 1);

  const [topHost, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || [];
  if (!topHost || !topCount) return null;

  const ratio = topCount / tabs.length;
  if (ratio < 0.4) return null;

  const domainLabel = formatDomainLabel(topHost);
  if (ratio >= 0.75) return `${domainLabel} — ${timestamp}`;
  return `Mostly ${domainLabel} — ${timestamp}`;
}

function buildKeywordTitle(tabs, timestamp) {
  const freq = new Map();
  const inTitleCount = new Map();

  for (const tab of tabs) {
    const words = extractMeaningfulWords(tab.title || tab.url || '');
    const uniqueWords = new Set(words);
    for (const word of words) freq.set(word, (freq.get(word) || 0) + 1);
    for (const word of uniqueWords) inTitleCount.set(word, (inTitleCount.get(word) || 0) + 1);
  }

  const recurringWords = [...freq.entries()]
    .filter(([word]) => (inTitleCount.get(word) || 0) >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([word]) => word);

  if (!recurringWords.length) return null;

  if (recurringWords.length === 1) {
    return `${capitalizeWord(recurringWords[0])} — ${timestamp}`;
  }

  return `${capitalizeWord(recurringWords[0])}, ${capitalizeWord(recurringWords[1])} — ${timestamp}`;
}

function extractMeaningfulWords(title) {
  return title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => {
      if (!word || word.length <= 1) return false;
      if (/^\d+$/.test(word)) return false;
      return !TITLE_STOP_WORDS.has(word);
    });
}

function getNormalizedHostname(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function isInternalOnlyUrl(url) {
  return typeof url === 'string' && (
    url.startsWith('about:')
    || url.startsWith('chrome://')
    || url.startsWith('chrome-extension://')
  );
}

function formatDomainLabel(hostname) {
  const friendly = FRIENDLY_DOMAINS[hostname];
  if (friendly) return friendly;
  return hostname;
}

function capitalizeWord(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function truncateTitle(title, maxLength) {
  if (!title || title.length <= maxLength) return title;
  return `${title.slice(0, maxLength - 1).trimEnd()}…`;
}

function showStatus(msg) {
  const el = $('#status');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 2500);
}
