/* global chrome */
const INSTANCES_KEY = 'glpv_instances';

function scriptId(origin) {
  return 'glpv_inst_' + origin.replace(/https?:\/\//, '').replace(/[^a-zA-Z0-9]/g, '_');
}

async function getInstances() {
  const data = await chrome.storage.local.get(INSTANCES_KEY);
  return data[INSTANCES_KEY] || [];
}

function setStatus(msg, isError = false) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = isError ? 'status error' : 'status';
}

async function renderList() {
  const instances = await getInstances();
  const list = document.getElementById('instance-list');
  list.querySelectorAll('.added').forEach(el => el.remove());

  for (const origin of instances) {
    const li = document.createElement('li');
    li.className = 'added';

    const originSpan = document.createElement('span');
    originSpan.className = 'origin';
    originSpan.textContent = origin;
    li.appendChild(originSpan);

    const removeBtn = document.createElement('button');
    removeBtn.textContent = 'Remove';
    removeBtn.className = 'btn-remove';
    removeBtn.addEventListener('click', () => removeInstance(origin));
    li.appendChild(removeBtn);

    list.appendChild(li);
  }
}

async function addInstance() {
  const input = document.getElementById('url-input');
  const raw = input.value.trim();
  if (!raw) return;

  let origin;
  try {
    origin = new URL(raw).origin;
  } catch {
    setStatus('Invalid URL. Enter a full URL like https://gitlab.example.com', true);
    return;
  }

  if (origin === 'https://gitlab.com') {
    setStatus('gitlab.com is already supported out of the box.', true);
    return;
  }

  const instances = await getInstances();
  if (instances.includes(origin)) {
    setStatus(`${origin} is already added.`, true);
    return;
  }

  // chrome.permissions.request() must be called in a user-gesture context (button click)
  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
  if (!granted) {
    setStatus('Permission denied. Instance not added.', true);
    return;
  }

  try {
    await chrome.scripting.registerContentScripts([{
      id: scriptId(origin),
      matches: [`${origin}/*/-/pipelines/*`],
      js: ['content.js'],
      css: ['styles.css'],
      runAt: 'document_idle',
    }]);
  } catch (err) {
    if (!err.message?.includes('already registered')) {
      setStatus(`Failed to register content script: ${err.message}`, true);
      return;
    }
  }

  instances.push(origin);
  await chrome.storage.local.set({ [INSTANCES_KEY]: instances });

  input.value = '';
  setStatus(`Added ${origin}`);
  renderList();
}

async function removeInstance(origin) {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [scriptId(origin)] });
  } catch (err) {
    console.error('[GLPV] unregister failed:', err);
  }

  await chrome.permissions.remove({ origins: [`${origin}/*`] }).catch(console.error);

  const instances = await getInstances();
  await chrome.storage.local.set({
    [INSTANCES_KEY]: instances.filter(i => i !== origin),
  });

  setStatus(`Removed ${origin}`);
  renderList();
}

document.getElementById('add-btn').addEventListener('click', addInstance);
document.getElementById('url-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') addInstance();
});

renderList();
