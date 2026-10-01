# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Chrome/Chromium browser extension (Manifest V3) that replaces the GitLab pipeline graph view with a flat list of jobs grouped by stage. Works with gitlab.com by default; self-hosted GitLab instances can be added via the Options page.

## Development workflow

There is no build step, no bundler, and no package manager. All files are plain vanilla JS loaded directly by the browser.

**Loading the extension for testing:**
1. Open `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" and select this directory
4. After editing any file, click the refresh icon on the extension card

**Unit tests:** `node --test` runs `tests/*.test.js` (Node 18+, no dependencies): the pure helpers in `content.js`, and `instances.js` against a fake `chrome` API. Under Node, `content.js` exports those helpers via `module.exports` and returns before touching the DOM; in the browser `module` is undefined, so that block is skipped. Add new pure helpers to that export list when you test them.

**Manual testing:** Navigate to any GitLab pipeline detail page (e.g. `https://gitlab.com/<group>/<project>/-/pipelines/<id>`). A "☰ List View" button should appear near the pipeline header.

## Architecture

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest — declares permissions, content script patterns, service worker, popup, options page |
| `background.js` | Service worker — calls `syncInstanceScripts` on `onInstalled`/`onStartup` |
| `instances.js` | Shared by `background.js` (`importScripts`) and `options.js` (`<script>`): `instanceScript(origin)` defines what's registered for a self-hosted instance; `syncInstanceScripts` registers missing ones, updates registrations left by an older version (they persist across updates), skips instances whose permission was revoked, and unregisters removed ones |
| `content.js` | Core logic — injected into pipeline pages; fetches jobs+bridges from GitLab REST API and renders the list view |
| `options.js` | Options page — manages self-hosted GitLab origins; requests host permissions at runtime and registers content scripts dynamically |
| `popup.js` | Popup — toggles the `glpv_auto_list_view` storage key; opens the options page |
| `styles.css` | All styles for the injected list view (`.glpv-*` namespace) |

### Key design points in `content.js`

- Wrapped in an IIFE to avoid polluting the page's global scope.
- Uses `fetch` with `credentials: 'include'` to call GitLab's REST API v4 — no API token needed; the user's session cookie authenticates requests.
- `fetchAllBridges` + `fetchAllJobs` both go through `fetchPaged`: page 1 gives `X-Total-Pages`, the remaining pages are fetched in parallel (`PAGE_CONCURRENCY` at a time via `mapLimit`). If GitLab omits that header (very large result sets) it follows `X-Next-Page` sequentially.
- `buildStageMap` merges regular jobs and trigger/bridge jobs into a `Map` keyed by stage name; bridges carry `_isBridge: true`.
- `buildListView` is called recursively for downstream (child) pipelines with a `depth` argument — depth 0 adds the summary bar.
- `apiFetch` (GETs only) retries network errors, 429 and 5xx up to 3 times with backoff (honouring `Retry-After`); play/retry POSTs (`apiPost`) are never repeated automatically.
- Jobs are fetched with `include_retried=true`; `latestAttempts` keeps only the newest attempt per job name, so stage rollups and counts reflect the current state and rows show an "N attempts" badge.
- Every row (regular and trigger job) is built by `addJobRow`. Failed/canceled jobs get a per-row **Retry** button (`POST /jobs/:id/retry`) and running/pending ones a **Cancel** button (`POST /jobs/:id/cancel`); bridges get neither. Pipelines (root summary and downstream headers) get **Retry failed** when failed/canceled and **Cancel** (with a confirm) while active — see `makePipelineActionBtns`.
- **Filter:** the root has a name filter + "Failed only" toggle. State lives in the module-level `filter` object (survives refreshes, reset in `cleanup()`); `applyFilter` hides non-matching rows/stages with `.glpv-filtered`, recursing into loaded downstreams — a trigger job stays visible while anything under it matches. It's re-applied after `buildRoot`, after each downstream loads, and in `syncFilterBar` after a refresh swap (which also restores input focus).
- Downstream data is loaded by `loadDownstream`, which caches **finished** downstreams in `dsCache` keyed by the parent bridge's `downstream_pipeline` url+status+updated_at — refreshes don't re-fetch them, and a restart inside one changes the key. The cache is cleared by `requestRefresh` (after any play/retry/cancel) and `cleanup()`.
- Expand/collapse of downstream pipelines is lazy: the API fetch only fires on first expand. `setupExpand` registers each button's expand function in the `expanders` WeakMap so a refresh can re-open and await them.
- **Auto refresh:** while the root pipeline status is in `ACTIVE_STATUSES`, `refreshListView` re-fetches every `REFRESH_MS`, builds the new tree off-DOM with previously expanded downstreams re-loaded (`buildRoot` → `restoreExpanded`), then swaps it in. Paused while the tab is hidden or the graph view is shown (catches up on return); a failed refresh keeps the old view. Playing/retrying a job triggers a refresh via `requestRefresh`. `refresh.seq` is bumped in `cleanup()` so in-flight refreshes for a previous pipeline are dropped.
- **Log preview:** failed (non-bridge) jobs get a **Log** button that toggles a `.glpv-log-row` under the row with the last `LOG_TAIL_LINES` lines of `GET /jobs/:id/trace`, cleaned by `logTail` (ANSI codes, section markers, `\r` overwrites). Tails are cached in `logCache` and open previews tracked in `openLogs` (both reset in `cleanup()`), so they stay open across refreshes. The filter hides a log row with its job row.
- **Collapsible stages:** stage headers toggle their job table (click, Enter/Space). `defaultCollapsed` starts fully passed stages collapsed when that pipeline has a failed stage; manual toggles are kept in `stageOverrides` (`<pipeline id>:<stage>`, survives refreshes, reset in `cleanup()`). While a filter is active, stages with matches get `.glpv-stage--filter-open` so collapsed ones still show them.
- **Live durations:** `jobTiming` / `pipelineTiming` decide what a duration shows — running jobs count from their `duration` (GitLab's elapsed time at fetch), pending ones show `queued <queued_duration>`, active pipelines count from `started_at` (their `duration` is null until finished). `timingEl` stamps live elements with `data-live-secs`/`data-live-from`, and `tickLive` advances them every second on the same 1s ticker as the "updated Xs ago" label.
- A failed initial load renders an error box with a Retry button and is never reused by the toggle.
- Navigation on GitLab's SPA is detected by comparing `location.pathname` on the Navigation API's `currententrychange`, `popstate`, and DOM mutations (patching `history.pushState` doesn't work from the content script's isolated world).
- A debounced `MutationObserver` on `document.body` re-injects the toggle button if GitLab re-renders the pipeline header, and re-hides the graph if GitLab replaces its container (`rehideGraph`).
- Stages are ordered by their lowest job/bridge id (the API order isn't stage order).
- Dark styles apply for `html.gl-dark`, or `html.gl-system` (GitLab "Auto" color mode) with a dark OS theme.

### Storage keys

| Key | Type | Purpose |
|---|---|---|
| `glpv_auto_list_view` | boolean | Activate list view automatically on page load |
| `glpv_auto_expand` | boolean | Automatically expand all downstream pipelines when the list view loads |
| `glpv_instances` | string[] | Origins of registered self-hosted GitLab instances |

### Permissions model

- `storage` and `scripting` are declared statically.
- `optional_host_permissions: ["*://*/*"]` allows the extension to request access to arbitrary origins at runtime (used for self-hosted instances).
- The static content script in `manifest.json` only matches `https://gitlab.com/*/-/pipelines/*`.
- Self-hosted instances get dynamically registered scripts via `chrome.scripting.registerContentScripts`. To change what runs on them, edit `instanceScript` in `instances.js` — existing installs pick it up on the next update/browser start.
