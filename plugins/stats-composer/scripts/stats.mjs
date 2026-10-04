#!/usr/bin/env node
// stats.mjs — CLI for per-request TPS / TTFT stats from ZCode's usage DB.
//
// Usage:
//   node stats.mjs                      latest request + session summary
//   node stats.mjs --turn               latest turn (one user question) stats
//   node stats.mjs --turn --current     same, but silent when the latest turn
//                                       predates this prompt (guard against
//                                       showing the previous question's data)
//   node stats.mjs --watch [s]          refresh every second for s seconds
//   node stats.mjs --json               machine-readable
//   ZCODE_SESSION_ID=... node stats.mjs   scope to one session
//
// Only reads the WAL sqlite db (readOnly). Never blocks, never writes.

process.removeAllListeners("warning");
process.on("warning", () => {});

import * as m from "./lib/metrics.mjs";

const args = process.argv.slice(2);
const wantJson = args.includes("--json");
const wantTurn = args.includes("--turn");
const currentGuard = args.includes("--current");
const watchIdx = args.indexOf("--watch");
const watchSecs = watchIdx >= 0 ? Number(args[watchIdx + 1]) || 5 : 0;

// --current: the turn must have started after this prompt was submitted.
// The prompt-submit hook records the question timestamp in the state file.
function promptTs() {
  try {
    const st = JSON.parse(
      fsRead(m.stateFile())
    );
    return Number(st.ts) || 0;
  } catch {
    return 0;
  }
}
import fs from "node:fs";
function fsRead(p) {
  return fs.readFileSync(p, "utf8");
}

function render(db) {
  const sid = m.resolveSession(process.env.ZCODE_SESSION_ID || null);
  if (!sid) {
    if (wantJson) return { error: "no session" };
    return "No session detected yet — send a message in ZCode first.";
  }
  if (wantTurn) {
    // --current scopes the (possibly resumed) turn to requests started after
    // this prompt was submitted; without --current the whole turn is shown.
    const turn = m.lastTurnStats(db, sid, currentGuard ? promptTs() : undefined);
    if (!turn || !turn.samples) {
      if (currentGuard) return ""; // this question has no data yet -> stay silent, never show the previous turn
      if (wantJson) return { turn: null };
      return "No completed request samples for the current turn yet.";
    }
    if (wantJson) return { turn };
    return m.formatTurnLine(turn);
  }
  const snap = m.fullSnapshot(db, sid, { window: 10 });
  if (wantJson) return snap;
  return [
    m.formatLine(snap.last || {}),
    m.formatSnapshot(snap),
  ].join("\n");
}

function print(db) {
  const out = render(db);
  if (out == null || out === "") return;
  if (typeof out === "string") process.stdout.write(out + "\n");
  else process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}

const db = m.openDb();
try {
  if (watchSecs > 0) {
    const end = Date.now() + watchSecs * 1000;
    while (Date.now() < end) {
      process.stdout.write("\x1b[2J\x1b[H");
      print(db);
      await new Promise((r) => setTimeout(r, 1000));
    }
  } else {
    print(db);
  }
} finally {
  try { db.close(); } catch {}
}