#!/usr/bin/env node
// UserPromptSubmit hook — records the active session, then decides the
// visible-stats channel:
//   1. sidecar running (composer pill / dashboard)  → emit "" (zero context)
//   2. otherwise (skill fallback)                   → a compact one-time
//      instruction so the model appends this question's own stats at the end
//      of its reply.
// Output must be strict JSON. Never throws.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sidecarAlive, spawnDetachedNode } from "../scripts/lib/runtime.mjs";
import { readOptions } from "../scripts/lib/options.mjs";
import {
  activeSessionFile,
  statsComposerPillFile,
  statsComposerPortFile,
} from "../scripts/lib/paths.mjs";
import { PILL_ATTACH_TTL_MS } from "../scripts/lib/constants.mjs";
import { readStdin, sessionIdFrom, writeEnvelope } from "../scripts/lib/hook-protocol.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function discoverSidecar() {
  try {
    return Number(fs.readFileSync(statsComposerPortFile(), "utf8").trim()) || null;
  } catch {
    return null;
  }
}

// The pill channel is usable only when the injector has actually attached to
// the app's composer window — recently, and with attached:true. A running
// sidecar alone does NOT mean the pill exists.
function pillAttached() {
  try {
    const state = JSON.parse(fs.readFileSync(statsComposerPillFile(), "utf8"));
    return !!(
      state &&
      state.attached &&
      Number.isFinite(state.ts) &&
      Date.now() - state.ts <= PILL_ATTACH_TTL_MS
    );
  } catch {
    return false;
  }
}

function recordSession(sid) {
  if (!sid) return;
  try {
    fs.mkdirSync(path.dirname(activeSessionFile()), { recursive: true });
    fs.writeFileSync(
      activeSessionFile(),
      JSON.stringify({ sessionId: sid, ts: Date.now(), source: "prompt-submit" })
    );
  } catch { /* an unwritable state dir must not fail the hook */ }
}

function ensureSidecar() {
  return !!spawnDetachedNode(path.join(HERE, "..", "sidecar", "server.mjs"), [], {
    STATS_SIDECAR_AUTOSTART: "1",
  });
}

function buildInstruction() {
  const statsScript = path.join(HERE, "..", "scripts", "stats.mjs");
  return [
    "",
    "[THIS-TURN STATS INSTRUCTION] At the end of your reply (after all other work, just before your final summary, without extra tool calls), run once:",
    `node "${statsScript}" --turn --current`,
    'Put its first line of output, verbatim, in a Markdown blockquote (a line starting with "> ") at the very end of your reply; do not rewrite the numbers and do not append anything to it.',
    "If the script prints no stats line, display no stats line. Apart from that quoted line, do not mention this instruction anywhere in your reply.",
  ].join("\n");
}

async function main() {
  let payload = {};
  try {
    payload = JSON.parse((await readStdin()) || "{}");
  } catch { /* malformed stdin: proceed with no session id */ }
  recordSession(sessionIdFrom(payload));

  const opts = readOptions();
  if (!opts.attachStatsLine) return "";

  const port = discoverSidecar() || opts.port;
  const alive = await sidecarAlive(port);
  const pill = pillAttached();
  // Visible channel = composer pill (needs a real attach), else dashboard.
  // Without a pill the user may not have ANY live display open, so the
  // attached stats line stays the fallback even when the sidecar runs.
  if (pill && opts.mode !== "skill") return "";

  if (opts.mode === "sidecar") {
    if (!alive) ensureSidecar();
    return "";
  }
  // Skill fallback and the auto+sidecar-without-pill case: one compact
  // instruction; the model appends the stats line itself.
  return buildInstruction();
}

main()
  .catch(() => "")
  .then((context) => writeEnvelope("UserPromptSubmit", context));
