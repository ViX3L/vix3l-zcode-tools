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
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnDetachedNode } from "../scripts/lib/runtime.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN_DIR = path.join(os.homedir(), ".zcode", "usage-context");
const CONFIG_FILE = path.join(os.homedir(), ".zcode", "stats-composer", "config.json");
const SC_PORT_FILE = path.join(os.homedir(), ".zcode", "stats-composer", "port");

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

// The sidecar writes its chosen port here; fall back to the configured default.
function sidecarPort(cfg) {
  try {
    const p = Number(fs.readFileSync(SC_PORT_FILE, "utf8").trim());
    if (p) return p;
  } catch {}
  return Number(cfg.sidecarPort) || 7427;
}

async function sidecarAlive(port) {
  if (!port) return false;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 700);
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctl.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

function injectorRunning() {
  try {
    const l = JSON.parse(fs.readFileSync(path.join(RUN_DIR, "injector.lock"), "utf8"));
    if (!l || !l.pid || !l.ts) return false;
    if (Date.now() - l.ts > 45_000) return false;
    try { process.kill(l.pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
  } catch {
    return false;
  }
}

async function main() {
  let payload = {};
  try {
    payload = JSON.parse((await readStdin()) || "{}");
  } catch {}
  const sid =
    payload.session_id ||
    process.env.ZCODE_SESSION_ID ||
    process.env.CLAUDE_SESSION_ID ||
    "";
  if (sid) {
    try {
      fs.mkdirSync(RUN_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(RUN_DIR, "last-session.json"),
        JSON.stringify({ sessionId: sid, ts: Date.now() })
      );
    } catch {}
  }

  const cfg = readConfig();
  const port = sidecarPort(cfg);
  const alive = await sidecarAlive(port);
  // The chips need a data source; without the stats-composer sidecar there is
  // nothing to show, so do not start a doomed injector — tell the user instead.
  if (!alive) {
    return `usage-context: stats-composer sidecar is not reachable on port ${port}, so per-turn usage chips stay hidden. Install/enable the stats-composer plugin (it owns the usage DB reader) and they will appear on the next session.`;
  }
  if (!injectorRunning()) {
    // Awaited on purpose: the hook's finally() exits the process right after
    // main() resolves, which would kill a fire-and-forget import. Detached so
    // the injector outlives this short-lived hook process.
    try {
      fs.mkdirSync(RUN_DIR, { recursive: true });
      spawnDetachedNode(path.join(HERE, "..", "injector", "inject.mjs"), ["--sidecar-port", String(port)]);
    } catch {
      /* best effort: the user can still run the injector by hand */
    }
  }
  return "";
}

function readStdin() {
  return new Promise((resolve) => {
    let raw = "";
    let done = false;
    const finish = () => (done ? null : ((done = true), resolve(raw)));
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", finish);
    setTimeout(finish, 1500);
  });
}

// process.exit() does not flush a pending stdout write; wait for the drain.
function writeAndExit(out) {
  if (process.stdout.write(out)) process.exit(0);
  else process.stdout.once("drain", () => process.exit(0));
}

main()
  .then((ctx) =>
    writeAndExit(
      JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: ctx } })
    )
  )
  .catch(() => process.exit(0));
