#!/usr/bin/env node
// SessionStart hook — records the active session and (in auto/sidecar mode)
// best-effort spawns the stats sidecar so a sidecar started manually once
// survives app restarts without user action. Output must be strict JSON even
// when the work throws: a hook without an envelope is silently dropped.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sidecarAlive, spawnDetachedNode } from "../scripts/lib/runtime.mjs";
import { readOptions } from "../scripts/lib/options.mjs";
import { statsComposerPortFile, activeSessionFile } from "../scripts/lib/paths.mjs";
import { readStdin, sessionIdFrom, writeEnvelope } from "../scripts/lib/hook-protocol.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function discoverSidecar() {
  try {
    return Number(fs.readFileSync(statsComposerPortFile(), "utf8").trim()) || null;
  } catch {
    return null;
  }
}

function recordSession(sid) {
  if (!sid) return;
  try {
    fs.mkdirSync(path.dirname(activeSessionFile()), { recursive: true });
    fs.writeFileSync(
      activeSessionFile(),
      JSON.stringify({ sessionId: sid, ts: Date.now(), source: "session-start" })
    );
  } catch { /* an unwritable state dir must not fail the hook */ }
}

async function main() {
  let payload = {};
  try {
    payload = JSON.parse((await readStdin()) || "{}");
  } catch { /* malformed stdin: proceed with no session id */ }
  recordSession(sessionIdFrom(payload));

  const opts = readOptions();
  if (opts.mode !== "auto" && opts.mode !== "sidecar") return "";
  const port = discoverSidecar() || opts.port;
  if (await sidecarAlive(port)) return "";

  // Awaited on purpose: writeEnvelope exits right after main() resolves, which
  // would kill a fire-and-forget child. spawnDetachedNode re-asserts
  // ELECTRON_RUN_AS_NODE and sets windowsHide, so this works under ZCode's
  // embedded Node and on Windows alike.
  spawnDetachedNode(path.join(HERE, "..", "sidecar", "server.mjs"), [], {
    STATS_SIDECAR_AUTOSTART: "1",
  });
  return "";
}

main()
  .catch(() => "")
  .finally(() => writeEnvelope("SessionStart", ""));
