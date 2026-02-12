/**
 * WhyTab – Settings page script
 */

document.addEventListener('DOMContentLoaded', async () => {
  const settings = await WhyTabStorage.getSettings();

  const showItemUrls = document.getElementById('show-item-urls');
  const exportBtn = document.getElementById('export-btn');
  const clearBtn = document.getElementById('clear-btn');

  // Populate
  showItemUrls.checked = Boolean(settings.showItemUrls);

  showItemUrls.addEventListener('change', save);

  async function save() {
    await WhyTabStorage.saveSettings({
      ...settings,
      showItemUrls: showItemUrls.checked,
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
