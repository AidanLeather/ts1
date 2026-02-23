/**
 * WhyTab – Settings page script
 */

document.addEventListener('DOMContentLoaded', async () => {
  const settings = await WhyTabStorage.getSettings();

  const showItemUrls = document.getElementById('show-item-urls');
  const useContextualAutoTitles = document.getElementById('use-contextual-auto-titles');
  const exportBtn = document.getElementById('export-btn');
  const importBtn = document.getElementById('import-btn');
  const importFile = document.getElementById('import-file');
  const clearBtn = document.getElementById('clear-btn');

  const confirmModal = document.getElementById('confirm-modal');
  const confirmClearBtn = document.getElementById('confirm-clear-btn');
  const cancelClearBtn = document.getElementById('cancel-clear-btn');

  const importModeModal = document.getElementById('import-mode-modal');
  const importMergeBtn = document.getElementById('import-merge-btn');
  const importReplaceBtn = document.getElementById('import-replace-btn');
  const importCancelBtn = document.getElementById('import-cancel-btn');

  let pendingImportData = null;

  // Populate
  showItemUrls.checked = Boolean(settings.showItemUrls);
  useContextualAutoTitles.checked = Boolean(settings.useContextualAutoTitles);

  showItemUrls.addEventListener('change', save);
  useContextualAutoTitles.addEventListener('change', save);

  async function save() {
    await WhyTabStorage.saveSettings({
      ...settings,
      showItemUrls: showItemUrls.checked,
      useContextualAutoTitles: useContextualAutoTitles.checked,
    });
    showToast('Saved');
  }

  // Export
  exportBtn.addEventListener('click', async () => {
    const data = await WhyTabStorage.getAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tabstash-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Exported');
  });

  // Import
  importBtn.addEventListener('click', () => importFile.click());

  importFile.addEventListener('change', async () => {
    const file = importFile.files?.[0];
    if (!file) return;

    try {
      const text = (await file.text()).replace(/^\uFEFF/, '');
      const parsed = JSON.parse(text);
      const valid = validateImportPayload(parsed);
      if (!valid) throw new Error('invalid');

      pendingImportData = valid;
      openModal(importModeModal);
    } catch (_err) {
      pendingImportData = null;
      showToast('Invalid import file');
    } finally {
      importFile.value = '';
    }
  });

  importCancelBtn.addEventListener('click', () => {
    pendingImportData = null;
    closeModal(importModeModal);
  });

  importMergeBtn.addEventListener('click', async () => {
    if (!pendingImportData) return;

    const confirmed = window.confirm('Are you sure you want to merge this import with your current data?');
    if (!confirmed) return;

    try {
      const existing = await WhyTabStorage.getAll();
      const merged = mergeData(existing, pendingImportData);
      await chrome.storage.local.set(merged);
      pendingImportData = null;
      closeModal(importModeModal);
      showToast('Data merged');
    } catch (_err) {
      showToast('Import failed');
    }
  });

  importReplaceBtn.addEventListener('click', async () => {
    if (!pendingImportData) return;

    const confirmed = window.confirm('Are you sure you want to replace all current data with this import? This cannot be undone.');
    if (!confirmed) return;

    try {
      await chrome.storage.local.clear();
      await chrome.storage.local.set({
        collections: pendingImportData.collections,
        urlIndex: pendingImportData.urlIndex,
        settings: pendingImportData.settings,
        actionLog: pendingImportData.actionLog,
      });
      pendingImportData = null;
      closeModal(importModeModal);
      showToast('Data replaced');
    } catch (_err) {
      showToast('Import failed');
    }
  });

  // Clear all
  clearBtn.addEventListener('click', () => {
    openModal(confirmModal);
  });

  cancelClearBtn.addEventListener('click', () => closeModal(confirmModal));
  confirmModal.querySelector('.modal-backdrop').addEventListener('click', () => closeModal(confirmModal));

  confirmClearBtn.addEventListener('click', async () => {
    await chrome.storage.local.clear();
    closeModal(confirmModal);
    showToast('All data cleared');
  });

  importModeModal.querySelector('.modal-backdrop').addEventListener('click', () => {
    pendingImportData = null;
    closeModal(importModeModal);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeModal(confirmModal);
      closeModal(importModeModal);
    }
  });
});

function openModal(modalEl) {
  modalEl.classList.remove('hidden');
  modalEl.setAttribute('aria-hidden', 'false');
}

function closeModal(modalEl) {
  modalEl.classList.add('hidden');
  modalEl.setAttribute('aria-hidden', 'true');
}

function normalizeImportedCollections(collections) {
  return collections.map((collection) => {
    const createdAt = Number(collection?.createdAt) || Date.now();
    const tabs = Array.isArray(collection?.tabs)
      ? collection.tabs
        .filter((tab) => tab && typeof tab.url === 'string' && tab.url.trim())
        .map((tab) => ({
          ...tab,
          id: tab.id || crypto.randomUUID(),
          title: tab.title || tab.url,
          favIconUrl: tab.favIconUrl || '',
          customFavicon: tab.customFavicon || '',
          savedAt: Number(tab.savedAt) || createdAt,
          archived: Boolean(tab.archived),
          tags: Array.isArray(tab.tags) ? tab.tags : [],
        }))
      : [];

    return {
      ...collection,
      id: collection?.id || crypto.randomUUID(),
      name: collection?.name || 'Imported collection',
      createdAt,
      isPinned: Boolean(collection?.isPinned),
      notes: typeof collection?.notes === 'string' ? collection.notes : '',
      archived: Boolean(collection?.archived),
      keptAt: Number.isFinite(collection?.keptAt) ? collection.keptAt : null,
      tabs,
    };
  });
}

function buildUrlIndexFromCollections(collections) {
  const idx = {};
  for (const col of collections) {
    for (const tab of (col.tabs || [])) {
      if (!tab?.url) continue;
      idx[tab.url] = (idx[tab.url] || 0) + 1;
    }
  }
  return idx;
}

function validateImportPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (!Array.isArray(payload.collections)) return null;

  const collections = normalizeImportedCollections(payload.collections);
  return {
    collections,
    urlIndex: payload.urlIndex && typeof payload.urlIndex === 'object'
      ? payload.urlIndex
      : buildUrlIndexFromCollections(collections),
    settings: payload.settings && typeof payload.settings === 'object' ? payload.settings : {},
    actionLog: Array.isArray(payload.actionLog) ? payload.actionLog : [],
  };
}

function mergeData(existing, imported) {
  const collections = [...imported.collections, ...existing.collections];
  return {
    collections,
    urlIndex: buildUrlIndexFromCollections(collections),
    settings: {
      ...existing.settings,
      ...imported.settings,
    },
    actionLog: [
      ...(existing.actionLog || []),
      ...(imported.actionLog || []),
    ],
  };
}

function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  // Force reflow so transition fires
  toast.offsetHeight;
  toast.classList.add('visible');
  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.classList.add('hidden'), 300);
  }, 1500);
}
