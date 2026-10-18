#!/usr/bin/env node
// usage-context injector — attaches to the running ZCode desktop app over its
// local CDP port and adds per-turn usage chips to each assistant turn's footer,
// to the right of the timestamp.
//
// It does NOT open the usage DB and does NOT bind a port. It reads per-turn
// usage over HTTP from the stats-composer sidecar's /turn endpoint (one shared
// server), so enabling this plugin adds no second reader and no second port.
//
// Run: node injector/inject.mjs [--port 9229] [--sidecar-port 7427] [--once]
import fs from "node:fs";
import path from "node:path";
import { sidecarAlive } from "../scripts/lib/runtime.mjs";
import { readOptions } from "../scripts/lib/options.mjs";
import { claimLock } from "../scripts/lib/lock.mjs";
import { pluginStateDir, statsComposerPortFile } from "../scripts/lib/paths.mjs";
import { DEFAULT_CDP_PORT, DEFAULT_SIDECAR_PORT, LOCK_TOUCH_MS, SWEEP_MS } from "../scripts/lib/constants.mjs";
import { chipsScript, chipsStyle, styleBootstrap } from "./lib/page.mjs";
import { sweepOnce } from "./lib/sweep.mjs";

const RUN_DIR = pluginStateDir("usage-context");
const LOCK_FILE = path.join(RUN_DIR, "injector.lock");

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] ? Number(args[at + 1]) : fallback;
};
const CDP_PORT = argOf("--port", DEFAULT_CDP_PORT);
const SIDECAR_PORT_FROM_CLI = args.indexOf("--sidecar-port") >= 0;
const ONCE = args.includes("--once");

const log = (...parts) => console.log("[usage-context-injector]", ...parts);

function publishedPort() {
  try {
    const port = Number(fs.readFileSync(statsComposerPortFile(), "utf8").trim());
    if (port) return port;
  } catch { /* no port file: the sidecar is not up yet */ }
  return null;
}

function resolveSidecarPort(opts) {
  return publishedPort() || opts.sidecarPort || DEFAULT_SIDECAR_PORT;
}

const initialOpts = readOptions();
const START_PORT = SIDECAR_PORT_FROM_CLI ? argOf("--sidecar-port", initialOpts.sidecarPort) : resolveSidecarPort(initialOpts);

const lock = claimLock(LOCK_FILE);
if (!lock.acquired) {
  log("another injector holds the lock — standing down");
  process.exit(3);
}
process.on("exit", () => lock.release());

// Whether this injector has ever put chips on the page. It decides what a dead
// sidecar means: a launch that never had a data source is doomed and exits; one
// that already mounted stands by, keeping the figures its chips last read.
let injected = false;
let sweeping = false;

async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    lock.touch();
    const opts = readOptions();
    // A changed sidecar port cannot be applied to this process: the page
    // script's endpoint is baked in. Exit 0 so the next hook starts a
    // generation pointed at the new port, and release our lock first.
    const port = SIDECAR_PORT_FROM_CLI ? START_PORT : resolveSidecarPort(opts);
    if (port !== START_PORT) {
      log(`sidecar port changed to ${port}; standing down for a new generation`);
      lock.release();
      process.exit(0);
    }

    if (opts.showChips && !(await sidecarAlive(START_PORT))) {
      if (injected) {
        log(`sidecar on ${START_PORT} is not answering — standing by`);
        return;
      }
      log(`no stats-composer sidecar on ${START_PORT} — standing down`);
      lock.release();
      process.exit(3);
    }

    const expression =
      (opts.showChips ? styleBootstrap(chipsStyle()) : "") +
      chipsScript({
        sidecarPort: START_PORT,
        showChips: opts.showChips,
        showRanFor: opts.showRanFor,
      });
    const result = await sweepOnce({ cdpPort: CDP_PORT, expression, log });
    if (/^mounted/.test(result)) injected = true;
    log(result);
  } catch (error) {
    log("sweep error:", String(error.message || error));
  } finally {
    sweeping = false;
  }
}

await sweep();

if (!ONCE) {
  const sweeper = setInterval(() => { sweep().catch(() => {}); }, SWEEP_MS);
  const heartbeat = setInterval(() => lock.touch(), LOCK_TOUCH_MS);
  heartbeat.unref();
  process.on("exit", () => clearInterval(sweeper));
}
