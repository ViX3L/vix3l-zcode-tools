#!/usr/bin/env node
// SessionStart hook — records the active session and (in auto/sidecar mode)
// best-effort spawns the stats sidecar so a sidecar started manually once
// survives app restarts without user action. Output must be strict JSON.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnDetachedNode } from "../scripts/lib/runtime.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE =
  process.env.TPS_MONITOR_STATE_FILE ||
  path.join(os.homedir(), ".zcode", "tps-monitor.last-session.json");
const RUN_DIR = path.join(os.homedir(), ".zcode", "stats-composer");
const CONFIG_FILE = path.join(os.homedir(), ".zcode", "stats-composer", "config.json");

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

function discoverSidecar() {
  try {
    return Number(fs.readFileSync(path.join(RUN_DIR, "port"), "utf8").trim()) || null;
  } catch {
    return null;
  }
}

async function sidecarAlive(port) {
  if (!port) return false;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 500);
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctl.signal });
    clearTimeout(t);
    return r.ok;
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
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      fs.writeFileSync(
        STATE_FILE,
        JSON.stringify({ sessionId: sid, ts: Date.now(), source: "session-start" })
      );
    } catch {}
  }
  const cfg = readConfig();
  const mode = ["auto", "skill", "sidecar"].includes(cfg.mode) ? cfg.mode : "auto";
  if (mode === "auto" || mode === "sidecar") {
    const port = discoverSidecar();
    if (!(await sidecarAlive(port))) {
      // Awaited on purpose: the hook's finally() calls process.exit(0) right
      // after main() resolves, which would kill a fire-and-forget import.
      // spawnDetachedNode re-asserts ELECTRON_RUN_AS_NODE and sets windowsHide
      // (see scripts/lib/runtime.mjs) so this works under ZCode's embedded Node
      // and on Windows alike.
      spawnDetachedNode(path.join(HERE, "..", "sidecar", "server.mjs"), [], {
        STATS_SIDECAR_AUTOSTART: "1",
      });
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

// process.exit() does not flush a pending stdout write; wait for the write to
// drain before exiting so the JSON is never truncated (see prompt-submit.mjs).
function writeAndExit(payload) {
  if (process.stdout.write(payload)) process.exit(0);
  else process.stdout.once("drain", () => process.exit(0));
}

main()
  .then((ctx) =>
    writeAndExit(
      JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: ctx } })
    )
  )
  .catch(() => process.exit(0));