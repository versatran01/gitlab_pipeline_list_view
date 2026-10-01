// Unit tests for the pure helpers in content.js. Run with: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  formatDuration, formatFailureReason, retryDelay, latestAttempts,
  stageStatus, buildStageMap, rowMatchesFilter, filterActive,
  mapLimit, fetchPaged, loadDownstream,
} = require('../content.js');

test('formatDuration', () => {
  assert.equal(formatDuration(null), '-');
  assert.equal(formatDuration(0), '-');
  assert.equal(formatDuration(42.7), '42s');
  assert.equal(formatDuration(125), '2m 5s');
  assert.equal(formatDuration(3 * 3600 + 120), '3h 2m');
});

test('formatFailureReason', () => {
  assert.equal(formatFailureReason('script_failure'), 'script failure');
  assert.equal(formatFailureReason('stuck_or_timeout_failure'), 'stuck or timeout failure');
});

test('retryDelay honours Retry-After, else backs off, capped', () => {
  const res = after => ({ headers: { get: () => after } });
  assert.equal(retryDelay(null, 0), 500);
  assert.equal(retryDelay(null, 2), 2000);
  assert.equal(retryDelay(null, 10), 10000);
  assert.equal(retryDelay(res('3'), 0), 3000);
  assert.equal(retryDelay(res('60'), 0), 10000);
  assert.equal(retryDelay(res(null), 1), 1000);
});

test('latestAttempts keeps the newest attempt per name and counts attempts', () => {
  const jobs = latestAttempts([
    { id: 5, name: 'test', status: 'failed' },
    { id: 9, name: 'test', status: 'success' },
    { id: 7, name: 'test', status: 'failed' },
    { id: 6, name: 'lint', status: 'success' },
  ]);
  const test = jobs.find(j => j.name === 'test');
  assert.equal(test.id, 9);
  assert.equal(test.status, 'success');
  assert.equal(test._attempts, 3);
  assert.equal(jobs.find(j => j.name === 'lint')._attempts, 1);
});

test('stageStatus rollup', () => {
  const st = (...s) => stageStatus(s.map(status => ({ status })));
  assert.equal(st('success', 'failed', 'running'), 'failed');
  assert.equal(st('success', 'running'), 'running');
  assert.equal(st('success', 'preparing'), 'running');
  assert.equal(st('success', 'success'), 'success');
  assert.equal(st('skipped', 'canceled'), 'skipped');
  assert.equal(st('success', 'canceled'), 'canceled');
  assert.equal(st('success', 'manual'), 'manual');
  assert.equal(st('success', 'created'), 'pending');
});

test('buildStageMap orders stages by lowest id and merges bridges', () => {
  const map = buildStageMap(
    [{ id: 30, stage: 'deploy' }, { id: 12, stage: 'build' }, { id: 10, stage: 'build' }],
    [{ id: 20, stage: 'trigger' }, { id: 11, stage: 'build' }],
  );
  assert.deepEqual([...map.keys()], ['build', 'trigger', 'deploy']);
  assert.deepEqual(map.get('build').map(j => j.id), [10, 11, 12]);
  assert.equal(map.get('build')[1]._isBridge, true);
  assert.equal(map.get('build')[0]._isBridge, undefined);
});

test('rowMatchesFilter / filterActive', () => {
  const row = { name: 'rspec unit 1/4', status: 'failed' };
  const f = (text, failedOnly = false) => ({ text, failedOnly });

  assert.equal(filterActive(f('')), false);
  assert.equal(filterActive(f('  ')), false);
  assert.equal(filterActive(f('', true)), true);

  assert.equal(rowMatchesFilter(row, f('')), true);
  assert.equal(rowMatchesFilter(row, f('  RSpec ')), true);
  assert.equal(rowMatchesFilter(row, f('lint')), false);
  assert.equal(rowMatchesFilter(row, f('unit', true)), true);
  assert.equal(rowMatchesFilter({ ...row, status: 'success' }, f('', true)), false);
  // A trigger job counts as failed when its downstream pipeline failed.
  assert.equal(
    rowMatchesFilter({ name: 'deploy', status: 'success', dsStatus: 'failed' }, f('', true)),
    true,
  );
});

test('mapLimit keeps order and caps concurrency', async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await mapLimit([30, 10, 20, 5, 15], 2, async n => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise(r => setTimeout(r, n));
    inFlight--;
    return n * 2;
  });
  assert.deepEqual(out, [60, 20, 40, 10, 30]);
  assert.equal(peak, 2);
  assert.deepEqual(await mapLimit([], 4, async n => n), []);
});

// Stub fetch with a fake paged API: `pages` arrays, optional headers per page.
function fakeApi(pages, headers) {
  const calls = [];
  globalThis.fetch = async url => {
    calls.push(url);
    const page = Number(new URL(url).searchParams.get('page'));
    const h = headers(page, pages.length);
    return {
      ok: true,
      json: async () => pages[page - 1] || [],
      headers: { get: k => h[k] ?? null },
    };
  };
  return calls;
}

test('fetchPaged fetches all pages from X-Total-Pages, in order', async () => {
  const calls = fakeApi([[1, 2], [3, 4], [5]], (_, total) => ({ 'X-Total-Pages': String(total) }));
  assert.deepEqual(await fetchPaged('https://gl.test/api/x?a=1'), [1, 2, 3, 4, 5]);
  assert.equal(calls.length, 3);
  assert.match(calls[0], /\?a=1&per_page=100&page=1$/);
});

test('fetchPaged follows X-Next-Page when X-Total-Pages is missing', async () => {
  const calls = fakeApi([[1], [2], [3]], (page, total) =>
    (page < total ? { 'X-Next-Page': String(page + 1) } : { 'X-Next-Page': '' }));
  assert.deepEqual(await fetchPaged('https://gl.test/api/x'), [1, 2, 3]);
  assert.equal(calls.length, 3);
});

test('loadDownstream caches finished pipelines only', async () => {
  let pipelineStatus = 'success';
  let calls = 0;
  globalThis.fetch = async url => {
    calls++;
    const body = /\/jobs|\/bridges/.test(url) ? [] : { id: 1, status: pipelineStatus };
    return { ok: true, json: async () => body, headers: { get: () => '1' } };
  };
  const ds = { id: 1, project_id: 2, web_url: 'https://gl.test/a/-/pipelines/1',
    status: 'success', updated_at: 't1' };

  await loadDownstream('https://gl.test', ds);
  await loadDownstream('https://gl.test', ds);
  assert.equal(calls, 3, 'second load served from cache');

  await loadDownstream('https://gl.test', { ...ds, updated_at: 't2' });
  assert.equal(calls, 6, 'a changed updated_at misses the cache');

  const running = { ...ds, id: 3, web_url: 'https://gl.test/a/-/pipelines/3', status: 'running' };
  await loadDownstream('https://gl.test', running);
  await loadDownstream('https://gl.test', running);
  assert.equal(calls, 12, 'active pipelines are never cached');

  pipelineStatus = 'running'; // bridge says finished but pipeline restarted
  const stale = { ...ds, id: 4, web_url: 'https://gl.test/a/-/pipelines/4' };
  await loadDownstream('https://gl.test', stale);
  await loadDownstream('https://gl.test', stale);
  assert.equal(calls, 18);
});
