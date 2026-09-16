# Tab Out

Tab Out is a Chrome Manifest V3 extension that replaces the new-tab page with a dashboard of open tabs. It groups tabs by domain, keeps homepage tabs together, and provides Pocket, Candidate cleanup, Captain workflows, and persistent undo/redo without an application server or account.

## Features

- Group and focus tabs across Chrome windows.
- Move live or dormant items through Pocket, backed by Chrome tab groups and extension storage.
- Clean duplicate tabs first, then locally recognized error pages.
- Configure any number of ranked Task Groups, or none, each with an optional Keep/Pending split, color, and icon.
- Match a Task Group by PDF or by any mix of exact page URLs and whole domains.
- Reorder Captain and Pocket content by dragging.
- Restore supported changes with up to 200 browser-session undo/redo entries. Each user operation occupies one entry, even when it affects many tabs.
- Toggle the optional local café/rain ambience from the Pocket coin. Tap Space five times to open or close its remembered XY mixer.

## Install

1. Clone this repository.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Select **Load unpacked** and choose the repository's `extension/` directory.
5. Open a new tab.

Open the extension's **Options** page to change language, dashboard columns, Pocket behavior, or each Task Group's Keep area, icon, color, and matching rules. You can add, delete, or remove all Task Groups. In a Task Group, a bare host such as `example.com` matches that domain and its subdomains; a full URL such as `https://example.com/project/one` matches only that page. Rules can be separated by commas, spaces, semicolons, or new lines. Task Group icon assets live in `extension/assets/icons/task-groups/`; add an asset there and register its name in `captain-rules.js` and `style.css` to expose another choice.

## Architecture

There is no build step, package manager, or application server. Chrome loads the files in `extension/` directly.

| File | Responsibility |
| --- | --- |
| `contracts.js` | Canonical Chrome storage keys, runtime/DOM message contracts, and shared Pocket schema normalization. |
| `captain-rules.js` | Task Group configuration schemas, page/domain matching, PDF detection, and Keep/Pending schema normalization. |
| `app.js` | New-tab dashboard controller, renderer, interaction logic, layout preferences, and undo/redo orchestration. It requests Pocket membership and Captain lifecycle writes from the worker. |
| `background.js` | Service worker and authoritative writer for Pocket membership/live links and Task Group Keep/Pending state; also handles startup restoration, error signals, metadata lookup, badge state, and offscreen audio. |
| `options.js` | Options form and dynamic PDF/Task Group configuration. |
| `error-semantics.js`, `error-detector.js` | Shared error-page classification and the top-level content-script observer. |
| `ambient-rain.js`, `ambient-audio.js`, `metal-coin.js` | Dashboard ambience visuals, singleton offscreen audio, and Pocket coin interaction. |

The dashboard and service worker deliberately share contracts instead of redefining storage schemas or matching rules. Persistent storage key values that predate the Captain terminology remain unchanged so existing installations retain their data.

## Storage and network behavior

Tab-management state stays in Chrome's `storage.local` and `storage.session`; no Tab Out account or application backend is used. The dashboard can contact Google Fonts and Google's favicon service for presentation assets. For recognized papers, the service worker can request titles from Crossref or arXiv. Error detection inspects top-level page titles/headings locally and does not upload page text.

## Development

Edit files under `extension/`, then reload Tab Out from `chrome://extensions`. Lightweight static validation can be run with:

```sh
find extension -name '*.js' -print0 | xargs -0 -n1 node --check
node -e "JSON.parse(require('fs').readFileSync('extension/manifest.json', 'utf8'))"
```

## License

MIT
