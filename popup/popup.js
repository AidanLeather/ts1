/**
 * TabStash – Popup (quick launcher)
 *
 * Minimal: save all tabs, or open the full management page.
 */

const $ = (sel) => document.querySelector(sel);

document.addEventListener('DOMContentLoaded', () => {
  $('#save-all-btn').addEventListener('click', async () => {
    const btn = $('#save-all-btn');
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

    const d = new Date();
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const name = `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} \u00b7 ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;

    await TabStashStorage.addCollection(name, saveable);
    showStatus(`Saved ${saveable.length} tab${saveable.length !== 1 ? 's' : ''}`);
    btn.disabled = false;
  });

  $('#open-btn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'openFullPage' });
    window.close();
  });
});

function showStatus(msg) {
  const el = $('#status');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 2000);
}
