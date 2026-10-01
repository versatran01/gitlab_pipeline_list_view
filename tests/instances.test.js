// Tests for instances.js against a fake chrome.* API. Run with: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Load instances.js like a classic script with `chrome` = a fake that
// records registrations.
function load({ instances, registered, permitted = () => true }) {
  const scripts = new Map(registered.map(s => [s.id, s]));
  const calls = [];
  const chrome = {
    storage: { local: { get: async () => ({ glpv_instances: instances }) } },
    permissions: { contains: async ({ origins }) => permitted(origins[0]) },
    scripting: {
      getRegisteredContentScripts: async () => [...scripts.values()],
      registerContentScripts: async ss => {
        calls.push(['register', [...ss].map(s => s.id)]);
        ss.forEach(s => scripts.set(s.id, s));
      },
      updateContentScripts: async ss => {
        calls.push(['update', [...ss].map(s => s.id)]);
        ss.forEach(s => scripts.set(s.id, s));
      },
      unregisterContentScripts: async ({ ids }) => {
        calls.push(['unregister', [...ids]]);
        ids.forEach(id => scripts.delete(id));
      },
    },
  };
  const ctx = vm.createContext({ chrome, console });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../instances.js'), 'utf8'), ctx);
  return { ctx, scripts, calls };
}

test('syncInstanceScripts registers, updates outdated, and drops removed', async () => {
  const a = 'https://a.example';
  const b = 'https://b.example';
  const { ctx } = load({ instances: [], registered: [] });
  const outdated = { ...ctx.instanceScript(a), matches: ['https://a.example/old/*'] };
  const gone = ctx.instanceScript('https://gone.example');
  const other = { id: 'not_ours', matches: ['https://x/*'] };

  const { ctx: c, scripts, calls } = load({
    instances: [a, b], registered: [outdated, gone, other],
  });
  await c.syncInstanceScripts();

  assert.deepEqual(calls, [
    ['update', [c.scriptId(a)]],
    ['register', [c.scriptId(b)]],
    ['unregister', [c.scriptId('https://gone.example')]],
  ]);
  assert.deepEqual([...scripts.get(c.scriptId(a)).matches], [`${a}/*/-/pipelines/*`]);
  assert.ok(scripts.has('not_ours'), "other scripts aren't touched");
});

test('syncInstanceScripts leaves up-to-date and unpermitted instances alone', async () => {
  const a = 'https://a.example';
  const { ctx } = load({ instances: [], registered: [] });
  const { ctx: c, calls } = load({
    instances: [a, 'https://revoked.example'],
    registered: [ctx.instanceScript(a)],
    permitted: origin => !origin.includes('revoked'),
  });
  await c.syncInstanceScripts();
  assert.deepEqual(calls, []);
});
