---
description: Open (or reopen) the live TPS/TTFT dashboard in the browser
---

Run `node "${ZCODE_PLUGIN_ROOT}/sidecar/server.mjs"` detached if it is not already running (check the port file `~/.zcode/stats-composer/port` first; if `/health` on that port answers ok, it is already up). Then open the dashboard URL in the user's browser:

1. Determine the port: read `~/.zcode/stats-composer/port` (default 7427).
2. If not healthy, spawn `node "${ZCODE_PLUGIN_ROOT}/sidecar/server.mjs"` in the background and wait ~1 s.
3. Open `http://127.0.0.1:<port>/dashboard` in the browser.
4. Tell the user the URL, that auto-refresh can be toggled on/off in-page (with a manual refresh button), and that data updates apply in place — the page never reloads, so nothing flickers.