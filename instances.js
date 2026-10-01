/* global chrome */
// Content-script registration for self-hosted GitLab instances. Shared by
// background.js (importScripts) and options.js (<script>), so both register
// the same thing.

const INSTANCES_KEY = 'glpv_instances';

function scriptId(origin) {
  return 'glpv_inst_' + origin.replace(/https?:\/\//, '').replace(/[^a-zA-Z0-9]/g, '_');
}

// What gets registered for `origin`. Change this and the next extension
// update/browser start re-syncs every saved instance (see syncInstanceScripts).
function instanceScript(origin) {
  return {
    id: scriptId(origin),
    matches: [`${origin}/*/-/pipelines/*`],
    js: ['content.js'],
    css: ['styles.css'],
    runAt: 'document_idle',
  };
}

function sameRegistration(a, b) {
  const pick = s => JSON.stringify([s.matches, s.js, s.css, s.runAt]);
  return pick(a) === pick(b);
}

// Make the registered scripts match the saved instances: register missing
// ones, update ones registered by an older version (registrations persist
// across updates), and drop ones for instances that were removed.
async function syncInstanceScripts() {
  const data = await chrome.storage.local.get(INSTANCES_KEY);
  const instances = data[INSTANCES_KEY] || [];
  const registered = new Map(
    (await chrome.scripting.getRegisteredContentScripts())
      .filter(s => s.id.startsWith('glpv_inst_'))
      .map(s => [s.id, s])
  );

  for (const origin of instances) {
    const want = instanceScript(origin);
    const have = registered.get(want.id);
    registered.delete(want.id);
    try {
      if (!have) {
        // Skip instances whose host permission was revoked in chrome://extensions.
        if (!await chrome.permissions.contains({ origins: [`${origin}/*`] })) continue;
        await chrome.scripting.registerContentScripts([want]);
      } else if (!sameRegistration(have, want)) {
        await chrome.scripting.updateContentScripts([want]);
      }
    } catch (err) {
      console.error('[GLPV] Failed to register', origin, err);
    }
  }

  const stale = [...registered.keys()];
  if (stale.length) {
    await chrome.scripting.unregisterContentScripts({ ids: stale })
      .catch(err => console.error('[GLPV] Failed to unregister', stale, err));
  }
}
