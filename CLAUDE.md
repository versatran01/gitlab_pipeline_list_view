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

**Manual testing:** Navigate to any GitLab pipeline detail page (e.g. `https://gitlab.com/<group>/<project>/-/pipelines/<id>`). A "☰ List View" button should appear near the pipeline header.

## Architecture

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest — declares permissions, content script patterns, service worker, popup, options page |
| `background.js` | Service worker — re-registers content scripts for saved self-hosted instances on `onInstalled`/`onStartup` |
| `content.js` | Core logic — injected into pipeline pages; fetches jobs+bridges from GitLab REST API and renders the list view |
| `options.js` | Options page — manages self-hosted GitLab origins; requests host permissions at runtime and registers content scripts dynamically |
| `popup.js` | Popup — toggles the `glpv_auto_list_view` storage key; opens the options page |
| `styles.css` | All styles for the injected list view (`.glpv-*` namespace) |

### Key design points in `content.js`

- Wrapped in an IIFE to avoid polluting the page's global scope.
- Uses `fetch` with `credentials: 'include'` to call GitLab's REST API v4 — no API token needed; the user's session cookie authenticates requests.
- `fetchAllBridges` + `fetchAllJobs` both paginate via `X-Total-Pages` header.
- `buildStageMap` merges regular jobs and trigger/bridge jobs into a `Map` keyed by stage name; bridges carry `_isBridge: true`.
- `buildListView` is called recursively for downstream (child) pipelines with a `depth` argument — depth 0 adds the summary bar.
- `apiFetch` (GETs only) retries network errors, 429 and 5xx up to 3 times with backoff (honouring `Retry-After`); play/retry POSTs (`apiPost`) are never repeated automatically.
- Jobs are fetched with `include_retried=true`; `latestAttempts` keeps only the newest attempt per job name, so stage rollups and counts reflect the current state and rows show an "N attempts" badge.
- Failed/canceled jobs get a per-row **Retry** button (`POST /jobs/:id/retry`); failed/canceled pipelines (root summary and downstream headers) get **Retry failed** (`POST /pipelines/:id/retry`).
- Expand/collapse of downstream pipelines is lazy: the API fetch only fires on first expand. `setupExpand` registers each button's expand function in the `expanders` WeakMap so a refresh can re-open and await them.
- **Auto refresh:** while the root pipeline status is in `ACTIVE_STATUSES`, `refreshListView` re-fetches every `REFRESH_MS`, builds the new tree off-DOM with previously expanded downstreams re-loaded (`buildRoot` → `restoreExpanded`), then swaps it in. Paused while the tab is hidden or the graph view is shown (catches up on return); a failed refresh keeps the old view. Playing/retrying a job triggers a refresh via `requestRefresh`. `refresh.seq` is bumped in `cleanup()` so in-flight refreshes for a previous pipeline are dropped.
- A failed initial load renders an error box with a Retry button and is never reused by the toggle.
- Navigation on GitLab's SPA is detected by comparing `location.pathname` on the Navigation API's `currententrychange`, `popstate`, and DOM mutations (patching `history.pushState` doesn't work from the content script's isolated world).
- A debounced `MutationObserver` on `document.body` re-injects the toggle button if GitLab re-renders the pipeline header.
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
- Self-hosted instances get dynamically registered scripts via `chrome.scripting.registerContentScripts`.
