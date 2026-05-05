/* global chrome */
const STORAGE_KEY = 'glpv_auto_list_view';
const checkbox = document.getElementById('auto-switch');

chrome.storage.local.get(STORAGE_KEY).then(result => {
  checkbox.checked = !!result[STORAGE_KEY];
});

checkbox.addEventListener('change', () => {
  chrome.storage.local.set({ [STORAGE_KEY]: checkbox.checked });
});

document.getElementById('open-settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});
