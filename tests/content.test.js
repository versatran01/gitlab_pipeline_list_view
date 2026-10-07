// Unit tests for the pure helpers in content.js. Run with: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  formatDuration, formatFailureReason, retryDelay, latestAttempts,
  stageStatus, buildStageMap, rowMatchesFilter, filterActive,
  mapLimit, fetchPaged, loadDownstream, jobTiming, pipelineTiming,
  defaultCollapsed, logTail, limiter,
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

test('buildStageMap keeps a fully retried stage in place', () => {
  const all = [
    { id: 1, name: 'build', stage: 'build' },
    { id: 2, name: 'test', stage: 'test' },
    { id: 3, name: 'deploy', stage: 'deploy' },
    { id: 4, name: 'test', stage: 'test' }, // retry of `test`
  ];
  const map = buildStageMap(latestAttempts(all), [], all);
  assert.deepEqual([...map.keys()], ['build', 'test', 'deploy']);
  assert.equal(map.get('test')[0].id, 4);
});

test('rowMatchesFilter / filterActive', () => {
  const row = { name: 'rspec unit 1/4', status: 'failed' };
  const f = (text, ...statuses) => ({ text, statuses: new Set(statuses) });

  assert.equal(filterActive(f('')), false);
  assert.equal(filterActive(f('  ')), false);
  assert.equal(filterActive(f('', 'failed')), true);

  assert.equal(rowMatchesFilter(row, f('')), true);
  assert.equal(rowMatchesFilter(row, f('  RSpec ')), true);
  assert.equal(rowMatchesFilter(row, f('lint')), false);
  assert.equal(rowMatchesFilter(row, f('unit', 'failed')), true);
  assert.equal(rowMatchesFilter({ ...row, status: 'success' }, f('', 'failed')), false);
  // A trigger job counts as failed when its downstream pipeline failed.
  assert.equal(
    rowMatchesFilter({ name: 'deploy', status: 'success', dsStatus: 'failed' }, f('', 'failed')),
    true,
  );

  // "Running" also covers queued jobs; selected groups are OR-combined.
  assert.equal(rowMatchesFilter({ ...row, status: 'pending' }, f('', 'running')), true);
  assert.equal(rowMatchesFilter({ ...row, status: 'manual' }, f('', 'running')), false);
  assert.equal(rowMatchesFilter(row, f('', 'running')), false);
  assert.equal(rowMatchesFilter(row, f('', 'failed', 'running')), true);
  assert.equal(rowMatchesFilter({ ...row, status: 'running' }, f('', 'failed', 'running')), true);
  assert.equal(rowMatchesFilter({ ...row, status: 'success' }, f('', 'failed', 'running')), false);
  assert.equal(
    rowMatchesFilter({ name: 'deploy', status: 'running', dsStatus: 'running' }, f('lint', 'running')),
    false,
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

test('jobTiming', () => {
  const now = Date.parse('2026-01-01T00:10:00Z');
  assert.deepEqual(jobTiming({ status: 'running', duration: 42 }, now),
    { seconds: 42, prefix: '', live: true });
  assert.deepEqual(jobTiming({ status: 'running', started_at: '2026-01-01T00:08:00Z' }, now),
    { seconds: 120, prefix: '', live: true });
  assert.equal(jobTiming({ status: 'running' }, now).live, false);
  assert.deepEqual(jobTiming({ status: 'pending', queued_duration: 7.5 }, now),
    { seconds: 7.5, prefix: 'queued ', live: true });
  assert.deepEqual(jobTiming({ status: 'pending' }, now),
    { seconds: undefined, prefix: '', live: false });
  assert.deepEqual(jobTiming({ status: 'success', duration: 90, queued_duration: 3 }, now),
    { seconds: 90, prefix: '', live: false });
});

test('pipelineTiming', () => {
  const now = Date.parse('2026-01-01T00:10:00Z');
  assert.deepEqual(pipelineTiming({ status: 'running', started_at: '2026-01-01T00:05:00Z' }, now),
    { seconds: 300, prefix: '', live: true });
  assert.equal(pipelineTiming({ status: 'pending' }, now), null);
  assert.deepEqual(pipelineTiming({ status: 'success', duration: 61 }, now),
    { seconds: 61, prefix: '', live: false });
  assert.equal(pipelineTiming({ status: 'canceled', duration: null }, now), null);
});

test('defaultCollapsed collapses passed stages only when something failed', () => {
  assert.deepEqual(defaultCollapsed(['success', 'success']), [false, false]);
  assert.deepEqual(defaultCollapsed(['success', 'failed', 'skipped', 'success']),
    [true, false, false, true]);
  assert.deepEqual(defaultCollapsed(['success', 'running']), [false, false]);
  assert.deepEqual(defaultCollapsed([]), []);
});

test('logTail strips ANSI codes and section markers, keeps the last lines', () => {
  const raw = [
    '\x1b[0KRunning with gitlab-runner 17.0',
    'section_start:1700000000:step_script\r\x1b[0K\x1b[36;1mExecuting "step_script"\x1b[0;m',
    '$ npm test',
    'Downloading 10%\rDownloading 50%\rDownloading 100%',
    '\x1b[31;1mERROR: 3 tests failed\x1b[0;m',
    'section_end:1700000099:step_script\r\x1b[0K',
    '',
    '',
  ].join('\n');
  assert.equal(logTail(raw, 100), [
    'Running with gitlab-runner 17.0',
    'Executing "step_script"',
    '$ npm test',
    'Downloading 100%',
    'ERROR: 3 tests failed',
  ].join('\n'));
  assert.equal(logTail(raw, 2), 'Downloading 100%\nERROR: 3 tests failed');
  assert.equal(logTail('line\r\n', 5), 'line');
  assert.equal(logTail('', 5), '');
});

test('logTail only looks at the end of a huge log', () => {
  const raw = 'x'.repeat(1024 * 1024) + '\npartial-line-' + 'y'.repeat(300 * 1024) +
    '\n' + 'last line\n';
  assert.equal(logTail(raw, 5), 'last line');
});

test('limiter caps concurrent calls and passes results/errors through', async () => {
  const run = limiter(2);
  let inFlight = 0;
  let peak = 0;
  const task = n => run(async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise(r => setTimeout(r, 5));
    inFlight--;
    if (n === 3) throw new Error('boom');
    return n;
  });
  const results = await Promise.allSettled([1, 2, 3, 4, 5].map(task));
  assert.equal(peak, 2);
  assert.deepEqual(results.map(r => r.value ?? r.reason.message), [1, 2, 'boom', 4, 5]);
});
