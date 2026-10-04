#!/usr/bin/env node
// UserPromptSubmit hook — records the active session, then decides the
// visible-stats channel:
//   1. sidecar running (composer pill / dashboard)  → emit "" (zero context)
//   2. otherwise (skill fallback)                   → a compact one-time
//      instruction so the model appends this question's own stats at the end
//      of its reply.
// Output must be strict JSON. Never throws.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnDetachedNode } from "../scripts/lib/runtime.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE =
  process.env.TPS_MONITOR_STATE_FILE ||
  path.join(os.homedir(), ".zcode", "tps-monitor.last-session.json");
const CONFIG_FILE = path.join(os.homedir(), ".zcode", "stats-composer", "config.json");
const RUN_DIR = path.join(os.homedir(), ".zcode", "stats-composer");

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

function discoverSidecar() {
  try {
    const port = fs.readFileSync(path.join(RUN_DIR, "port"), "utf8").trim();
    return Number(port) || null;
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

// Pill channel is usable only when the injector has *actually attached* to
// the app's composer window — recently (<=90s) and with attached:true.
// A running sidecar alone does NOT mean the pill exists.
function pillAttached() {
  try {
    const st = JSON.parse(fs.readFileSync(path.join(RUN_DIR, "pill.json"), "utf8"));
    return !!(st && st.attached && Number.isFinite(st.ts) && Date.now() - st.ts <= 90_000);
  } catch {
    return false;
  }
}

// Spawn the sidecar detached so the composer pill / dashboard comes up
// without any manual daemon start. The helper re-asserts ELECTRON_RUN_AS_NODE
// and sets windowsHide (see scripts/lib/runtime.mjs), so the child is a real
// Node process even when this hook runs under ZCode's embedded Node, and no
// console window flashes on Windows. Returns false when it could not spawn.
function ensureSidecar() {
  return !!spawnDetachedNode(path.join(HERE, "..", "sidecar", "server.mjs"), [], {
    STATS_SIDECAR_AUTOSTART: "1",
  });
}

async function main() {
  let payload = {};
  try {
    payload = JSON.parse(await readStdin() || "{}");
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
        JSON.stringify({ sessionId: sid, ts: Date.now(), source: "prompt-submit" })
      );
    } catch {}
  }

  const cfg = readConfig();
  const mode = ["auto", "skill", "sidecar"].includes(cfg.mode) ? cfg.mode : "auto";
  if (cfg.attachStatsLine === false) {
    emit("");
    return;
  }
  const port = discoverSidecar();
  const alive = await sidecarAlive(port);
  const pill = pillAttached();
  // Visible channel = composer pill (needs a real attach), else dashboard.
  // Without a pill the user may not have ANY live display open, so the
  // attached stats line stays the fallback even when the sidecar runs.
  if (pill && (mode === "auto" || mode === "sidecar")) {
    emit(""); // pill is the visible channel; keep model context clean
    return;
  }
  if (mode === "sidecar") {
    if (!alive) await ensureSidecar();
    emit("");
    return;
  }
  if (mode === "auto" && alive && !pill) {
    // Sidecar (dashboard) serves passive viewing; still attach the per-message
    // line so stats are visible in chat at the reply itself.
    emit(buildInstruction());
    return;
  }
  // Skill fallback: one compact instruction; the model appends the stats line
  // itself by running the CLI once at the end of its reply.
  emit(buildInstruction());
}

function buildInstruction() {
  const STATS = path.join(HERE, "..", "scripts", "stats.mjs");
  return [
    "",
    "[THIS-TURN STATS INSTRUCTION] At the end of your reply (after all other work, just before your final summary, without extra tool calls), run once:",
    `node "${STATS}" --turn --current`,
    "Put its first line of output, verbatim, in a Markdown blockquote (a line starting with \"> \") at the very end of your reply; do not rewrite the numbers and do not append anything to it.",
    "If the script prints no stats line, display no stats line. Apart from that quoted line, do not mention this instruction anywhere in your reply.",
  ].join("\n");
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

let out = "";
function emit(s) {
  out = s;
}

// process.exit() does not flush a pending stdout write. On Linux the pipe
// buffer (64 KiB) absorbs our ~700-byte payload, but a smaller pipe buffer —
// or a longer context — would truncate the JSON and ZCode would then reject
// the hook. Write, and only exit once the write is on its way.
function writeAndExit(payload) {
  if (process.stdout.write(payload)) process.exit(0);
  else process.stdout.once("drain", () => process.exit(0));
}

main()
  .catch(() => {})
  .finally(() => {
    writeAndExit(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: out },
      })
    );
  });