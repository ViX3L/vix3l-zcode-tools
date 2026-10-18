#!/usr/bin/env node
// stats-composer sidecar — a tiny localhost HTTP server (default :7427) that
// serves per-request TPS / TTFT stats from ZCode's usage DB.
//
// Endpoints (all JSON unless noted):
//   GET /health                     → {ok:true, uptime}
//   GET /stats                      → full snapshot (last/window/session/live)
//   GET /stats.json                 → same, explicit
//   GET /metrics                    → Prometheus text format
//   GET /turn[?session=&msg=]       → per-turn token usage (turn_usage table)
//   GET /requests[?offset=&limit=]  → one page of the per-request table
//   GET /dashboard                  → auto-refresh HTML dashboard
//
// This is the visible-stats channel when the composer pill is unavailable.
// It binds 127.0.0.1 only. The port file (~/.zcode/stats-composer/port) lets
// hooks, CLI and the injector discover the running instance.
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { readOptions } from "../scripts/lib/options.mjs";
import { statsComposerPortFile } from "../scripts/lib/paths.mjs";
import { pluginVersion } from "../scripts/lib/version.mjs";
import { createSnapshotStore } from "./lib/snapshot.mjs";
import { createHandler } from "./lib/routes.mjs";
import { createInjectorSupervisor } from "./lib/injector.mjs";

const PLUGIN_ROOT =
  process.env.STATS_SIDECAR_PLUGIN_ROOT ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.STATS_SIDECAR_PORT) || readOptions().port;
const version = () => pluginVersion(PLUGIN_ROOT);

const log = (...parts) => console.log("[stats-composer]", ...parts);

const store = createSnapshotStore({
  port: PORT,
  pluginVersion: version,
  onPortChanged: () => process.exit(0),
});

const injector = createInjectorSupervisor({ pluginRoot: PLUGIN_ROOT, port: PORT, log });

const server = createServer(createHandler({ store, port: PORT, pluginVersion: version }));

function start() {
  try {
    fs.mkdirSync(path.dirname(statsComposerPortFile()), { recursive: true });
  } catch { /* the write below reports a real failure */ }
  server.listen(PORT, "127.0.0.1", () => {
    try {
      fs.writeFileSync(statsComposerPortFile(), String(PORT));
      fs.chmodSync(statsComposerPortFile(), 0o600);
    } catch { /* a missing port file means no injector attaches; logged next */ }
    log(`sidecar on http://127.0.0.1:${PORT} (dashboard /dashboard)`);
    injector.start();
  });
  server.on("error", (error) => {
    if (error.code !== "EADDRINUSE") {
      log("listen failed:", String(error.message || error));
      process.exit(1);
    }
    // Already running? Verify, then exit quietly either way.
    fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(1500) })
      .then(() => process.exit(0))
      .catch(() => process.exit(0));
  });
}

function stop() {
  injector.stop();
  store.stop();
  try { fs.unlinkSync(statsComposerPortFile()); } catch {}
  server.close(() => process.exit(0));
  // A hung socket must not keep the process alive past a signal.
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on("SIGTERM", stop);
process.on("SIGINT", stop);

store.start();
// Build the first snapshot before accepting requests: the first reader then
// never sees an empty response, and a startup failure is visible in the log.
store.refresh(true);
start();
