#!/usr/bin/env node
// stats-composer sidecar — a tiny localhost HTTP server (default :7427) that
// serves per-request TPS / TTFT stats from ZCode's usage DB.
//
// Endpoints (all JSON unless noted):
//   GET /health                     → {ok:true, uptime}
//   GET /stats                      → full snapshot (last/window/session/live)
//   GET /stats.json                 → same, explicit
//   GET /metrics                    → Prometheus text format
//   GET /turn[?session=&msg=]       → per-turn token usage (turn_usage table);
//                                     consumed by the usage-context plugin
//   GET /dashboard                  → auto-refresh HTML dashboard
//
// This is the visible-stats channel when the composer pill is unavailable.
// It binds 127.0.0.1 only. The port file (~/.zcode/stats-composer/port) lets
// hooks, CLI and the injector discover the running instance; a stale port
// file is detected via /health and replaced.

process.removeAllListeners("warning");
process.on("warning", () => {});
const { createServer } = await import("node:http");
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as metrics from "../scripts/lib/metrics.mjs";
import { spawnAttachedNode } from "../scripts/lib/runtime.mjs";

const RUN_DIR = path.join(os.homedir(), ".zcode", "stats-composer");
const CONFIG_FILE = path.join(RUN_DIR, "config.json");

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

const cfg = readConfig();
const PORT = Number(process.env.STATS_SIDECAR_PORT) || Number(cfg.port) || 7427;
const WINDOW = Number(cfg.window) || 10;
const LIVE = cfg.live !== false;

// Extra data the dashboard needs (the per-request table and last-turn stats).
// Computed LAZILY and cached: the pill — the high-frequency reader — never
// asks for it, so it must not be part of the steady-state refresh cost. Each
// extra is a pair of session queries, so recomputing them on every tick while
// nobody is looking is exactly the resource waste this plugin must avoid.
// `EXTRAS_DEMAND` records when the dashboard last actually asked; refresh
// stops once that goes cold, so an opened-then-closed dashboard costs nothing.
const DASHBOARD_TTL_MS = 4000;      // serve a cached extra set for this long
const EXTRAS_IDLE_MS = 30_000;      // stop recomputing extras after this long
let FULL_EXTRAS = null;
let FULL_EXTRAS_AT = 0;
let FULL_EXTRAS_DBV = null;
let EXTRAS_DEMAND = 0;
// The whole session's request rows, cached separately from the derived extras
// because they are only needed by the table: the dashboard asks for one page at
// a time through /requests, and that page is sliced from this list. A long
// session makes this list long, so it is rebuilt only when the session's rows
// actually change (its own db-version stamp), not on every extras tick.
let ALL_REQUESTS = null;
let ALL_REQUESTS_SID = null;
let ALL_REQUESTS_DBV = null;
function refreshFullExtras(db, snap, dbv) {
  if (!db || !snap || snap.error) return;
  try {
    const sid = snap.sessionId;
    const lastTurn = metrics.lastTurnStats(db, sid);
    const extras = lastTurn ? { lastTurn } : {};
    FULL_EXTRAS = extras;
    FULL_EXTRAS_AT = Date.now();
    FULL_EXTRAS_DBV = dbv;
  } catch {
    /* keep last good extras */
  }
}
// All request rows for a session, newest first, rebuilt only when the session's
// completed rows have moved. Returns [] until a session is known.
function allRequests() {
  const sid = (SNAP && SNAP.sessionId) || null;
  const dbv = dbVersion();
  if (!sid) return [];
  if (ALL_REQUESTS && ALL_REQUESTS_SID === sid && ALL_REQUESTS_DBV === dbv) return ALL_REQUESTS;
  let db = null;
  try {
    db = metrics.openDb();
    ALL_REQUESTS = metrics.sessionRequests(db, sid);
    ALL_REQUESTS_SID = sid;
    ALL_REQUESTS_DBV = dbv;
  } catch {
    /* keep the previous list rather than blanking the table */
  } finally {
    try { db && db.close(); } catch {}
  }
  return ALL_REQUESTS || [];
}

// One page of the per-request table: sorted server-side over the FULL session,
// then sliced, so "page 7 of 240" is real history rather than a window inside
// the first 500 rows. Sorting here (not in the browser) is what lets the table
// be unbounded without shipping every row on every poll.
const REQ_SORTS = {
  completedAt: (r) => r.completedAt ?? -Infinity,
  model: (r) => r.model ?? "",
  tokPerSec: (r) => r.tokPerSec ?? -Infinity,
  ttftMs: (r) => r.ttftMs ?? -Infinity,
  out: (r) => (r.outputTokens || 0) + (r.reasoningTokens || 0),
  cacheRead: (r) => r.cacheRead ?? -Infinity,
  status: (r) => r.status ?? "",
};
function requestsPage(offset, limit, sortKey, desc) {
  const rows = allRequests();
  const key = REQ_SORTS[sortKey] ? sortKey : "completedAt";
  const pick = REQ_SORTS[key];
  const dir = desc ? -1 : 1;
  const sorted = rows.slice().sort((a, b) => {
    const av = pick(a), bv = pick(b);
    const cmp = typeof av === "string" ? String(av).localeCompare(String(bv)) : av - bv;
    return cmp * dir;
  });
  const off = Math.max(0, Math.min(offset | 0, Math.max(0, sorted.length - 1)));
  const lim = Math.max(1, Math.min(limit | 0 || 10, 500));
  const pageRows = sorted.slice(off, off + lim).map((x) => ({ ...x, out: (x.outputTokens || 0) + (x.reasoningTokens || 0) }));
  return { rows: pageRows, total: sorted.length, offset: off, limit: lim, sortKey: key, sortDesc: !!desc };
}

// Snapshot is produced by a BACKGROUND refresher and served from memory.
// node:sqlite is synchronous, so computing a snapshot inside a request handler
// blocked the event loop for ~120ms; with several pollers (the pill, the
// dashboard, monitors) that saturated the loop and pushed first-byte latency
// past the pill's fetch timeout. Preparing data ahead of time — the same
// principle the app's own context panel uses — decouples client count from
// DB cost: at most one scan per interval, no matter how many readers.
const REFRESH_MS = Number(cfg.refreshMs) || 900;
let SNAP = null; // last good snapshot (never contains an error)
let SNAP_ERR = null;
let SNAP_AT = 0;

// Which session the visible surface is looking at. The composer pill reads the
// session id the app is CURRENTLY displaying (the [data-session-id] node) and
// passes it as ?session=, so opening a different chat re-scopes the numbers at
// once. Without this the sidecar followed the last session a HOOK saw (the last
// prompt submit), so a brand-new chat showed the previous chat's tok/s until
// its first message. Null falls back to that hook-recorded session.
let REQUESTED_SID = null;
const SID_RE = /^sess_[A-Za-z0-9_-]+$/;
function requestSession(sid) {
  if (typeof sid !== "string" || !SID_RE.test(sid) || sid === REQUESTED_SID) return false;
  REQUESTED_SID = sid;
  return true; // caller forces a refresh so the switch is immediate
}

// The usage DB IS indexed, but none of its indexes covers the ORDER BY these
// queries need, so a session query still sorts in a temp B-tree and a full
// refresh costs ~15 ms of synchronous work. Doing that on a fast timer burned
// ~30% of a core even when nothing had changed. The db file's mtime (plus its
// size, WAL included) is a cheap change signal: when it has not moved, the
// previously computed snapshot is still correct and we skip the scans
// entirely. The pill's own value changes on every request, so responsiveness
// is unaffected.
function dbVersion() {
  try {
    const st = fs.statSync(metrics.DB_PATH);
    let wal = 0, walM = 0;
    try { const w = fs.statSync(metrics.DB_PATH + "-wal"); wal = w.size; walM = w.mtimeMs; } catch {}
    return `${st.size}:${st.mtimeMs}:${wal}:${walM}`;
  } catch {
    return "none";
  }
}
let lastDbVersion = null;

// A running request changes the pill's live indicator even without a DB write,
// so still refresh on a slow tick while a request is in flight.
function needsRefresh() {
  const v = dbVersion();
  if (v !== "none" && v === lastDbVersion) return false;
  lastDbVersion = v;
  return true;
}

// Refresh counters, exposed via /health for diagnosing CPU questions.
let REFRESH_COUNT = 0;
let REFRESH_SKIP = 0;
// Cost of the last real (non-skipped) refresh and an exponential moving average,
// so "is this plugin heavy?" can be answered from /health instead of guessed.
let REFRESH_LAST_MS = 0;
let REFRESH_AVG_MS = 0;

// Row-scan cache shared across refreshes: `sessionSnapshot` reuses the previous
// scan (and its per-row projection) unless a request has actually completed, so
// a long session's ~1.3k rows are not re-read and re-projected every tick.
const SNAP_CACHE = {};

function refreshSnapshot(force) {
  if (!force && !needsRefresh()) { REFRESH_SKIP++; return; }
  REFRESH_COUNT++;
  const startedNs = process.hrtime.bigint();
  let db = null;
  try {
    db = metrics.openDb();
    const snap = metrics.sessionSnapshot(db, REQUESTED_SID, { window: WINDOW, live: LIVE, cache: SNAP_CACHE });
    // Session turn/step totals for the card's hover panel. One indexed
    // aggregate on turn_usage's (session_id, turn_id) primary key, so it rides
    // the same DB-change gate as the rest of the snapshot rather than adding a
    // query to the hot read path.
    try {
      snap.turns = metrics.turnTotals(db, snap.sessionId);
    } catch { /* older DB without turn_usage: leave it absent */ }
    // Subagent activity — a SEPARATE surface, never merged into the session
    // figures above. Subagent requests live in their own sessions and cannot be
    // linked to a parent turn (see metrics.subagentActivity for the evidence),
    // so this reports the last 15 minutes machine-wide. It rides the same
    // DB-change gate as everything else here, so it adds no hot-path query on a
    // tick where nothing landed.
    try {
      snap.subagents = metrics.subagentActivity(db);
    } catch { /* leave absent on an older DB */ }
    snap.plugin = { name: "stats-composer", version: VERSION };
    SNAP = snap;
    SNAP_ERR = null;
    SNAP_AT = Date.now();
    lastDbVersion = dbVersion();
    // Dashboard extras run on their own cadence, and only while the dashboard
    // has asked for them recently — see dashboardExtras().
    if (EXTRAS_DEMAND && Date.now() - EXTRAS_DEMAND < EXTRAS_IDLE_MS &&
        FULL_EXTRAS_AT && Date.now() - FULL_EXTRAS_AT > DASHBOARD_TTL_MS) {
      refreshFullExtras(db, snap, lastDbVersion);
    }
  } catch (e) {
    SNAP_ERR = String((e && e.message) || e);
  } finally {
    try { db && db.close(); } catch {}
    REFRESH_LAST_MS = Number(process.hrtime.bigint() - startedNs) / 1e6;
    REFRESH_AVG_MS = REFRESH_AVG_MS ? REFRESH_AVG_MS * 0.8 + REFRESH_LAST_MS * 0.2 : REFRESH_LAST_MS;
  }
}

// The dashboard polls /stats?full=1 every 2 s; its extras are cached for a
// few seconds so its read path stays off the DB in the common case. Asking
// here marks demand, which is what keeps the background refresh running; when
// the dashboard goes away, the mark goes cold within EXTRAS_IDLE_MS and the
// extras stop being recomputed.
function dashboardExtras() {
  EXTRAS_DEMAND = Date.now();
  if (FULL_EXTRAS && Date.now() - FULL_EXTRAS_AT < DASHBOARD_TTL_MS) return FULL_EXTRAS;
  if (!SNAP || SNAP.error) return FULL_EXTRAS || {};
  let db = null;
  try {
    db = metrics.openDb();
    refreshFullExtras(db, SNAP, dbVersion());
  } catch {
    /* keep last good */
  } finally {
    try { db && db.close(); } catch {}
  }
  return FULL_EXTRAS || {};
}

// Handlers read this: never blocks, never opens the DB.
function snapshotJson() {
  if (!SNAP) refreshSnapshot(true);
  if (SNAP) return SNAP;
  return { error: SNAP_ERR || "no data", dbInfo: metrics.dbInfo() };
}

// Refresh cadence follows demand: only keep scanning while someone is reading
// (the pill polls every second, so this is effectively continuous while the
// app is open), and go quiet when nothing has asked for a while.
let lastDemand = 0;
function noteDemand() { lastDemand = Date.now(); }
let refresher = null;
function startRefresher() {
  if (refresher) return;
  refresher = setInterval(() => {
    if (Date.now() - lastDemand > 60_000) return; // idle: stop burning CPU
    refreshSnapshot(false);
  }, REFRESH_MS);
  refresher.unref?.();
}
startRefresher();
refreshSnapshot(true);

function prometheus(snap) {
  const lines = [];
  const push = (name, help, val, labels = "") => {
    if (val == null || Number.isNaN(val)) return;
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name}${labels} ${val}`);
  };
  push("zcode_tps_last", "Last completed model request output tokens/sec", snap.last?.tokPerSec);
  push("zcode_ttft_last_ms", "Last completed request time-to-first-token (ms)", snap.last?.ttftMs);
  push("zcode_tps_window_avg", `Average tok/s over last ${snap.window?.window ?? "?"} requests`, snap.window?.avgTps);
  push("zcode_tps_window_peak", "Peak tok/s in the recent window", snap.window?.peakTps);
  push("zcode_ttft_window_avg_ms", "Average TTFT over the recent window (ms)", snap.window?.avgTtftMs);
  push(
    "zcode_output_tokens_session_total",
    "Total output tokens this session",
    snap.session ? (snap.session.outputTokens || 0) + (snap.session.reasoningTokens || 0) : null
  );
  if (snap.live?.streaming) {
    push("zcode_live_est_tps", "Estimated live tok/s (interpolated from last completed request)", snap.live.estTps);
    lines.push("# TYPE zcode_live_streaming gauge", "zcode_live_streaming 1");
  }
  return lines.join("\n") + "\n";
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
const fmt = (v, s = "") => (v == null ? "—" : `${v}${s}`);
const msv = (v) => (v == null ? "—" : v >= 10000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`);

function dashboardHtml() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Session statistics · ZCode</title>
<script>
// Restore the remembered theme BEFORE first paint, so a light-theme reader
// never sees a dark flash on load. Kept inline and above the stylesheet: a
// deferred or module script would run after the body has already painted.
try {
  var t = localStorage.getItem('sc-theme');
  if (t === 'light') document.documentElement.setAttribute('data-theme', 'light');
} catch (e) {}
</script>
<style>
  /* Theme is a set of custom properties so dark/light is a ONE-ATTRIBUTE swap
     on <html> — no second stylesheet, no reload, no flicker. Dark stays the
     default (color-scheme: dark) because the app it sits beside is dark by
     default; the toggle below writes data-theme and persists it. */
  :root, :root[data-theme="dark"] {
    color-scheme: dark;
    --bg: #0e1116; --panel: #161b23; --panel2: #12171e; --border: #232b36;
    --border-hi: #3a4553; --fg: #dbe2ea; --fg-hi: #ffffff; --muted: #7d8794;
    --accent: #4ade80; --ok: #4ade80; --err: #f87171; --cxl: #fbbf24;
    --track: #232b36;
  }
  :root[data-theme="light"] {
    color-scheme: light;
    --bg: #f5f7fa; --panel: #ffffff; --panel2: #f0f3f7; --border: #d7dee6;
    --border-hi: #b6c1cd; --fg: #1f2933; --fg-hi: #0b1116; --muted: #5b6673;
    --accent: #15803d; --ok: #15803d; --err: #dc2626; --cxl: #b45309;
    --track: #e3e8ee;
  }
  /* Only colors/text change in place; never the whole document — constant
     full-screen rewrites are a flicker/photosensitivity hazard. */
  body { font: 14px/1.6 -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif;
         background: var(--bg); color: var(--fg); margin: 0; padding: 24px;
         transition: background .15s linear, color .15s linear; }
  h1 { font-size: 18px; margin: 0 0 4px; display: flex; align-items: center; gap: 8px; }
  h1 .logo { flex: 0 0 auto; }
  .sub { color: var(--muted); font-size: 12px; margin-bottom: 20px; }
  .bar { display: flex; align-items: center; gap: 10px; max-width: 1100px; margin-bottom: 14px; flex-wrap: wrap; }
  .badge { display: inline-flex; align-items: center; gap: 6px; font-size: 12px;
           border: 1px solid var(--border); border-radius: 999px; padding: 3px 10px; color: var(--muted); }
  /* Buttons carry a real hit area: the visible pill is 12px of text, so a
     pseudo-element extends the target to ~40px without changing the layout —
     below that, pointer accuracy suffers on the small "refresh" and theme
     controls. Press feedback is a 0.96 scale, and only transform+color
     transition (never "all") so nothing else animates by accident. */
  .badge button { position: relative; background: none; border: 0; color: var(--fg); cursor: pointer;
                  font: inherit; display: inline-flex; align-items: center; gap: 6px; padding: 0;
                  transition: color .15s ease-out, transform .12s cubic-bezier(0.16,1,0.3,1); }
  .badge button::after { content: ""; position: absolute; inset: -12px -8px; }
  .badge button:hover { color: var(--fg-hi); }
  .badge button:active { transform: scale(0.96); }
  .badge:has(button:focus-visible) { border-color: var(--border-hi); }
  .badge button:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 4px; }
  .badge .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); }
  .badge.off .dot { background: var(--muted); }
  .spin { animation: rot 0.9s linear infinite; }
  @keyframes rot { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) {
    .badge button, .donutwrap svg circle, body { transition: none; }
    .spin { animation: none; }
  }
  /* Top region: the headline cards on the left, the model split on the right.
     Explicit two columns rather than auto-fit — the right half of this row was
     empty before (four auto-fit cards never reached it), and the model mix is
     the natural thing to put there. Collapses to one column on narrow windows. */
  .top { display: grid; grid-template-columns: minmax(0, 1.28fr) minmax(300px, 1fr);
         gap: 14px; max-width: 1100px; align-items: stretch; }
  .cards { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 16px 18px; }
  .card .k { color: var(--muted); font-size: 12px; }
  .card .v { font-size: 30px; font-weight: 650; font-variant-numeric: tabular-nums; margin-top: 2px; }
  .card .n { color: var(--muted); font-size: 12px; margin-top: 2px; }
  /* Model-mix panel (donut + legend). The donut sits on its own row with the
     figures BELOW it rather than inside the ring: at any usable ring size a
     six-character number and an eleven-character caption are wider than the
     hole, so a centered overlay crowds the stroke and reads as overlap. Below
     the ring there is room at every size, and the ring keeps the full 152px.
     The ring group centers in the space left over; the legend pins to the
     bottom, so the panel fills its grid cell without a dead gap. */
  .model { display: flex; flex-direction: column; }
  .mixbody { display: flex; flex-direction: column; gap: 12px; margin-top: 10px; flex: 1; min-height: 0; }
  .donutarea { flex: 1 1 auto; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 0; }
  .donutwrap { position: relative; flex: 0 0 auto; width: 152px; height: 152px; }
  .donutwrap svg { display: block; width: 100%; height: 100%; }
  .donutwrap svg circle { transition: stroke-dasharray .35s cubic-bezier(0.16,1,0.3,1),
                                      stroke-dashoffset .35s cubic-bezier(0.16,1,0.3,1); }
  .dcenter { text-align: center; margin-top: 8px; }
  .dcenter .big { font-size: 22px; font-weight: 650; font-variant-numeric: tabular-nums; line-height: 1.15; }
  .dcenter .big:empty { display: none; }
  .dcenter .cap { font-size: 10.5px; color: var(--muted); letter-spacing: .06em; text-transform: uppercase; margin-top: 1px; }
  /* Legend: one row per model. A grid so swatch / name / percent line up as
     columns down the list. Each row's swatch is its slice's colour, so the
     list is the ring's key without needing a second encoding. */
  .legend { flex: 0 0 auto; min-width: 0; display: flex; flex-direction: column; gap: 8px;
            border-top: 1px solid var(--border); padding-top: 12px; }
  .lrow { display: grid; grid-template-columns: 10px minmax(0, 1fr) auto; align-items: center; gap: 9px; font-size: 12.5px; }
  .lrow .sw { width: 10px; height: 10px; border-radius: 3px; }
  .lrow .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg); }
  .lrow .tk { color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
  .lrow .pc { font-size: 12.5px; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
  table { border-collapse: collapse; margin-top: 22px; max-width: 1100px; width: 100%; font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--border); font-size: 13px; }
  th { color: var(--muted); font-weight: 500; cursor: pointer; user-select: none; white-space: nowrap; }
  th:hover { color: var(--fg); }
  th .arrow { font-size: 10px; margin-left: 4px; color: var(--accent); }
  /* Pagination: a long session produces thousands of rows, which previously
     made the table run the full height of the page and forced endless
     scrolling. Ten rows per page keeps the whole view on one screen. */
  .pager { display: flex; align-items: center; gap: 10px; max-width: 1100px;
           margin-top: 12px; color: var(--muted); font-size: 12px; }
  .pager button { background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
                  color: var(--fg); cursor: pointer; font: inherit; padding: 5px 12px; min-height: 30px;
                  transition: border-color .15s ease-out, color .15s ease-out, transform .12s cubic-bezier(0.16,1,0.3,1); }
  .pager button:hover:not(:disabled) { border-color: var(--border-hi); color: var(--fg-hi); }
  .pager button:active:not(:disabled) { transform: scale(0.96); }
  .pager button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .pager button:disabled { opacity: .4; cursor: default; }
  .pager .pg { font-variant-numeric: tabular-nums; }
  th:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .ok { color: var(--ok); } .err { color: var(--err); } .cxl { color: var(--cxl); }
  @media (max-width: 860px) {
    .top { grid-template-columns: minmax(0, 1fr); }
    .cards { grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
  }
</style></head><body>
<h1><svg class="logo" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M13 2 4.5 13.2h6L11 22l8.5-11.2h-6z" fill="var(--accent)"/></svg> Session statistics</h1>
<div class="sub">ZCode · stats-composer · read-only on the usage DB, cannot affect the running client · newest request first · click a column header to toggle its sort</div>
<div class="bar">
  <span class="badge" id="refreshBadge">
    <button id="toggleAuto" title="Toggle auto-refresh (updates in place, never reloads the page)">
      <span class="dot"></span><span id="autoLabel">Auto-refresh: on</span>
    </button>
  </span>
  <span class="badge"><button id="refreshNow" title="Refresh now"><span id="ricon">⟳</span> refresh</button></span>
  <span class="badge"><button id="themeToggle" title="Switch between dark and light theme"><span id="themeIcon">☾</span><span id="themeLabel">Dark</span></button></span>
  <span class="sub" id="updated" style="margin:0"></span>
</div>
<div class="top">
  <div class="cards" id="cards"></div>
  <div class="card model" id="modelCard">
    <div class="k" id="modelTitle">Model mix</div>
    <div class="mixbody">
      <div class="donutarea">
        <div class="donutwrap" id="donutwrap">
          <svg id="donut" viewBox="0 0 42 42" role="img" aria-label="Share of generated tokens by model"></svg>
        </div>
        <div class="dcenter"><div class="big" id="donutPct">—</div><div class="cap" id="donutCap">generated tokens</div></div>
      </div>
      <div class="legend" id="legend"></div>
    </div>
  </div>
</div>
<table id="tbl"><thead><tr>
<th data-k="completedAt" data-label="Time">Time</th><th data-k="model" data-label="Model">Model</th><th data-k="tokPerSec" data-label="tok/s">tok/s</th><th data-k="ttftMs" data-label="TTFT">TTFT</th><th data-k="out" data-label="Output tok">Output tok</th><th data-k="cacheRead" data-label="Cache read">Cache read</th><th data-k="status" data-label="Status">Status</th>
</tr></thead><tbody></tbody></table>
<div class="pager" id="pager">
  <button id="prev" title="Previous page">‹ prev</button>
  <span class="pg" id="pageInfo">—</span>
  <button id="next" title="Next page">next ›</button>
</div>
<script>
// Data update strategy: every fetch re-renders ONLY changed values/rows in
// place (keyed by request id). The document itself never reloads or
// re-parses, so nothing flickers — updates are per-element text swaps.
let sortKey = 'completedAt', sortDesc = true;
let auto = true, busy = false, lastSig = '';
const PAGE_SIZE = 10;
let page = 0;                    // 0-based; clamped to the last page each render
let total = 0, pages = 1;
// ---- theme ----
// One attribute on <html> flips every colour (see the stylesheet's custom
// properties). The choice is remembered in localStorage so it survives the
// reload the user does when they come back to this page.
function setTheme(t){
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('sc-theme', t); } catch (e) {}
  const i = document.getElementById('themeIcon'), l = document.getElementById('themeLabel');
  if (i) i.textContent = t === 'dark' ? '\u263E' : '\u2600';
  if (l) l.textContent = t === 'dark' ? 'Dark' : 'Light';
}
document.getElementById('themeToggle').addEventListener('click', () => {
  setTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light');
});
setTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');
// ---- formatting ----
function card(k,v,n){ return '<div class="card"><div class="k">'+k+'</div><div class="v">'+v+'</div><div class="n">'+(n||'')+'</div></div>'; }
function ms(v){ return v==null?'—':(v>=10000?(v/1000).toFixed(1)+'s':Math.round(v)+'ms'); }
function dur(v){ return v==null?'—':(v>=60000?(v/60000).toFixed(1)+'m':ms(v)); }
function tokN(v){ if(v==null) return '—'; if(v>=1e6) return (v/1e6).toFixed(2)+'M'; if(v>=1e3) return (v/1e3).toFixed(1)+'k'; return String(v); }
// ---- model mix (donut + legend) ----
// Palette chosen to stay distinguishable on both themes and to not rely on
// green/red (those carry status meaning elsewhere on this page). The first
// colour is the page accent, so a single-model session reads as "the" accent
// rather than one arbitrary hue from a list.
const PALETTE = ['#60a5fa','#a78bfa','#f472b6','#fb923c','#facc15','#34d399','#22d3ee','#f87171','#c084fc','#4ade80'];
function renderModels(models){
  const svg = document.getElementById('donut'), legend = document.getElementById('legend');
  const big = document.getElementById('donutPct'), cap = document.getElementById('donutCap');
  const list = Array.isArray(models) ? models.filter(m => m && m.generated > 0) : [];
  const totalGen = list.reduce((s,m) => s + (m.generated||0), 0);
  const R = 15.9155; // r such that circumference == 100, so a share IS a dash length
  if (!list.length){
    // Empty: the ring is the placeholder. The legend carries the one sentence
    // that says why it is empty, so the caption is cleared rather than saying
    // the same thing twice.
    svg.innerHTML = '<circle cx="21" cy="21" r="'+R+'" fill="none" stroke="var(--track)" stroke-width="6"></circle>';
    big.textContent = '—'; cap.textContent = '';
    legend.innerHTML = '<div class="lrow" style="grid-template-columns:1fr"><span class="nm" style="color:var(--muted)">No completed requests yet</span></div>';
    return;
  }
  let acc = 0, rings = '';
  rings += '<circle cx="21" cy="21" r="'+R+'" fill="none" stroke="var(--track)" stroke-width="6"></circle>';
  list.forEach((m, i) => {
    const share = totalGen > 0 ? (m.generated / totalGen) * 100 : 0;
    const color = PALETTE[i % PALETTE.length];
    // -90deg rotation puts the first slice's start at 12 o'clock; a negative
    // dashoffset advances each slice to its cumulative start (start = -offset).
    rings += '<circle cx="21" cy="21" r="'+R+'" fill="none" stroke="'+color+'" stroke-width="6"' +
      ' stroke-dasharray="'+share.toFixed(3)+' '+(100-share).toFixed(3)+'"' +
      ' stroke-dashoffset="'+(-acc).toFixed(3)+'"></circle>';
    acc += share;
  });
  svg.innerHTML = '<g transform="rotate(-90 21 21)">' + rings + '</g>';
  // Centre figure: the total when a single model did all the work (a lone
  // "100%" says nothing), otherwise the leading model's share and name — the
  // "which model dominates?" answer a reader wants at a glance.
  const top = list[0];
  const topShare = totalGen > 0 ? (top.generated / totalGen) * 100 : 0;
  if (list.length === 1){ big.textContent = tokN(totalGen); cap.textContent = 'generated tokens'; }
  else { big.textContent = topShare.toFixed(0) + '%'; cap.textContent = (top.model||'').split('/').pop(); }
  legend.innerHTML = list.map((m, i) => {
    const share = totalGen > 0 ? (m.generated / totalGen) * 100 : 0;
    const name = m.model || '(unknown)';
    return '<div class="lrow" title="'+name+' · '+m.requests+' requests · avg '+((m.avgTps==null)?'—':m.avgTps)+' tok/s">' +
      '<span class="sw" style="background:'+PALETTE[i % PALETTE.length]+'"></span>' +
      '<span class="nm">'+name+' <span class="tk">'+tokN(m.generated)+' tok · '+m.requests+' req</span></span>' +
      '<span class="pc">'+share.toFixed(1)+'%</span></div>';
  }).join('');
}
// ---- per-request table ----
async function getReqs(off){
  const r = await fetch('/requests?offset='+off+'&limit='+PAGE_SIZE+'&sort='+sortKey+'&dir='+(sortDesc?'desc':'asc'));
  return await r.json();
}
async function tick(manual){
  if (busy) return; busy = true;
  const icon = document.getElementById('ricon');
  if (icon) icon.classList.add('spin');
  try {
    const off = page * PAGE_SIZE;
    const [sr, q0] = await Promise.all([ fetch('/stats?full=1'), getReqs(off) ]);
    const s = await sr.json();
    let q = q0;
    const c = document.getElementById('cards'); if(s.error){ c.innerHTML='<div class="card">'+s.error+'</div>'; return; }
    const last=s.last, w=s.window, ss=s.session;
    // The page can shrink under us (a session switch, or rows aging out), so
    // re-clamp against the server's own total before rendering.
    pages = Math.max(1, Math.ceil((q.total||0) / PAGE_SIZE));
    if (page > pages-1){ page = pages-1; q = await getReqs(page*PAGE_SIZE); }
    total = q.total || 0;
    // Signature of everything shown; skip DOM writes when nothing changed
    // (auto mode only) so idle sessions cause zero reflow.
    const sig = JSON.stringify([s.last&&s.last.id, s.window && [s.window.avgTps,s.window.peakTps,s.window.samples], ss && [ss.samples,ss.outputTokens,ss.avgTps], (ss&&ss.models)||[], page, sortKey, sortDesc, (q.rows||[]).map(x=>x.id+(x.tokPerSec||'')+(x.status||''))]);
    if (!manual && sig === lastSig) return;
    lastSig = sig;
    c.innerHTML = [
      card('Latest request tok/s', last ? (last.tokPerSec ?? '—') : '—', last ? last.model : '', last?'':'No completed requests yet'),
      card('Latest request TTFT', last ? ms(last.ttftMs) : '—', 'time to first token'),
      card('Last '+(w?.window||10)+' average', w?.avgTps ?? '—', 'peak '+(w?.peakTps ?? '—')+' tok/s'),
      card('Session output tok', ss ? (ss.outputTokens+ss.reasoningTokens) : '—', ss? (ss.samples+' samples · avg '+(ss.avgTps??'—')+' tok/s') : ''),
    ].join('');
    renderModels(ss && ss.models);
    document.querySelectorAll('#tbl th').forEach(th => {
      th.innerHTML = th.dataset.label + (th.dataset.k === sortKey ? ' <span class="arrow">'+(sortDesc?'▼':'▲')+'</span>' : '');
    });
    // Keyed in-place row update: reuse existing <tr> per request id, patch
    // cell values, then move rows into the sorted order (appendChild of an
    // existing node moves it) — never an innerHTML rebuild, so flicker-free.
    // The rows are already sorted and sliced server-side, so this only ever
    // sees one page — the table's depth is the session's, not a fixed cap.
    const pageRows = q.rows || [];
    const tbody = document.getElementById('tbl').querySelector('tbody');
    const byId = new Map(pageRows.map((x) => [x.id, x]));
    const seen = new Set();
    for (const tr of Array.from(tbody.children)) {
      const id = tr.dataset.id;
      if (!byId.has(id)) { tr.remove(); continue; }
      seen.add(id);
      patchRow(tr, byId.get(id));
    }
    for (const x of pageRows) {
      let tr = seen.has(x.id) ? tbody.querySelector('tr[data-id="' + cssEsc(x.id) + '"]') : null;
      if (!tr) {
        tr = document.createElement('tr'); tr.dataset.id = x.id;
        for (let i = 0; i < 7; i++) tr.appendChild(document.createElement('td'));
        patchRow(tr, x);
      }
      tbody.appendChild(tr); // moves existing rows into sorted position too
    }
    // Pager state — page count comes from the full session, not the page.
    document.getElementById('pageInfo').textContent =
      total ? ('page ' + (page+1) + ' of ' + pages + ' · ' + total + ' requests') : 'no requests';
    document.getElementById('prev').disabled = page <= 0;
    document.getElementById('next').disabled = page >= pages - 1;
    document.getElementById('updated').textContent = 'updated ' + new Date().toLocaleTimeString();
  } catch(e) {}
  finally {
    if (icon) icon.classList.remove('spin');
    busy = false;
  }
}
function patchRow(tr, x){
  const cells = tr.children;
  const vals = [
    x.time,
    x.model,
    x.tokPerSec ?? '—',
    ms(x.ttftMs),
    x.out,
    x.cacheRead || 0,
    x.status,
  ];
  for (let i = 0; i < 7; i++) {
    const cls = i === 6 ? (x.status === 'completed' ? 'ok' : x.status === 'cancelled' ? 'cxl' : 'err') : '';
    if (cells[i].textContent !== String(vals[i]) || cells[i].className !== cls) {
      cells[i].textContent = vals[i];
      cells[i].className = cls;
    }
  }
}
// Escaped without a backslash literal: this code lives inside a template
// literal, where "\\\\" would collapse before reaching the browser.
const BS = String.fromCharCode(92);
function cssEsc(s){ return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => BS + c.charCodeAt(0).toString(16) + ' '); }
// Sorting is an inspection action — turn auto-refresh off so the view the
// user is reading stays frozen while they look at it. Sorting happens on the
// server across the WHOLE session, so it is correct at any table depth.
document.querySelectorAll('#tbl th').forEach(th => th.addEventListener('click', () => {
  const k = th.dataset.k;
  if (sortKey === k) sortDesc = !sortDesc; else { sortKey = k; sortDesc = true; }
  page = 0; // a new sort order starts at the top
  if (auto) setAuto(false);
  tick(true);
}));
// Pagination is an inspection action too: pause auto-refresh so the page the
// user is reading is not re-sorted/re-sliced underneath them.
function goto(p){ page = Math.max(0, p); if (auto) setAuto(false); tick(true); }
document.getElementById('prev').addEventListener('click', () => goto(page - 1));
document.getElementById('next').addEventListener('click', () => goto(page + 1));
// Keyboard: left/right arrows page; Home/End jump to the ends of the session.
document.addEventListener('keydown', (e) => {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
  if (e.key === 'ArrowLeft' && page > 0) goto(page - 1);
  else if (e.key === 'ArrowRight' && page < pages - 1) goto(page + 1);
  else if (e.key === 'Home') goto(0);
  else if (e.key === 'End') goto(pages - 1);
});
function setAuto(on){
  auto = on;
  const badge = document.getElementById('refreshBadge');
  badge.classList.toggle('off', !on);
  document.getElementById('autoLabel').textContent = 'Auto-refresh: ' + (on ? 'on' : 'off');
}
document.getElementById('toggleAuto').addEventListener('click', () => setAuto(!auto));
document.getElementById('refreshNow').addEventListener('click', () => tick(true));
setInterval(() => { if (auto) tick(false); }, 2000);
tick(true);
</script>
</body></html>`;
}

const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.env.STATS_SIDECAR_PLUGIN_ROOT || ".", ".zcode-plugin", "plugin.json"), "utf8")).version;
  } catch {
    try {
      return JSON.parse(fs.readFileSync(new URL("../.zcode-plugin/plugin.json", import.meta.url), "utf8")).version;
    } catch {
      return "0.0.0";
    }
  }
})();

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const origin = req.headers.origin || "";
  // Scoped CORS: the composer pill runs inside app pages (and local test
  // pages) and needs a cross-origin fetch; only clearly-local origins and
  // the app's own origins (electron:// style / file:// sent as null) pass.
  // A public website's origin is refused, and non-GET methods are refused
  // outright — nothing here is worth exfiltrating, but stay tight anyway.
  // file:// renderer pages send Origin: null (opaque origin) — that literal
  // string is local-only traffic (no web page can be served from "null"),
  // so it is accepted and answered with a wildcard header.
  const localOrigin =
    !origin ||
    origin === "null" ||
    /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin) ||
    origin.startsWith("http://localhost") ||
    origin.startsWith("chrome://") ||
    origin.startsWith("file://");
  if (req.method === "OPTIONS") {
    res.writeHead(204, localOrigin
      ? { "Access-Control-Allow-Origin": origin === "null" ? "*" : (origin || "*"), "Access-Control-Allow-Methods": "GET", "Access-Control-Max-Age": "600" }
      : {});
    return res.end();
  }
  if (!localOrigin) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    return res.end("forbidden origin");
  }
  if (req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "text/plain" });
    return res.end("GET only");
  }
  const corsHeaders = localOrigin
    ? { "Access-Control-Allow-Origin": origin && origin !== "null" ? origin : "*", Vary: "Origin" }
    : {};
  const sendJson = (code, body) => {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...corsHeaders });
    res.end(JSON.stringify(body));
  };
  try {
    if (url.pathname === "/health") {
      return sendJson(200, {
        ok: true,
        plugin: "stats-composer",
        version: VERSION,
        uptime: process.uptime(),
        refreshes: REFRESH_COUNT,
        skips: REFRESH_SKIP,
        refreshMsLast: Math.round(REFRESH_LAST_MS * 100) / 100,
        refreshMsAvg: Math.round(REFRESH_AVG_MS * 100) / 100,
        rssKb: Math.round(process.memoryUsage().rss / 1024),
        demandAge: Date.now() - lastDemand,
      });
    }
    if (url.pathname === "/stats" || url.pathname === "/stats.json") {
      noteDemand();
      // The pill passes the session the app is currently showing, so switching
      // chats re-scopes immediately (a session change forces a refresh even
      // though the DB itself has not been written to).
      if (requestSession(url.searchParams.get("session"))) refreshSnapshot(true);
      const snap = snapshotJson();
      // The pill wants only the headline numbers; the dashboard also wants the
      // last-turn summary. The per-request table is NOT here any more — it has
      // its own paged endpoint below, so a long session no longer ships
      // hundreds of rows on every 2 s poll.
      if (url.searchParams.has("full")) return sendJson(200, { ...snap, ...dashboardExtras() });
      const { lastTurn: _t, ...slim } = snap;
      return sendJson(200, slim);
    }
    if (url.pathname === "/requests" || url.pathname === "/requests.json") {
      // One page of the per-request table, sorted over the whole session and
      // sliced server-side. This is what makes the table unbounded: page 1 of
      // 240 is real history, not a window inside the first 500 rows, and only
      // the visible page crosses the wire.
      noteDemand();
      if (requestSession(url.searchParams.get("session"))) refreshSnapshot(true);
      const q = url.searchParams;
      const p = requestsPage(
        Number(q.get("offset")) || 0,
        Number(q.get("limit")) || 10,
        q.get("sort") || "completedAt",
        q.get("dir") !== "asc"
      );
      // The client wants a locale time string and a combined output figure per
      // row; both are presentation, so they are added here where the row set is
      // already in hand rather than in the browser over every row.
      p.rows = p.rows.map((x) => ({
        id: x.id,
        time: x.completedAt ? new Date(x.completedAt).toLocaleTimeString() : "—",
        model: x.model,
        provider: x.providerId,
        tokPerSec: x.tokPerSec,
        ttftMs: x.ttftMs,
        out: x.out,
        cacheRead: x.cacheRead || 0,
        status: x.status,
      }));
      p.sessionId = (SNAP && SNAP.sessionId) || null;
      return sendJson(200, p);
    }
    if (url.pathname === "/metrics") {
      const snap = snapshotJson();
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(snap.error ? "# no data\n" : prometheus(snap));
    }
    if (url.pathname === "/turn" || url.pathname === "/turn.json") {
      // Per-turn usage for the usage-context plugin. `session` scopes it (the
      // same live session the pill follows); `msg` selects one turn by the DOM's
      // data-turn-id (= turn_usage.user_message_id). With no `msg` the whole
      // session's turns are returned, so one fetch serves every rendered turn.
      noteDemand();
      if (requestSession(url.searchParams.get("session"))) refreshSnapshot(true);
      const sid = REQUESTED_SID || (SNAP && SNAP.sessionId) || metrics.lastActiveSessionId();
      const msg = url.searchParams.get("msg");
      let db = null;
      try {
        db = metrics.openDb();
        if (msg) {
          const turn = metrics.turnUsageByMessage(db, sid, msg);
          return sendJson(200, turn ? { turn, sessionId: sid } : { turn: null, sessionId: sid });
        }
        const all = metrics.turnUsageFor(db, sid);
        return sendJson(200, { turns: all.turns, totals: all.totals, sessionId: sid });
      } catch (e) {
        return sendJson(200, { turn: null, turns: [], error: String((e && e.message) || e) });
      } finally {
        try { db && db.close(); } catch {}
      }
    }
    if (url.pathname === "/dashboard") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(dashboardHtml());
    }
    sendJson(404, { error: "not found" });
  } catch (e) {
    try {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: String((e && e.message) || e) }));
    } catch {}
  }
});

if (process.env.STATS_SIDECAR_NO_SINGLETON !== "1") {
  // Single-instance behavior: if port is taken by a healthy sidecar, exit.
}

try {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  server.listen(PORT, "127.0.0.1", () => {
    fs.writeFileSync(path.join(RUN_DIR, "port"), String(PORT));
    try { fs.chmodSync(path.join(RUN_DIR, "port"), 0o600); } catch {}
    console.log(`[stats-composer] sidecar on http://127.0.0.1:${PORT} (dashboard /dashboard)`);
    spawnInjector();
  });
  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      // Already running? verify and exit quietly.
      fetch(`http://127.0.0.1:${PORT}/health`)
        .then((r) => r.json())
        .then(() => process.exit(0))
        .catch(() => process.exit(0));
    } else {
      process.exit(0);
    }
  });
} catch {
  process.exit(0);
}

// The injector needs the plugin's own scripts; find them relative to this
// file unless the host process (hook) tells us via env.
const PLUGIN_ROOT = process.env.STATS_SIDECAR_PLUGIN_ROOT ||
  path.join(dirname(fileURLToPath(import.meta.url)), "..");

// Injector loop: best-effort. If the app has no CDP port the injector exits
// with code 2 and is retried on a long interval (cheap no-op fail).
let injectorProc = null;
function spawnInjector() {
  if (cfg.mode === "skill") return; // pill deliberately off
  // spawnAttachedNode re-asserts ELECTRON_RUN_AS_NODE (this sidecar may itself
  // be running under ZCode's embedded Node) and sets windowsHide, so the
  // injector never relaunches the GUI and never flashes a console on Windows.
  injectorProc = spawnAttachedNode(
    path.join(PLUGIN_ROOT, "injector", "inject.mjs"),
    ["--sidecar-port", String(PORT)],
    { STATS_SIDECAR_PLUGIN_ROOT: PLUGIN_ROOT }
  );
  if (injectorProc) injectorProc.on("exit", () => { injectorProc = null; });
}
const INJECTOR_RESTART_MS = 60_000;
setInterval(() => {
  if (cfg.mode !== "skill" && !injectorProc) spawnInjector();
}, INJECTOR_RESTART_MS);

const stop = () => {
  try { injectorProc && injectorProc.kill(); } catch {}
  try { fs.unlinkSync(path.join(RUN_DIR, "port")); } catch {}
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);