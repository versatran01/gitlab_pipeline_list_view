/* global chrome */
(function () {
  'use strict';

  const STORAGE_KEY = 'glpv_auto_list_view';
  const AUTO_EXPAND_KEY = 'glpv_auto_expand';

  // While the pipeline is in one of these states the list view re-fetches
  // itself every REFRESH_MS (paused while the tab is hidden).
  const ACTIVE_STATUSES = new Set([
    'created', 'waiting_for_resource', 'preparing', 'pending', 'running',
    'scheduled', 'canceling',
  ]);
  const REFRESH_MS = 20000;
  // Delay before refreshing after a play/retry, so the new job shows up.
  const ACTION_REFRESH_MS = 2000;

  // GET retries for transient failures (network errors, rate limits, 5xx).
  const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
  const MAX_GET_RETRIES = 3;
  const MAX_RETRY_DELAY_MS = 10000;

  let expandAllActive = false;

  // Auto-refresh bookkeeping. `refreshSeq` is bumped on navigation so an
  // in-flight refresh for the previous pipeline is dropped.
  const refresh = {
    timer: null,
    ticker: null,
    seq: 0,
    inFlight: false,
    pendingWhileHidden: false,
    lastStatus: null,
  };

  // Expand button → its async (un)expand function; lets a refresh re-open
  // downstream pipelines and wait for them to load.
  const expanders = new WeakMap();

  const state = {
    pipelineId: null,
    projectPath: null,
    baseUrl: null,
    isListViewActive: false,
    graphContainer: null,
    toggleBtn: null,
    observer: null,
  };

  // ── URL parsing ──────────────────────────────────────────────────────────

  function getPageInfo() {
    const match = window.location.pathname.match(/^(.*?)\/-\/pipelines\/(\d+)(\/.*)?$/);
    if (!match) return null;
    return {
      projectPath: match[1].replace(/^\//, ''),
      pipelineId: match[2],
      baseUrl: `${window.location.protocol}//${window.location.host}`,
    };
  }

  // ── Formatting helpers ───────────────────────────────────────────────────

  function formatDuration(seconds) {
    if (seconds == null || seconds <= 0) return '-';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  function formatDate(dateStr) {
    if (!dateStr) return '';
    return new Date(dateStr).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  // GitLab's failure_reason enum ("script_failure") → "script failure".
  function formatFailureReason(reason) {
    return String(reason).replace(/_/g, ' ');
  }

  function escHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function originOf(webUrl) {
    try { return new URL(webUrl).origin; } catch { return state.baseUrl; }
  }

  function projectPathOf(webUrl) {
    try {
      return new URL(webUrl).pathname.split('/-/')[0].replace(/^\//, '');
    } catch { return ''; }
  }

  // ── Status config ────────────────────────────────────────────────────────

  const STATUS_CFG = {
    success:              { icon: '✓', label: 'passed' },
    failed:               { icon: '✗', label: 'failed' },
    running:              { icon: '↻', label: 'running' },
    pending:              { icon: '●', label: 'pending' },
    canceled:             { icon: '⊘', label: 'canceled' },
    canceling:            { icon: '⊘', label: 'canceling' },
    skipped:              { icon: '→', label: 'skipped' },
    manual:               { icon: '▶', label: 'manual' },
    scheduled:            { icon: '⏰', label: 'scheduled' },
    created:              { icon: '○', label: 'created' },
    waiting_for_resource: { icon: '⏳', label: 'waiting' },
    preparing:            { icon: '↻', label: 'preparing' },
    blocked:              { icon: '⊘', label: 'blocked' },
  };

  function statusCfg(status) {
    return STATUS_CFG[status] || { icon: '?', label: status || 'unknown' };
  }

  // ── API ──────────────────────────────────────────────────────────────────

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  // Wait before retry `attempt` (0-based): Retry-After when the server sends
  // one, otherwise 0.5s, 1s, 2s…, capped at MAX_RETRY_DELAY_MS.
  function retryDelay(res, attempt) {
    const after = parseFloat(res?.headers.get('Retry-After'));
    const ms = Number.isFinite(after) ? after * 1000 : 500 * 2 ** attempt;
    return Math.min(ms, MAX_RETRY_DELAY_MS);
  }

  // GET with retries on transient failures. Only used for reads — play and
  // retry POSTs are never repeated automatically.
  async function apiFetch(url) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(url, { credentials: 'include' });
      } catch (err) {
        if (attempt >= MAX_GET_RETRIES) throw err;
        await sleep(retryDelay(null, attempt));
        continue;
      }
      if (res.ok) return res;
      if (RETRY_STATUSES.has(res.status) && attempt < MAX_GET_RETRIES) {
        await sleep(retryDelay(res, attempt));
        continue;
      }
      const text = await res.text().catch(() => '');
      throw new Error(`GitLab API ${res.status}: ${text || res.statusText}`);
    }
  }

  function projApiBase(baseUrl, identifier) {
    return `${baseUrl}/api/v4/projects/${encodeURIComponent(String(identifier))}`;
  }

  async function fetchPipeline(baseUrl, proj, id) {
    const res = await apiFetch(`${projApiBase(baseUrl, proj)}/pipelines/${id}`);
    return res.json();
  }

  async function fetchPaged(url) {
    const sep = url.includes('?') ? '&' : '?';
    let page = 1;
    let all = [];
    while (true) {
      const res = await apiFetch(`${url}${sep}per_page=100&page=${page}`);
      const items = await res.json();
      if (!Array.isArray(items) || items.length === 0) break;
      all = all.concat(items);
      const total = parseInt(res.headers.get('X-Total-Pages') || '1', 10);
      if (page >= total) break;
      page++;
    }
    return all;
  }

  async function fetchAllJobs(baseUrl, proj, id) {
    return fetchPaged(`${projApiBase(baseUrl, proj)}/pipelines/${id}/jobs?include_retried=true`);
  }

  // Bridges are trigger jobs that spawn downstream pipelines.
  // The /bridges endpoint returns them with a downstream_pipeline field.
  async function fetchAllBridges(baseUrl, proj, id) {
    return fetchPaged(`${projApiBase(baseUrl, proj)}/pipelines/${id}/bridges`);
  }

  // POST to the API with the session cookie + GitLab's CSRF token.
  async function apiPost(url) {
    const token = document.querySelector('meta[name="csrf-token"]')?.content;
    const headers = {};
    if (token) headers['X-CSRF-Token'] = token;

    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers,
    });

    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.message || `${res.status} ${res.statusText}`);
    }
    return res.json();
  }

  // Play (`action` = 'play'), retry ('retry') or cancel ('cancel') a job.
  // Uses project_id from the embedded pipeline object when available (most
  // reliable), falls back to parsing the job's web_url.
  function jobAction(job, action) {
    const base = originOf(job.web_url);
    const proj = job.pipeline?.project_id ?? projectPathOf(job.web_url);
    return apiPost(`${projApiBase(base, proj)}/jobs/${job.id}/${action}`);
  }

  // Retry every failed/canceled job of one pipeline (`action` = 'retry',
  // GitLab's "Retry" button) or cancel it ('cancel').
  function pipelineAction(baseUrl, proj, pipelineId, action) {
    return apiPost(`${projApiBase(baseUrl, proj)}/pipelines/${pipelineId}/${action}`);
  }

  function setRowPending(tr) {
    tr.className = tr.className.replace(/\bglpv-status-\S+/, 'glpv-status-pending');
  }

  function pendingIcon() {
    const pc = statusCfg('pending');
    const icon = document.createElement('span');
    icon.className = 'glpv-job-icon glpv-status-pending';
    icon.title = pc.label;
    icon.textContent = pc.icon;
    return icon;
  }

  // Replace the static manual icon in statusCell with a clickable play button.
  // On success the button is swapped for a pending icon; on failure it flashes
  // red and restores itself so the user can retry.
  function attachPlayBtn(statusCell, job, tr) {
    const btn = document.createElement('button');
    btn.className = 'glpv-play-btn';
    btn.title = 'Run this job';
    btn.textContent = '▶';

    const existing = statusCell.querySelector('.glpv-job-icon');
    if (existing) existing.replaceWith(btn); else statusCell.appendChild(btn);

    btn.addEventListener('click', async e => {
      e.preventDefault();
      e.stopPropagation();

      btn.disabled = true;
      btn.textContent = '↻';
      btn.classList.add('glpv-play-btn--loading');

      try {
        await jobAction(job, 'play');
        btn.replaceWith(pendingIcon());
        setRowPending(tr);
        requestRefresh(ACTION_REFRESH_MS);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = '▶';
        btn.classList.remove('glpv-play-btn--loading');
        btn.classList.add('glpv-play-btn--error');
        btn.title = `Failed to trigger: ${err.message}`;
        setTimeout(() => {
          btn.classList.remove('glpv-play-btn--error');
          btn.title = 'Run this job';
        }, 4000);
        console.error('[GitLab Pipeline List View] play job failed:', err);
      }
    });
  }

  // Job statuses that offer a Cancel button.
  const CANCELABLE_JOB = new Set([
    'created', 'waiting_for_resource', 'preparing', 'pending', 'running',
  ]);

  const ROW_ACTIONS = {
    retry:  { label: 'Retry',  busy: 'Retrying…',  title: 'Retry this job' },
    cancel: { label: 'Cancel', busy: 'Canceling…', title: 'Cancel this job' },
  };

  // "Retry" / "Cancel" button at the end of a job's name cell. On success
  // the view refreshes to pick up the change (a retried row goes pending
  // right away); on failure the button flashes red and can be clicked again.
  function attachRowActionBtn(nameCell, statusCell, job, tr, action) {
    const cfg = ROW_ACTIONS[action];
    const btn = el('button', 'glpv-retry-btn', cfg.label);
    btn.title = cfg.title;
    nameCell.appendChild(btn);

    btn.addEventListener('click', async e => {
      e.preventDefault();
      e.stopPropagation();

      btn.disabled = true;
      btn.textContent = cfg.busy;
      try {
        await jobAction(job, action);
        btn.remove();
        if (action === 'retry') {
          statusCell.querySelector('.glpv-job-icon')?.replaceWith(pendingIcon());
          setRowPending(tr);
        }
        requestRefresh(ACTION_REFRESH_MS);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = cfg.label;
        btn.classList.add('glpv-retry-btn--error');
        btn.title = `Failed to ${action}: ${err.message}`;
        setTimeout(() => {
          btn.classList.remove('glpv-retry-btn--error');
          btn.title = cfg.title;
        }, 4000);
        console.error(`[GitLab Pipeline List View] ${action} job failed:`, err);
      }
    });
  }

  const PIPELINE_ACTIONS = {
    retry: {
      label: 'Retry failed', busy: 'Retrying…', done: 'Retried ✓',
      title: 'Retry all failed and canceled jobs in this pipeline',
    },
    cancel: {
      label: 'Cancel', busy: 'Canceling…', done: 'Canceled ✓',
      title: 'Cancel this pipeline',
      confirm: 'Cancel this pipeline and all of its running jobs?',
    },
  };

  // Pipeline-level buttons for the root summary bar or a downstream header:
  // "Retry failed" once it ended failed/canceled, "Cancel" while it runs.
  function makePipelineActionBtns(baseUrl, proj, pipeline) {
    const actions = [];
    if (['failed', 'canceled'].includes(pipeline.status)) actions.push('retry');
    if (ACTIVE_STATUSES.has(pipeline.status) && pipeline.status !== 'canceling') {
      actions.push('cancel');
    }

    return actions.map(action => {
      const cfg = PIPELINE_ACTIONS[action];
      const btn = el('button', 'glpv-action-btn', cfg.label);
      btn.title = cfg.title;

      btn.addEventListener('click', async e => {
        e.stopPropagation();
        if (cfg.confirm && !window.confirm(cfg.confirm)) return;
        btn.disabled = true;
        btn.textContent = cfg.busy;
        try {
          await pipelineAction(baseUrl, proj, pipeline.id, action);
          btn.textContent = cfg.done;
          requestRefresh(ACTION_REFRESH_MS);
        } catch (err) {
          btn.disabled = false;
          btn.textContent = cfg.label;
          btn.title = `Failed to ${action}: ${err.message}`;
          btn.classList.add('glpv-action-btn--error');
          console.error(`[GitLab Pipeline List View] ${action} pipeline failed:`, err);
        }
      });
      return btn;
    });
  }

  function attachJobActions(tr, job) {
    const statusCell = tr.querySelector('.glpv-col-status');
    const nameCell = tr.querySelector('.glpv-col-name');
    if (job.status === 'manual') {
      attachPlayBtn(statusCell, job, tr);
    } else if (job._isBridge) {
      // Bridges are retried/canceled through their downstream pipeline.
    } else if (['failed', 'canceled'].includes(job.status)) {
      attachRowActionBtn(nameCell, statusCell, job, tr, 'retry');
    } else if (CANCELABLE_JOB.has(job.status)) {
      attachRowActionBtn(nameCell, statusCell, job, tr, 'cancel');
    }
  }

  // ── Stage status rollup ──────────────────────────────────────────────────

  function stageStatus(jobs) {
    const s = jobs.map(j => j.status);
    if (s.some(x => x === 'failed')) return 'failed';
    if (s.some(x => x === 'running' || x === 'preparing')) return 'running';
    if (s.every(x => x === 'success')) return 'success';
    if (s.every(x => ['skipped', 'canceled'].includes(x))) return 'skipped';
    if (s.some(x => x === 'canceled')) return 'canceled';
    if (s.some(x => x === 'manual')) return 'manual';
    return 'pending';
  }

  // ── Stage map (merges regular jobs + bridges, sorted by ID within stage) ─

  // `include_retried=true` returns every attempt of a retried job as its own
  // entry. Keep only the newest attempt per job name (names are unique within
  // a pipeline, and a retry gets a higher id) so a job that failed and then
  // passed on retry no longer turns its stage red; `_attempts` records how
  // many runs it took.
  function latestAttempts(jobs) {
    const byName = new Map();
    for (const job of jobs) {
      const prev = byName.get(job.name);
      const attempts = (prev?._attempts || 0) + 1;
      const latest = !prev || job.id > prev.id ? job : prev;
      byName.set(job.name, { ...latest, _attempts: attempts });
    }
    return [...byName.values()];
  }

  function buildStageMap(jobs, bridges) {
    const map = new Map();
    for (const job of jobs) {
      const stage = job.stage || 'unknown';
      if (!map.has(stage)) map.set(stage, []);
      map.get(stage).push(job);
    }
    for (const bridge of bridges) {
      const stage = bridge.stage || 'unknown';
      if (!map.has(stage)) map.set(stage, []);
      map.get(stage).push({ ...bridge, _isBridge: true });
    }
    for (const items of map.values()) {
      items.sort((a, b) => a.id - b.id);
    }
    // The API's order isn't the pipeline's stage order (and bridges were
    // appended last); jobs are created stage by stage, so order stages by
    // their lowest id.
    return new Map([...map].sort((a, b) => a[1][0].id - b[1][0].id));
  }

  // ── Downstream expand logic ───────────────────────────────────────────────

  // Downstream pipeline ids currently expanded under `container`.
  function expandedIds(container) {
    if (!container) return new Set();
    return new Set(
      [...container.querySelectorAll('.glpv-expand-btn[aria-expanded="true"]')]
        .map(b => b.dataset.dsId)
    );
  }

  // Expand every collapsed downstream under `container` whose id is in `ids`,
  // resolving once all of them (and their own restored children) loaded.
  function restoreExpanded(container, ids) {
    if (!ids || !ids.size) return Promise.resolve();
    const btns = [...container.querySelectorAll('.glpv-expand-btn[aria-expanded="false"]')]
      .filter(b => ids.has(b.dataset.dsId));
    return Promise.all(btns.map(b => expanders.get(b)?.(true, ids)));
  }

  function setupExpand(btn, expandRow, contentDiv, downstream, depth) {
    let loaded = false;
    btn.dataset.dsId = String(downstream.id);

    // Show/hide the downstream; the first expand loads it. `restoreIds`
    // (from a refresh) re-expands nested downstreams before resolving.
    async function setExpanded(willExpand, restoreIds) {
      btn.setAttribute('aria-expanded', String(willExpand));
      btn.classList.toggle('glpv-expand-btn--open', willExpand);
      expandRow.hidden = !willExpand;

      if (!willExpand || loaded) return;
      loaded = true;

      contentDiv.className = 'glpv-ds-loading';
      contentDiv.textContent = 'Loading downstream pipeline…';

      const dpBase = originOf(downstream.web_url);

      try {
        const [pipeline, djobs, dbridges] = await Promise.all([
          fetchPipeline(dpBase, downstream.project_id, downstream.id),
          fetchAllJobs(dpBase, downstream.project_id, downstream.id),
          fetchAllBridges(dpBase, downstream.project_id, downstream.id),
        ]);

        const projPath = projectPathOf(downstream.web_url) || `Project ${downstream.project_id}`;

        const header = el('div', 'glpv-ds-header');

        const projLink = el('a', 'glpv-ds-proj-link', projPath);
        projLink.href = downstream.web_url;

        let metaText = `Pipeline #${pipeline.id}`;
        if (pipeline.ref) metaText += ` · ${pipeline.ref}`;
        if (pipeline.duration) metaText += ` · ${formatDuration(pipeline.duration)}`;

        header.appendChild(statusBadge(pipeline.status));
        header.appendChild(projLink);
        header.appendChild(el('span', 'glpv-ds-meta', metaText));
        header.append(...makePipelineActionBtns(dpBase, downstream.project_id, pipeline));

        const nested = buildListView(pipeline, djobs, dbridges, depth + 1);

        contentDiv.className = 'glpv-ds-inner';
        contentDiv.innerHTML = '';
        contentDiv.appendChild(header);
        contentDiv.appendChild(nested);
        applyFilter(btn.closest('#glpv-root'));

        // Re-open what was open before a refresh first, so it's loaded
        // before the refreshed view replaces the old one.
        await restoreExpanded(nested, restoreIds);

        // If "Expand All" is active, cascade into any bridges in the nested pipeline
        if (expandAllActive && btn.getAttribute('aria-expanded') === 'true') {
          nested.querySelectorAll('.glpv-expand-btn[aria-expanded="false"]')
            .forEach(b => b.click());
        }
      } catch (err) {
        contentDiv.className = 'glpv-ds-error';
        contentDiv.innerHTML =
          `<strong>Failed to load downstream pipeline.</strong><br>${escHtml(err.message)}`;
        const retry = document.createElement('button');
        retry.className = 'glpv-action-btn glpv-error-retry';
        retry.textContent = 'Retry';
        retry.addEventListener('click', () => setExpanded(true));
        contentDiv.appendChild(retry);
        console.error('[GitLab Pipeline List View]', err);
        loaded = false; // allow retry (button above, or on next expand)
      }
    }

    expanders.set(btn, setExpanded);
    btn.addEventListener('click', () =>
      setExpanded(btn.getAttribute('aria-expanded') !== 'true'));
  }

  // ── Job row (regular job or trigger job + expandable downstream) ─────────

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function statusBadge(status) {
    const sc = statusCfg(status);
    const badge = el('span', `glpv-badge glpv-status-${status}`);
    badge.appendChild(el('span', 'glpv-icon', sc.icon));
    badge.appendChild(document.createTextNode(sc.label));
    return badge;
  }

  function addJobRow(tbody, job, depth) {
    const jc = statusCfg(job.status);
    // Only bridges have one; null until the downstream pipeline is triggered.
    const dp = job._isBridge ? job.downstream_pipeline : null;

    const tr = el('tr', `glpv-job-row glpv-status-${job.status}`);
    if (job._isBridge) tr.classList.add('glpv-bridge-job');
    tr.dataset.name = String(job.name).toLowerCase();
    tr.dataset.status = job.status;
    if (dp) tr.dataset.dsStatus = dp.status;

    const tdStatus = el('td', 'glpv-col-status');
    const icon = el('span', `glpv-job-icon glpv-status-${job.status}`, jc.icon);
    icon.title = jc.label;
    tdStatus.appendChild(icon);

    const tdName = el('td', 'glpv-col-name');

    let expandBtn = null;
    if (dp) {
      expandBtn = el('button', 'glpv-expand-btn');
      expandBtn.setAttribute('aria-expanded', 'false');
      expandBtn.title = 'Toggle downstream pipeline';
      tdName.appendChild(expandBtn);
    }

    const jobLink = el('a', 'glpv-job-link', job.name);
    jobLink.href = job.web_url;
    tdName.appendChild(jobLink);

    if (job.allow_failure) {
      tdName.appendChild(el('span', 'glpv-badge-optional', 'optional'));
    }
    if (job._attempts > 1) {
      const att = el('span', 'glpv-badge-optional', `${job._attempts} attempts`);
      att.title = `Showing the latest of ${job._attempts} attempts`;
      tdName.appendChild(att);
    }
    if (job.status === 'failed' && job.failure_reason) {
      const reason = el('span', 'glpv-failure-reason', formatFailureReason(job.failure_reason));
      reason.title = 'Failure reason';
      tdName.appendChild(reason);
    }

    // Inline downstream status badge: "→ [passed] #12"
    if (dp) {
      const dsBadge = el('span', 'glpv-ds-badge');
      const dpLink = el('a', 'glpv-ds-link', `#${dp.id}`);
      dpLink.href = dp.web_url;
      dpLink.title = 'Open downstream pipeline';
      dpLink.addEventListener('click', e => e.stopPropagation());

      dsBadge.appendChild(document.createTextNode('→ '));
      dsBadge.appendChild(statusBadge(dp.status));
      dsBadge.appendChild(document.createTextNode(' '));
      dsBadge.appendChild(dpLink);
      tdName.appendChild(dsBadge);
    }

    tr.appendChild(tdStatus);
    tr.appendChild(tdName);
    tr.appendChild(el('td', 'glpv-col-started', formatDate(job.started_at) || '-'));
    tr.appendChild(el('td', 'glpv-col-duration', formatDuration(job.duration)));
    tr.appendChild(el('td', 'glpv-col-runner',
      job.runner ? (job.runner.description || `#${job.runner.id}`) : '-'));
    attachJobActions(tr, job);
    tbody.appendChild(tr);

    // Expand row (hidden until toggled; first expand lazy-loads the downstream)
    if (dp) {
      const expandRow = el('tr', 'glpv-ds-row');
      expandRow.hidden = true;
      expandRow.appendChild(el('td'));

      const tdContent = el('td', 'glpv-ds-cell');
      tdContent.colSpan = 4;
      const contentDiv = el('div', 'glpv-ds-content');
      tdContent.appendChild(contentDiv);
      expandRow.appendChild(tdContent);
      tbody.appendChild(expandRow);

      setupExpand(expandBtn, expandRow, contentDiv, dp, depth);
    }
  }

  // ── Job filter ────────────────────────────────────────────────────────────

  // Kept across refreshes; reset on navigation.
  const filter = { text: '', failedOnly: false };

  function filterActive(f) {
    return !!f.text.trim() || f.failedOnly;
  }

  // `row` carries a job row's dataset: lowercase name, status and (for
  // trigger jobs) the downstream pipeline's status.
  function rowMatchesFilter(row, f) {
    const needle = f.text.trim().toLowerCase();
    if (needle && !row.name.includes(needle)) return false;
    if (f.failedOnly && row.status !== 'failed' && row.dsStatus !== 'failed') return false;
    return true;
  }

  // Hide the rows (then stages) under `list` that don't match and return how
  // many stayed visible. Loaded downstream lists are filtered too, and a
  // trigger job stays visible while anything below it matches.
  function filterList(list) {
    let visible = 0;
    for (const stage of list.querySelectorAll(':scope > .glpv-stage')) {
      let stageVisible = 0;
      for (const tr of stage.querySelectorAll(':scope > table > tbody > tr.glpv-job-row')) {
        const next = tr.nextElementSibling;
        const dsRow = next?.classList.contains('glpv-ds-row') ? next : null;
        const nested = dsRow?.querySelector('.glpv-pipeline-list');
        const nestedVisible = nested ? filterList(nested) : 0;
        const show = rowMatchesFilter(tr.dataset, filter) || nestedVisible > 0;
        tr.classList.toggle('glpv-filtered', !show);
        dsRow?.classList.toggle('glpv-filtered', !show);
        if (show) stageVisible++;
      }
      stage.classList.toggle('glpv-filtered', stageVisible === 0);
      visible += stageVisible;
    }
    return visible;
  }

  function applyFilter(root) {
    if (!root) return;
    const visible = filterList(root);
    const empty = root.querySelector(':scope > .glpv-filter-empty');
    if (empty) empty.hidden = !filterActive(filter) || visible > 0;
  }

  function buildFilterBar(root) {
    const bar = el('div', 'glpv-filter-bar');

    const input = el('input', 'glpv-filter-input');
    input.type = 'search';
    input.placeholder = 'Filter jobs by name…';
    input.value = filter.text;
    input.addEventListener('input', () => {
      filter.text = input.value;
      applyFilter(root);
    });

    const label = el('label', 'glpv-filter-failed');
    const failedOnly = el('input');
    failedOnly.type = 'checkbox';
    failedOnly.checked = filter.failedOnly;
    failedOnly.addEventListener('change', () => {
      filter.failedOnly = failedOnly.checked;
      applyFilter(root);
    });
    label.append(failedOnly, 'Failed only');

    bar.append(input, label);
    return bar;
  }

  // After a refresh swapped `root` in: the user may have typed while it was
  // built, so re-sync the controls, re-filter, and keep the input's focus.
  function syncFilterBar(root, oldInput) {
    const input = root.querySelector('.glpv-filter-input');
    const failedOnly = root.querySelector('.glpv-filter-failed input');
    if (input) input.value = filter.text;
    if (failedOnly) failedOnly.checked = filter.failedOnly;
    applyFilter(root);
    if (input && oldInput && document.activeElement === document.body) {
      input.focus();
      input.setSelectionRange(oldInput.selectionStart, oldInput.selectionEnd);
    }
  }

  // ── List view builder (used recursively for downstream pipelines) ─────────

  function buildListView(pipeline, jobs, bridges, depth) {
    bridges = bridges || [];
    depth = depth || 0;
    jobs = latestAttempts(jobs || []);

    const stagesMap = buildStageMap(jobs, bridges);
    const totalItems = jobs.length + bridges.length;

    const root = document.createElement('div');
    root.className = 'glpv-pipeline-list';
    if (depth === 0) root.id = 'glpv-root';

    // Summary bar only shown for the root pipeline
    if (depth === 0) {
      const pc = statusCfg(pipeline.status);
      const summary = document.createElement('div');
      summary.className = 'glpv-summary';
      summary.innerHTML = `
        <span class="glpv-badge glpv-status-${escHtml(pipeline.status)}">
          <span class="glpv-icon">${pc.icon}</span>${escHtml(pc.label)}
        </span>
        <span class="glpv-summary-ref">${escHtml(pipeline.ref || '')}</span>
        ${pipeline.started_at
          ? `<span class="glpv-summary-meta">Started ${escHtml(formatDate(pipeline.started_at))}</span>`
          : ''}
        ${pipeline.duration
          ? `<span class="glpv-summary-meta">Duration: ${escHtml(formatDuration(pipeline.duration))}</span>`
          : ''}
        <span class="glpv-summary-meta">${totalItems} job${totalItems !== 1 ? 's' : ''} · ${stagesMap.size} stage${stagesMap.size !== 1 ? 's' : ''}</span>
      `;

      const actions = document.createElement('div');
      actions.className = 'glpv-summary-actions';
      summary.appendChild(actions);

      const updated = document.createElement('span');
      updated.className = 'glpv-summary-meta glpv-updated';
      actions.appendChild(updated);

      const refreshBtn = document.createElement('button');
      refreshBtn.className = 'glpv-action-btn glpv-refresh-btn';
      refreshBtn.textContent = '↻';
      refreshBtn.title = ACTIVE_STATUSES.has(pipeline.status)
        ? `Refresh now (refreshes automatically every ${REFRESH_MS / 1000}s while the pipeline runs)`
        : 'Refresh now';
      refreshBtn.addEventListener('click', () => refreshListView());
      actions.appendChild(refreshBtn);

      actions.append(...makePipelineActionBtns(state.baseUrl, state.projectPath, pipeline));

      if (bridges.length > 0) {
        const expandAllBtn = document.createElement('button');
        expandAllBtn.className = 'glpv-expand-all-btn';
        expandAllBtn.textContent = expandAllActive ? 'Collapse All' : 'Expand All';

        expandAllBtn.addEventListener('click', () => {
          if (expandAllActive) {
            expandAllActive = false;
            expandAllBtn.textContent = 'Expand All';
            root.querySelectorAll('.glpv-expand-btn[aria-expanded="true"]')
              .forEach(b => b.click());
          } else {
            expandAllActive = true;
            expandAllBtn.textContent = 'Collapse All';
            root.querySelectorAll('.glpv-expand-btn[aria-expanded="false"]')
              .forEach(b => b.click());
          }
        });

        actions.appendChild(expandAllBtn);
      }

      root.appendChild(summary);
      root.appendChild(buildFilterBar(root));
    }

    stagesMap.forEach((stageJobs, stageName) => {
      const ss = stageStatus(stageJobs);
      const sc = statusCfg(ss);

      const stageEl = document.createElement('div');
      stageEl.className = 'glpv-stage';

      const header = document.createElement('div');
      header.className = 'glpv-stage-header';
      header.innerHTML = `
        <span class="glpv-stage-dot glpv-status-${escHtml(ss)}" title="${escHtml(sc.label)}"></span>
        <span class="glpv-stage-name">${escHtml(stageName)}</span>
        <span class="glpv-stage-count">${stageJobs.length} job${stageJobs.length !== 1 ? 's' : ''}</span>
      `;
      stageEl.appendChild(header);

      const table = document.createElement('table');
      table.className = 'glpv-jobs-table';
      table.innerHTML = `
        <thead>
          <tr>
            <th class="glpv-col-status"></th>
            <th class="glpv-col-name">Job</th>
            <th class="glpv-col-started">Started</th>
            <th class="glpv-col-duration">Duration</th>
            <th class="glpv-col-runner">Runner</th>
          </tr>
        </thead>
      `;

      const tbody = document.createElement('tbody');

      for (const job of stageJobs) addJobRow(tbody, job, depth);

      table.appendChild(tbody);
      stageEl.appendChild(table);
      root.appendChild(stageEl);
    });

    if (depth === 0) {
      const empty = el('div', 'glpv-filter-empty', 'No jobs match the filter.');
      empty.hidden = true;
      root.appendChild(empty);
    }

    return root;
  }

  // ── DOM selectors ─────────────────────────────────────────────────────────

  function findGraphContainer() {
    const selectors = [
      '#js-pipeline-graph-vue',
      '.js-pipeline-graph-container',
      '.pipeline-graph-container',
      '[data-testid="pipeline-dag-graph"]',
      '[data-testid="pipeline-graph"]',
      '.pipeline-graph',
      '.gl-pipeline-graph',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    const svg = document.querySelector('svg.graph-svg, svg.gl-graph');
    if (svg) return svg.closest('section') || svg.parentElement;
    return null;
  }

  function findButtonHost() {
    const selectors = [
      '[data-testid="pipeline-actions-header"]',
      '.pipeline-header-container',
      '.js-pipeline-header-actions',
      '.pipeline-details-header .gl-display-flex',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  // ── View toggling ─────────────────────────────────────────────────────────

  function showListView(info) {
    state.isListViewActive = true;
    if (state.graphContainer) state.graphContainer.style.display = 'none';
    if (state.toggleBtn) {
      state.toggleBtn.textContent = '⊞ Graph View';
      state.toggleBtn.classList.add('glpv-btn-active');
    }

    const existing = document.getElementById('glpv-root');
    if (existing && !existing.classList.contains('glpv-error')) {
      existing.style.display = '';
      // Still loading, or loaded: reuse it — but catch up if it went stale
      // while the graph was showing.
      const age = Date.now() - Number(existing.dataset.updatedAt || Date.now());
      if (refresh.pendingWhileHidden || age >= REFRESH_MS) {
        refresh.pendingWhileHidden = false;
        refreshListView();
      }
      return;
    }
    // A failed load is never reused — start over.
    existing?.remove();

    const loading = document.createElement('div');
    loading.id = 'glpv-root';
    loading.className = 'glpv-loading';
    loading.textContent = 'Loading pipeline jobs…';
    state.graphContainer.parentElement.insertBefore(loading, state.graphContainer);

    const seq = refresh.seq;
    Promise.all([
      buildRoot(info, null),
      chrome.storage.local.get(AUTO_EXPAND_KEY).catch(() => ({})),
    ])
      .then(([{ root, pipeline, bridges }, autoExpandSaved]) => {
        if (seq !== refresh.seq || !loading.isConnected) return;
        // The user may have switched back to the graph while this loaded.
        root.style.display = loading.style.display;
        loading.replaceWith(root);
        afterRender(pipeline);

        if (autoExpandSaved[AUTO_EXPAND_KEY] && bridges.length > 0) {
          root.querySelector('.glpv-expand-all-btn')?.click();
        }
      })
      .catch(err => {
        if (seq !== refresh.seq) return;
        renderLoadError(loading, err, info);
        console.error('[GitLab Pipeline List View]', err);
      });
  }

  // Turn the loading placeholder into an error box with a Retry button.
  function renderLoadError(box, err, info) {
    box.className = 'glpv-error';
    box.innerHTML =
      `<strong>Failed to load pipeline jobs.</strong><br>${escHtml(err.message)}`;
    const retry = document.createElement('button');
    retry.className = 'glpv-action-btn glpv-error-retry';
    retry.textContent = 'Retry';
    retry.addEventListener('click', () => {
      box.remove();
      showListView(info);
    });
    box.appendChild(retry);
  }

  // ── Auto refresh ──────────────────────────────────────────────────────────

  function currentInfo() {
    if (!state.pipelineId) return null;
    return {
      baseUrl: state.baseUrl,
      projectPath: state.projectPath,
      pipelineId: state.pipelineId,
    };
  }

  // Fetch the pipeline and build a complete list view off-DOM, re-expanding
  // (and loading) the downstream pipelines in `openIds` before resolving —
  // so a refresh swaps in a finished tree instead of flashing "Loading…".
  async function buildRoot(info, openIds) {
    const [pipeline, jobs, bridges] = await Promise.all([
      fetchPipeline(info.baseUrl, info.projectPath, info.pipelineId),
      fetchAllJobs(info.baseUrl, info.projectPath, info.pipelineId),
      fetchAllBridges(info.baseUrl, info.projectPath, info.pipelineId),
    ]);
    const root = buildListView(pipeline, jobs, bridges, 0);
    await restoreExpanded(root, openIds);
    applyFilter(root);
    root.dataset.updatedAt = String(Date.now());
    return { root, pipeline, bridges };
  }

  function afterRender(pipeline) {
    refresh.lastStatus = pipeline.status;
    updateUpdatedLabel();
    if (!refresh.ticker) refresh.ticker = setInterval(updateUpdatedLabel, 5000);
    scheduleRefresh();
  }

  // Next automatic refresh — only while the pipeline can still change.
  function scheduleRefresh() {
    clearTimeout(refresh.timer);
    refresh.timer = null;
    if (!ACTIVE_STATUSES.has(refresh.lastStatus)) return;
    refresh.timer = setTimeout(() => refreshListView({ auto: true }), REFRESH_MS);
  }

  // Refresh soon regardless of status (after a play/retry restarts a
  // finished pipeline).
  function requestRefresh(delay) {
    clearTimeout(refresh.timer);
    refresh.timer = setTimeout(() => refreshListView(), delay);
  }

  function setRefreshing(root, busy) {
    const btn = root.querySelector('.glpv-refresh-btn');
    if (!btn) return;
    btn.disabled = busy;
    btn.classList.toggle('glpv-refresh-btn--busy', busy);
  }

  function updateUpdatedLabel() {
    const root = document.getElementById('glpv-root');
    const label = root?.querySelector('.glpv-updated');
    if (!label || label.classList.contains('glpv-updated--error')) return;
    const secs = Math.floor((Date.now() - Number(root.dataset.updatedAt)) / 1000);
    label.textContent =
      secs < 10 ? 'updated just now'
        : secs < 60 ? `updated ${secs}s ago`
          : `updated ${Math.floor(secs / 60)}m ago`;
  }

  // Re-fetch and swap in a fresh list view, keeping expanded downstreams
  // open. On failure the current view stays and a retry is scheduled.
  async function refreshListView({ auto = false } = {}) {
    clearTimeout(refresh.timer);
    refresh.timer = null;
    const info = currentInfo();
    const current = document.getElementById('glpv-root');
    if (!info || !current || current.classList.contains('glpv-error') ||
        current.classList.contains('glpv-loading')) return;
    if (auto && (document.hidden || !state.isListViewActive)) {
      // Nobody is looking; catch up when they are (visibilitychange /
      // showListView).
      refresh.pendingWhileHidden = true;
      return;
    }
    if (refresh.inFlight) return;
    refresh.inFlight = true;
    const seq = refresh.seq;
    setRefreshing(current, true);
    try {
      const { root, pipeline } = await buildRoot(info, expandedIds(current));
      if (seq !== refresh.seq) return;
      const now = document.getElementById('glpv-root');
      if (!now) return;
      // Anything expanded while the refresh was in flight stays open too.
      const openNow = expandedIds(now);
      const oldInput = now.querySelector('.glpv-filter-input');
      const hadFocus = document.activeElement === oldInput;
      root.style.display = now.style.display;
      now.replaceWith(root);
      syncFilterBar(root, hadFocus ? oldInput : null);
      restoreExpanded(root, openNow);
      afterRender(pipeline);
    } catch (err) {
      if (seq !== refresh.seq) return;
      console.error('[GitLab Pipeline List View] refresh failed:', err);
      setRefreshing(current, false);
      const label = current.querySelector('.glpv-updated');
      if (label) {
        label.textContent = 'refresh failed';
        label.title = err.message;
        label.classList.add('glpv-updated--error');
      }
      scheduleRefresh();
    } finally {
      if (seq === refresh.seq) refresh.inFlight = false;
    }
  }

  // Under Node (`node --test`), expose the pure helpers and stop before
  // touching the page. In the browser `module` doesn't exist.
  if (typeof module === 'object' && module.exports) {
    module.exports = {
      formatDuration, formatFailureReason, retryDelay, latestAttempts,
      stageStatus, buildStageMap, rowMatchesFilter, filterActive,
    };
    return;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !refresh.pendingWhileHidden || !state.isListViewActive) return;
    refresh.pendingWhileHidden = false;
    refreshListView();
  });

  function showGraphView() {
    state.isListViewActive = false;
    if (state.graphContainer) state.graphContainer.style.display = '';
    if (state.toggleBtn) {
      state.toggleBtn.textContent = '☰ List View';
      state.toggleBtn.classList.remove('glpv-btn-active');
    }
    const listView = document.getElementById('glpv-root');
    if (listView) listView.style.display = 'none';
  }

  async function toggleView(info) {
    if (state.isListViewActive) {
      showGraphView();
      chrome.storage.local.set({ [STORAGE_KEY]: false }).catch(() => {});
    } else {
      showListView(info);
      chrome.storage.local.set({ [STORAGE_KEY]: true }).catch(() => {});
    }
  }

  // ── Injection ─────────────────────────────────────────────────────────────

  async function injectListView() {
    const info = getPageInfo();
    if (!info) return;
    if (state.pipelineId === info.pipelineId && document.getElementById('glpv-toggle')) return;

    const graphContainer = findGraphContainer();
    if (!graphContainer) return;

    state.pipelineId  = info.pipelineId;
    state.projectPath = info.projectPath;
    state.baseUrl     = info.baseUrl;
    state.graphContainer = graphContainer;

    const btn = document.createElement('button');
    btn.id = 'glpv-toggle';
    btn.className = 'glpv-btn';
    btn.textContent = '☰ List View';
    btn.title = 'Switch between pipeline graph and list view';
    state.toggleBtn = btn;

    const host = findButtonHost();
    if (host) {
      host.appendChild(btn);
    } else {
      graphContainer.parentElement.insertBefore(btn, graphContainer);
    }

    btn.addEventListener('click', () => toggleView(info));

    try {
      const saved = await chrome.storage.local.get(STORAGE_KEY);
      if (saved[STORAGE_KEY]) showListView(info);
    } catch (_) {}
  }

  // ── Navigation handling ───────────────────────────────────────────────────

  function cleanup() {
    expandAllActive = false;
    Object.assign(filter, { text: '', failedOnly: false });
    clearTimeout(refresh.timer);
    clearInterval(refresh.ticker);
    Object.assign(refresh, {
      timer: null, ticker: null, seq: refresh.seq + 1, inFlight: false,
      pendingWhileHidden: false, lastStatus: null,
    });
    document.getElementById('glpv-toggle')?.remove();
    document.getElementById('glpv-root')?.remove();
    if (state.graphContainer) state.graphContainer.style.display = '';
    Object.assign(state, {
      pipelineId: null, projectPath: null, baseUrl: null,
      isListViewActive: false, graphContainer: null, toggleBtn: null,
    });
  }

  // Content scripts run in an isolated world, so patching history.pushState
  // here wouldn't see GitLab's own calls. Instead, compare the path whenever
  // the Navigation API reports a URL change (or popstate / a DOM mutation,
  // as a fallback) and start over when it changed.
  let lastPath = window.location.pathname;

  function checkNavigation() {
    if (window.location.pathname === lastPath) return false;
    lastPath = window.location.pathname;
    cleanup();
    setTimeout(injectListView, 600);
    return true;
  }

  window.navigation?.addEventListener('currententrychange', checkNavigation);
  window.addEventListener('popstate', checkNavigation);

  // GitLab mutates the DOM constantly; handle a burst of mutations once.
  let observerQueued = false;
  function onMutations() {
    observerQueued = false;
    if (checkNavigation()) return;
    if (getPageInfo() && !document.getElementById('glpv-toggle')) injectListView();
    rehideGraph();
  }

  // GitLab may replace the graph container with a fresh (visible) one; track
  // the new element and keep it hidden while the list view is shown.
  function rehideGraph() {
    if (!state.graphContainer || state.graphContainer.isConnected) return;
    const graph = findGraphContainer();
    if (!graph) return;
    state.graphContainer = graph;
    if (state.isListViewActive) graph.style.display = 'none';
  }

  function startObserver() {
    if (state.observer) state.observer.disconnect();
    state.observer = new MutationObserver(() => {
      if (observerQueued) return;
      observerQueued = true;
      setTimeout(onMutations, 100);
    });
    state.observer.observe(document.body, { childList: true, subtree: true });
  }

  startObserver();
  injectListView();
})();
