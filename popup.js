/* global chrome */
const STORAGE_KEY = 'glpv_auto_list_view';
const AUTO_EXPAND_KEY = 'glpv_auto_expand';
const checkbox = document.getElementById('auto-switch');
const autoExpandCheckbox = document.getElementById('auto-expand');

chrome.storage.local.get([STORAGE_KEY, AUTO_EXPAND_KEY]).then(result => {
  checkbox.checked = !!result[STORAGE_KEY];
  autoExpandCheckbox.checked = !!result[AUTO_EXPAND_KEY];
});

checkbox.addEventListener('change', () => {
  chrome.storage.local.set({ [STORAGE_KEY]: checkbox.checked });
});

autoExpandCheckbox.addEventListener('change', () => {
  chrome.storage.local.set({ [AUTO_EXPAND_KEY]: autoExpandCheckbox.checked });
});

document.getElementById('open-settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});
