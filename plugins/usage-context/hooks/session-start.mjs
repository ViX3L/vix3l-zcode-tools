#!/usr/bin/env node
// SessionStart hook — starts the usage-context injector so the per-turn chips
// appear without the user running anything by hand. Output must be strict JSON.
//
// This plugin has NO server of its own: it reads per-turn usage from the
// stats-composer sidecar's /turn endpoint. So this hook only (a) checks whether
// that sidecar is reachable and (b) starts this plugin's injector, which is a
// small CDP client that mounts the chips in the renderer. If stats-composer is
// absent the injector simply renders nothing, and this hook says so rather than
// failing.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sidecarAlive, spawnDetachedNode } from "../scripts/lib/runtime.mjs";
import { readOptions } from "../scripts/lib/options.mjs";
import { statsComposerPortFile, pluginStateDir } from "../scripts/lib/paths.mjs";
import { readLock } from "../scripts/lib/lock.mjs";
import { LOCK_STALE_MS } from "../scripts/lib/constants.mjs";
import { readStdin, writeEnvelope } from "../scripts/lib/hook-protocol.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCK_FILE = path.join(pluginStateDir("usage-context"), "injector.lock");

// stats-composer's own SessionStart hook starts the sidecar without waiting,
// and both plugins' hooks fire in the same burst. A single probe therefore
// races the sidecar's startup: if this hook wins, the chips stay hidden for the
// whole session. Poll briefly instead. The port file is re-read on every
// attempt because a sidecar configured on a custom port publishes it only once
// it has bound.
const SIDECAR_WAIT_MS = 2000;
const SIDECAR_POLL_MS = 100;

function sidecarPort(opts) {
  try {
    const port = Number(fs.readFileSync(statsComposerPortFile(), "utf8").trim());
    if (port) return port;
  } catch { /* no port file: fall back to the configured port */ }
  return opts.sidecarPort;
}

async function waitForSidecar(opts) {
  const deadline = Date.now() + SIDECAR_WAIT_MS;
  for (;;) {
    const port = sidecarPort(opts);
    if (await sidecarAlive(port, 500)) return { alive: true, port };
    if (Date.now() >= deadline) return { alive: false, port };
    await new Promise((resolve) => setTimeout(resolve, SIDECAR_POLL_MS));
  }
}

function injectorRunning() {
  const lock = readLock(LOCK_FILE, { staleMs: LOCK_STALE_MS });
  if (!lock || !lock.fresh || !lock.pid) return false;
  try {
    process.kill(lock.pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function main() {
  try {
    JSON.parse((await readStdin()) || "{}");
  } catch { /* malformed stdin must not fail session start */ }
  const opts = readOptions();
  if (!opts.showChips) return "";

  const { alive, port } = await waitForSidecar(opts);
  // The chips need a data source; without the stats-composer sidecar there is
  // nothing to show, so do not start a doomed injector — tell the user instead.
  if (!alive) {
    return `usage-context: stats-composer sidecar is not reachable on port ${port}, so per-turn usage chips stay hidden. Install/enable the stats-composer plugin (it owns the usage DB reader) and they will appear on the next session.`;
  }
  if (!injectorRunning()) {
    spawnDetachedNode(
      path.join(HERE, "..", "injector", "inject.mjs"),
      ["--sidecar-port", String(port)]
    );
  }
  return "";
}

main()
  .catch(() => "")
  .then((context) => writeEnvelope("SessionStart", context));
