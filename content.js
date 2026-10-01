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

  // Play (`action` = 'play') or retry ('retry') a job. Uses project_id from
  // the embedded pipeline object when available (most reliable), falls back
  // to parsing the job's web_url.
  function jobAction(job, action) {
    const base = originOf(job.web_url);
    const proj = job.pipeline?.project_id ?? projectPathOf(job.web_url);
    return apiPost(`${projApiBase(base, proj)}/jobs/${job.id}/${action}`);
  }

  // Retry every failed/canceled job of one pipeline (GitLab's "Retry" button).
  function retryPipeline(baseUrl, proj, pipelineId) {
    return apiPost(`${projApiBase(baseUrl, proj)}/pipelines/${pipelineId}/retry`);
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

  // "Retry" button at the end of a failed/canceled job's name cell. On
  // success the row goes pending and the view refreshes to pick up the new
  // attempt; on failure the button flashes red and can be clicked again.
  function attachRetryBtn(nameCell, statusCell, job, tr) {
    const btn = document.createElement('button');
    btn.className = 'glpv-retry-btn';
    btn.title = 'Retry this job';
    btn.textContent = 'Retry';
    nameCell.appendChild(btn);

    btn.addEventListener('click', async e => {
      e.preventDefault();
      e.stopPropagation();

      btn.disabled = true;
      btn.textContent = 'Retrying…';
      try {
        await jobAction(job, 'retry');
        btn.remove();
        statusCell.querySelector('.glpv-job-icon')?.replaceWith(pendingIcon());
        setRowPending(tr);
        requestRefresh(ACTION_REFRESH_MS);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Retry';
        btn.classList.add('glpv-retry-btn--error');
        btn.title = `Failed to retry: ${err.message}`;
        setTimeout(() => {
          btn.classList.remove('glpv-retry-btn--error');
          btn.title = 'Retry this job';
        }, 4000);
        console.error('[GitLab Pipeline List View] retry job failed:', err);
      }
    });
  }

  // "Retry failed" button for a whole pipeline (root summary bar or a
  // downstream header). Only offered when the pipeline ended failed/canceled.
  function makeRetryPipelineBtn(baseUrl, proj, pipeline) {
    if (!['failed', 'canceled'].includes(pipeline.status)) return null;
    const btn = document.createElement('button');
    btn.className = 'glpv-action-btn';
    btn.textContent = 'Retry failed';
    btn.title = 'Retry all failed and canceled jobs in this pipeline';

    btn.addEventListener('click', async e => {
      e.stopPropagation();
      btn.disabled = true;
      btn.textContent = 'Retrying…';
      try {
        await retryPipeline(baseUrl, proj, pipeline.id);
        btn.textContent = 'Retried ✓';
        requestRefresh(ACTION_REFRESH_MS);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Retry failed';
        btn.title = `Failed to retry: ${err.message}`;
        btn.classList.add('glpv-action-btn--error');
        console.error('[GitLab Pipeline List View] retry pipeline failed:', err);
      }
    });
    return btn;
  }

  function attachJobActions(tr, job) {
    const statusCell = tr.querySelector('.glpv-col-status');
    if (job.status === 'manual') {
      attachPlayBtn(statusCell, job, tr);
    } else if (!job._isBridge && ['failed', 'canceled'].includes(job.status)) {
      attachRetryBtn(tr.querySelector('.glpv-col-name'), statusCell, job, tr);
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
    return map;
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

        const pc = statusCfg(pipeline.status);
        const projPath = projectPathOf(downstream.web_url) || `Project ${downstream.project_id}`;

        const header = document.createElement('div');
        header.className = 'glpv-ds-header';

        const badge = document.createElement('span');
        badge.className = `glpv-badge glpv-status-${pipeline.status}`;
        const iconEl = document.createElement('span');
        iconEl.className = 'glpv-icon';
        iconEl.textContent = pc.icon;
        badge.appendChild(iconEl);
        badge.appendChild(document.createTextNode(pc.label));

        const projLink = document.createElement('a');
        projLink.href = downstream.web_url;
        projLink.className = 'glpv-ds-proj-link';
        projLink.textContent = projPath;

        const meta = document.createElement('span');
        meta.className = 'glpv-ds-meta';
        let metaText = `Pipeline #${pipeline.id}`;
        if (pipeline.ref) metaText += ` · ${pipeline.ref}`;
        if (pipeline.duration) metaText += ` · ${formatDuration(pipeline.duration)}`;
        meta.textContent = metaText;

        header.appendChild(badge);
        header.appendChild(projLink);
        header.appendChild(meta);
        const retryBtn = makeRetryPipelineBtn(dpBase, downstream.project_id, pipeline);
        if (retryBtn) header.appendChild(retryBtn);

        const nested = buildListView(pipeline, djobs, dbridges, depth + 1);

        contentDiv.className = 'glpv-ds-inner';
        contentDiv.innerHTML = '';
        contentDiv.appendChild(header);
        contentDiv.appendChild(nested);

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

  // ── Bridge job row (trigger job + optional expandable downstream) ─────────

  function addBridgeRow(tbody, job, depth) {
    const jc = statusCfg(job.status);
    const dp = job.downstream_pipeline; // null if pipeline not yet triggered

    const tr = document.createElement('tr');
    tr.className = `glpv-job-row glpv-status-${job.status} glpv-bridge-job`;

    // Status cell
    const tdStatus = document.createElement('td');
    tdStatus.className = 'glpv-col-status';
    const icon = document.createElement('span');
    icon.className = `glpv-job-icon glpv-status-${job.status}`;
    icon.title = jc.label;
    icon.textContent = jc.icon;
    tdStatus.appendChild(icon);

    // Name cell
    const tdName = document.createElement('td');
    tdName.className = 'glpv-col-name';

    // Expand button (only when downstream pipeline exists)
    let expandBtn = null;
    if (dp) {
      expandBtn = document.createElement('button');
      expandBtn.className = 'glpv-expand-btn';
      expandBtn.setAttribute('aria-expanded', 'false');
      expandBtn.title = 'Toggle downstream pipeline';
      tdName.appendChild(expandBtn);
    }

    const jobLink = document.createElement('a');
    jobLink.href = job.web_url;
    jobLink.className = 'glpv-job-link';
    jobLink.textContent = job.name;
    tdName.appendChild(jobLink);

    if (job.allow_failure) {
      const opt = document.createElement('span');
      opt.className = 'glpv-badge-optional';
      opt.textContent = 'optional';
      tdName.appendChild(opt);
    }

    // Inline downstream status badge: "→ [passed] #12"
    if (dp) {
      const dpc = statusCfg(dp.status);

      const dsBadge = document.createElement('span');
      dsBadge.className = 'glpv-ds-badge';

      const statusSpan = document.createElement('span');
      statusSpan.className = `glpv-badge glpv-status-${dp.status}`;
      const iconSpan = document.createElement('span');
      iconSpan.className = 'glpv-icon';
      iconSpan.textContent = dpc.icon;
      statusSpan.appendChild(iconSpan);
      statusSpan.appendChild(document.createTextNode(dpc.label));

      const dpLink = document.createElement('a');
      dpLink.href = dp.web_url;
      dpLink.className = 'glpv-ds-link';
      dpLink.title = 'Open downstream pipeline';
      dpLink.textContent = `#${dp.id}`;
      dpLink.addEventListener('click', e => e.stopPropagation());

      dsBadge.appendChild(document.createTextNode('→ '));
      dsBadge.appendChild(statusSpan);
      dsBadge.appendChild(document.createTextNode(' '));
      dsBadge.appendChild(dpLink);
      tdName.appendChild(dsBadge);
    }

    const tdStarted = document.createElement('td');
    tdStarted.className = 'glpv-col-started';
    tdStarted.textContent = formatDate(job.started_at) || '-';

    const tdDuration = document.createElement('td');
    tdDuration.className = 'glpv-col-duration';
    tdDuration.textContent = formatDuration(job.duration);

    const tdRunner = document.createElement('td');
    tdRunner.className = 'glpv-col-runner';
    tdRunner.textContent = job.runner ? (job.runner.description || `#${job.runner.id}`) : '-';

    tr.appendChild(tdStatus);
    tr.appendChild(tdName);
    tr.appendChild(tdStarted);
    tr.appendChild(tdDuration);
    tr.appendChild(tdRunner);
    attachJobActions(tr, job);
    tbody.appendChild(tr);

    // Expand row (hidden until toggled; first expand lazy-loads the downstream)
    if (dp) {
      const expandRow = document.createElement('tr');
      expandRow.className = 'glpv-ds-row';
      expandRow.hidden = true;

      const tdIndent = document.createElement('td');
      expandRow.appendChild(tdIndent);

      const tdContent = document.createElement('td');
      tdContent.className = 'glpv-ds-cell';
      tdContent.colSpan = 4;

      const contentDiv = document.createElement('div');
      contentDiv.className = 'glpv-ds-content';
      tdContent.appendChild(contentDiv);
      expandRow.appendChild(tdContent);
      tbody.appendChild(expandRow);

      if (expandBtn) {
        setupExpand(expandBtn, expandRow, contentDiv, dp, depth);
      }
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

      const retryBtn = makeRetryPipelineBtn(state.baseUrl, state.projectPath, pipeline);
      if (retryBtn) actions.appendChild(retryBtn);

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

      for (const job of stageJobs) {
        if (job._isBridge) {
          addBridgeRow(tbody, job, depth);
        } else {
          const jc = statusCfg(job.status);
          const runnerName = job.runner
            ? escHtml(job.runner.description || `#${job.runner.id}`)
            : '-';
          const tr = document.createElement('tr');
          tr.className = `glpv-job-row glpv-status-${escHtml(job.status)}`;
          tr.innerHTML = `
            <td class="glpv-col-status">
              <span class="glpv-job-icon glpv-status-${escHtml(job.status)}" title="${escHtml(jc.label)}">${jc.icon}</span>
            </td>
            <td class="glpv-col-name">
              <a href="${escHtml(job.web_url)}" class="glpv-job-link">${escHtml(job.name)}</a>
              ${job.allow_failure ? '<span class="glpv-badge-optional">optional</span>' : ''}
              ${job._attempts > 1
                ? `<span class="glpv-badge-optional" title="Showing the latest of ${job._attempts} attempts">${job._attempts} attempts</span>`
                : ''}
            </td>
            <td class="glpv-col-started">${escHtml(formatDate(job.started_at)) || '-'}</td>
            <td class="glpv-col-duration">${escHtml(formatDuration(job.duration))}</td>
            <td class="glpv-col-runner">${runnerName}</td>
          `;
          attachJobActions(tr, job);
          tbody.appendChild(tr);
        }
      }

      table.appendChild(tbody);
      stageEl.appendChild(table);
      root.appendChild(stageEl);
    });

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
      root.style.display = now.style.display;
      now.replaceWith(root);
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

  function handleNavigation() {
    cleanup();
    setTimeout(injectListView, 600);
  }

  const origPush    = history.pushState.bind(history);
  const origReplace = history.replaceState.bind(history);
  history.pushState = function (...args) { origPush(...args); handleNavigation(); };
  history.replaceState = function (...args) { origReplace(...args); handleNavigation(); };
  window.addEventListener('popstate', handleNavigation);

  function startObserver() {
    if (state.observer) state.observer.disconnect();
    state.observer = new MutationObserver(() => {
      if (getPageInfo() && !document.getElementById('glpv-toggle')) injectListView();
    });
    state.observer.observe(document.body, { childList: true, subtree: true });
  }

  startObserver();
  injectListView();
})();
