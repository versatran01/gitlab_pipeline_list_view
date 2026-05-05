/* global chrome */
(function () {
  'use strict';

  const STORAGE_KEY = 'glpv_auto_list_view';

  let expandAllActive = false;

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

  async function apiFetch(url) {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitLab API ${res.status}: ${text || res.statusText}`);
    }
    return res;
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

  // Trigger a manual job. Uses project_id from the embedded pipeline object when
  // available (most reliable), falls back to parsing the job's web_url.
  async function triggerJob(job) {
    const base = originOf(job.web_url);
    const proj = job.pipeline?.project_id ?? projectPathOf(job.web_url);
    const token = document.querySelector('meta[name="csrf-token"]')?.content;
    const headers = {};
    if (token) headers['X-CSRF-Token'] = token;

    const res = await fetch(`${projApiBase(base, proj)}/jobs/${job.id}/play`, {
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
        await triggerJob(job);
        const pc = statusCfg('pending');
        const icon = document.createElement('span');
        icon.className = 'glpv-job-icon glpv-status-pending';
        icon.title = pc.label;
        icon.textContent = pc.icon;
        btn.replaceWith(icon);
        tr.className = tr.className.replace(/\bglpv-status-\S+/, 'glpv-status-pending');
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

  function setupExpand(btn, expandRow, contentDiv, downstream, depth) {
    let loaded = false;

    btn.addEventListener('click', async () => {
      const willExpand = btn.getAttribute('aria-expanded') !== 'true';
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

        const nested = buildListView(pipeline, djobs, dbridges, depth + 1);

        contentDiv.className = 'glpv-ds-inner';
        contentDiv.innerHTML = '';
        contentDiv.appendChild(header);
        contentDiv.appendChild(nested);

        // If "Expand All" is active, cascade into any bridges in the nested pipeline
        if (expandAllActive && btn.getAttribute('aria-expanded') === 'true') {
          nested.querySelectorAll('.glpv-expand-btn[aria-expanded="false"]')
            .forEach(b => b.click());
        }
      } catch (err) {
        contentDiv.className = 'glpv-ds-error';
        contentDiv.innerHTML =
          `<strong>Failed to load downstream pipeline.</strong><br>${escHtml(err.message)}`;
        console.error('[GitLab Pipeline List View]', err);
        loaded = false; // allow retry on next expand
      }
    });
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
    if (job.status === 'manual') {
      attachPlayBtn(tdStatus, job, tr);
    }
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

      if (bridges.length > 0) {
        const expandAllBtn = document.createElement('button');
        expandAllBtn.className = 'glpv-expand-all-btn';
        expandAllBtn.textContent = 'Expand All';

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

        summary.appendChild(expandAllBtn);
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
            </td>
            <td class="glpv-col-started">${escHtml(formatDate(job.started_at)) || '-'}</td>
            <td class="glpv-col-duration">${escHtml(formatDuration(job.duration))}</td>
            <td class="glpv-col-runner">${runnerName}</td>
          `;
          if (job.status === 'manual') {
            attachPlayBtn(tr.querySelector('.glpv-col-status'), job, tr);
          }
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
    if (existing) { existing.style.display = ''; return; }

    const loading = document.createElement('div');
    loading.id = 'glpv-root';
    loading.className = 'glpv-loading';
    loading.textContent = 'Loading pipeline jobs…';
    state.graphContainer.parentElement.insertBefore(loading, state.graphContainer);

    Promise.all([
      fetchPipeline(info.baseUrl, info.projectPath, info.pipelineId),
      fetchAllJobs(info.baseUrl, info.projectPath, info.pipelineId),
      fetchAllBridges(info.baseUrl, info.projectPath, info.pipelineId),
    ])
      .then(([pipeline, jobs, bridges]) => {
        const listView = buildListView(pipeline, jobs, bridges, 0);
        loading.replaceWith(listView);
      })
      .catch(err => {
        loading.className = 'glpv-error';
        loading.innerHTML =
          `<strong>Failed to load pipeline jobs.</strong><br>${escHtml(err.message)}`;
        console.error('[GitLab Pipeline List View]', err);
      });
  }

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
