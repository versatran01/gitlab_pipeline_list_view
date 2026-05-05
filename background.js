/* global chrome */
const INSTANCES_KEY = 'glpv_instances';

function scriptId(origin) {
  return 'glpv_inst_' + origin.replace(/https?:\/\//, '').replace(/[^a-zA-Z0-9]/g, '_');
}

async function reregisterAll() {
  const data = await chrome.storage.local.get(INSTANCES_KEY);
  const instances = data[INSTANCES_KEY] || [];
  if (!instances.length) return;

  const existing = await chrome.scripting.getRegisteredContentScripts();
  const existingIds = new Set(existing.map(s => s.id));

  for (const origin of instances) {
    const id = scriptId(origin);
    if (existingIds.has(id)) continue;
    await chrome.scripting.registerContentScripts([{
      id,
      matches: [`${origin}/*/-/pipelines/*`],
      js: ['content.js'],
      css: ['styles.css'],
      runAt: 'document_idle',
    }]).catch(err => console.error('[GLPV] Failed to register', origin, err));
  }
}

chrome.runtime.onInstalled.addListener(reregisterAll);
chrome.runtime.onStartup.addListener(reregisterAll);
