/**
 * WhyTab – Settings page script
 */

document.addEventListener('DOMContentLoaded', async () => {
  const settings = await WhyTabStorage.getSettings();

  const showItemUrls = document.getElementById('show-item-urls');
  const useContextualAutoTitles = document.getElementById('use-contextual-auto-titles');
  const exportBtn = document.getElementById('export-btn');
  const clearBtn = document.getElementById('clear-btn');
  const confirmModal = document.getElementById('confirm-modal');
  const confirmClearBtn = document.getElementById('confirm-clear-btn');
  const cancelClearBtn = document.getElementById('cancel-clear-btn');

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
    showToast('Named');
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

  // Clear all
  clearBtn.addEventListener('click', () => {
    confirmModal.classList.remove('hidden');
    confirmModal.setAttribute('aria-hidden', 'false');
  });

  cancelClearBtn.addEventListener('click', closeConfirmModal);
  confirmModal.querySelector('.modal-backdrop').addEventListener('click', closeConfirmModal);

  confirmClearBtn.addEventListener('click', async () => {
    await chrome.storage.local.clear();
    closeConfirmModal();
    showToast('All data cleared');
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeConfirmModal();
    }
  });

  function closeConfirmModal() {
    confirmModal.classList.add('hidden');
    confirmModal.setAttribute('aria-hidden', 'true');
  }
});

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
