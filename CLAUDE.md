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
- Expand/collapse of downstream pipelines is lazy: the API fetch only fires on first expand.
- Navigation on GitLab's SPA is detected by patching `history.pushState/replaceState` and listening to `popstate`.
- A `MutationObserver` on `document.body` re-injects the toggle button if GitLab re-renders the pipeline header.

### Storage keys

| Key | Type | Purpose |
|---|---|---|
| `glpv_auto_list_view` | boolean | Activate list view automatically on page load |
| `glpv_instances` | string[] | Origins of registered self-hosted GitLab instances |

### Permissions model

- `storage` and `scripting` are declared statically.
- `optional_host_permissions: ["*://*/*"]` allows the extension to request access to arbitrary origins at runtime (used for self-hosted instances).
- The static content script in `manifest.json` only matches `https://gitlab.com/*/-/pipelines/*`.
- Self-hosted instances get dynamically registered scripts via `chrome.scripting.registerContentScripts`.
