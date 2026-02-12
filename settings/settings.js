/**
 * WhyTab – Settings page script
 */

document.addEventListener('DOMContentLoaded', async () => {
  const settings = await TabStashStorage.getSettings();

  const archiveEnabled = document.getElementById('archive-enabled');
  const archiveDays = document.getElementById('archive-days');
  const daysRow = document.getElementById('days-row');
  const exportBtn = document.getElementById('export-btn');
  const clearBtn = document.getElementById('clear-btn');

  // Populate
  archiveEnabled.checked = settings.archiveEnabled;
  archiveDays.value = settings.archiveDays;
  daysRow.style.opacity = settings.archiveEnabled ? '1' : '0.4';

  // Toggle archive
  archiveEnabled.addEventListener('change', async () => {
    daysRow.style.opacity = archiveEnabled.checked ? '1' : '0.4';
    await save();
  });

  // Days input
  archiveDays.addEventListener('change', async () => {
    const val = parseInt(archiveDays.value, 10);
    if (val >= 1 && val <= 365) {
      await save();
    }
  });

  async function save() {
    await TabStashStorage.saveSettings({
      archiveEnabled: archiveEnabled.checked,
      archiveDays: parseInt(archiveDays.value, 10) || 30,
    });
    showToast('Saved');
  }

  // Export
  exportBtn.addEventListener('click', async () => {
    const data = await TabStashStorage.getAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `whytab-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Exported');
  });

  // Clear all
  clearBtn.addEventListener('click', async () => {
    if (confirm('This will permanently delete all saved tabs and collections. Are you sure?')) {
      await chrome.storage.local.clear();
      showToast('All data cleared');
    }
  });
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
