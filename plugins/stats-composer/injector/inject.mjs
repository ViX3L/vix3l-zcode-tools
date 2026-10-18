#!/usr/bin/env node
// stats-composer injector — attaches to the running ZCode desktop app over
// its local remote-debugging (CDP) port and appends a lightweight stats pill
// to the composer toolbar, at the position the user marked.
//
// Opt-in ("integration mode"): injection happens only when the app exposes a
// CDP port. On developer installs the app enables port 9229 automatically; on
// packaged installs launch it once as `zcode --remote-debugging-port=9229`.
// Without CDP the plugin stays in its zero-risk fallback channels.
//
// Run: node injector/inject.mjs [--port 9229] [--sidecar-port 7427] [--once]
import fs from "node:fs";
import path from "node:path";
import { sidecarAlive } from "../scripts/lib/runtime.mjs";
import { readOptions } from "../scripts/lib/options.mjs";
import { claimLock } from "../scripts/lib/lock.mjs";
import { statsComposerDir, statsComposerPillFile } from "../scripts/lib/paths.mjs";
import { DEFAULT_CDP_PORT, LOCK_TOUCH_MS, SWEEP_MS } from "../scripts/lib/constants.mjs";
import { pillScript } from "./lib/page.mjs";
import { runSweep } from "./lib/sweep.mjs";

const RUN_DIR = statsComposerDir();
const LOCK_FILE = path.join(RUN_DIR, "injector.lock");

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] ? Number(args[at + 1]) : fallback;
};
const CDP_PORT = argOf("--port", DEFAULT_CDP_PORT);
const SIDECAR_PORT_FROM_CLI = args.indexOf("--sidecar-port") >= 0;
const SIDECAR_PORT = argOf("--sidecar-port", readOptions().port);
const ONCE = args.includes("--once");

const log = (...parts) => console.log("[stats-composer-injector]", ...parts);

// Attach-state file lets the hook (and doctor) know whether the pill channel is
// genuinely up, so the visible-stats ladder can fall back correctly. A stale
// file counts as detached.
function writeAttachState(attached, reason) {
  try {
    fs.mkdirSync(RUN_DIR, { recursive: true });
    fs.writeFileSync(
      statsComposerPillFile(),
      JSON.stringify({
        attached: !!attached,
        reason: reason || "",
        ts: Date.now(),
        port: CDP_PORT,
        sidecar: SIDECAR_PORT,
      })
    );
  } catch { /* attach state is advisory; the next sweep rewrites it */ }
}

const lock = claimLock(LOCK_FILE);
if (!lock.acquired) {
  log("another injector holds the lock — standing down");
  process.exit(3);
}
process.on("exit", () => lock.release());

let attached = false;
let sweeping = false;

async function sweepOnce() {
  if (sweeping) return;
  sweeping = true;
  try {
    lock.touch();
    // Settings are re-read on EVERY sweep: the app writes a saved change to its
    // config file, and re-reading it here is what makes the choice apply within
    // one interval without restarting anything. Layout and position are part of
    // the script's VERSION, so a change supersedes the running generation.
    const opts = readOptions();
    if (!SIDECAR_PORT_FROM_CLI && opts.port !== SIDECAR_PORT) {
      // A changed port cannot be applied to this process: the page script's
      // endpoint is baked in. Exit so the next hook starts the right
      // generation instead of leaving a pill polling a dead port forever.
      log(`sidecar port changed to ${opts.port}; standing down for a new generation`);
      lock.release();
      process.exit(0);
    }
    if (!(await sidecarAlive(SIDECAR_PORT))) {
      if (attached) {
        log(`sidecar on ${SIDECAR_PORT} is not answering — standing by`);
        return;
      }
      log(`no stats-composer sidecar on ${SIDECAR_PORT} — standing down`);
      lock.release();
      process.exit(3);
    }

    const layout = opts.wideCard ? "wide" : "compact";
    log(`card layout: ${layout}, pill position: ${opts.position}`);
    const script = pillScript({ sidecarPort: SIDECAR_PORT, layout, position: opts.position });
    const result = await runSweep({
      cdpPort: CDP_PORT,
      script,
      log,
      writeAttachState,
    });
    if (result.attached) attached = true;
    if (result.reason === "no-app-cdp") process.exitCode = 2;
  } catch (error) {
    log("sweep error:", String(error.message || error));
  } finally {
    sweeping = false;
  }
}

await sweepOnce();

if (!ONCE) {
  // Periodic re-sweep: navigations and session switches drop the DOM pill; the
  // injected script is idempotent, so re-running is safe.
  const sweeper = setInterval(() => { sweepOnce().catch(() => {}); }, SWEEP_MS);
  // Heartbeat: keep the lock fresh while a slow sweep runs. Unref'd so it never
  // keeps the process alive on its own.
  const heartbeat = setInterval(() => lock.touch(), LOCK_TOUCH_MS);
  heartbeat.unref();
  process.on("exit", () => clearInterval(sweeper));
}
