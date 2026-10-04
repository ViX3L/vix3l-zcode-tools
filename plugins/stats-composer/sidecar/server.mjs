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
function refreshFullExtras(db, snap, dbv) {
  if (!db || !snap || snap.error) return;
  try {
    const sid = snap.sessionId;
    // 500 rows: the dashboard pages at 10/page, so this gives up to 50 pages of
    // history without pulling a whole multi-thousand-row session into memory on
    // every extras refresh. The per-page window is what the table shows; this
    // is the browse depth behind it.
    const extras = { recent: metrics.recentRequests(db, sid, 500).reverse() };
    const lastTurn = metrics.lastTurnStats(db, sid);
    if (lastTurn) extras.lastTurn = lastTurn;
    FULL_EXTRAS = extras;
    FULL_EXTRAS_AT = Date.now();
    FULL_EXTRAS_DBV = dbv;
  } catch {
    /* keep last good extras */
  }
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
<style>
  :root { color-scheme: dark; }
  /* Only colors/text change in place; never the whole document — constant
     full-screen rewrites are a flicker/photosensitivity hazard. */
  body { font: 14px/1.6 -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif;
         background: #0e1116; color: #dbe2ea; margin: 0; padding: 24px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #7d8794; font-size: 12px; margin-bottom: 20px; }
  .bar { display: flex; align-items: center; gap: 10px; max-width: 1100px; margin-bottom: 14px; }
  .badge { display: inline-flex; align-items: center; gap: 6px; font-size: 12px;
           border: 1px solid #232b36; border-radius: 999px; padding: 3px 10px; color: #7d8794; }
  .badge button { background: none; border: 0; color: #dbe2ea; cursor: pointer;
                  font: inherit; display: inline-flex; align-items: center; gap: 6px; padding: 0; }
  .badge button:hover { color: #fff; }
  .badge .dot { width: 7px; height: 7px; border-radius: 50%; background: #4ade80; }
  .badge.off .dot { background: #6b7280; }
  .spin { animation: rot 0.9s linear infinite; }
  @keyframes rot { to { transform: rotate(360deg); } }
  .cards { display: grid; grid-template-columns: repeat(auto-fit,minmax(220px,1fr)); gap: 14px; max-width: 1100px; }
  .card { background: #161b23; border: 1px solid #232b36; border-radius: 12px; padding: 16px 18px; }
  .card .k { color: #7d8794; font-size: 12px; }
  .card .v { font-size: 30px; font-weight: 650; font-variant-numeric: tabular-nums; margin-top: 2px; }
  .card .n { color: #7d8794; font-size: 12px; margin-top: 2px; }
  table { border-collapse: collapse; margin-top: 22px; max-width: 1100px; width: 100%; font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #232b36; font-size: 13px; }
  th { color: #7d8794; font-weight: 500; cursor: pointer; user-select: none; white-space: nowrap; }
  th:hover { color: #dbe2ea; }
  th .arrow { font-size: 10px; margin-left: 4px; color: #4ade80; }
  /* Pagination: a long session produces thousands of rows, which previously
     made the table run the full height of the page and forced endless
     scrolling. Ten rows per page keeps the whole view on one screen. */
  .pager { display: flex; align-items: center; gap: 10px; max-width: 1100px;
           margin-top: 12px; color: #7d8794; font-size: 12px; }
  .pager button { background: #161b23; border: 1px solid #232b36; border-radius: 8px;
                  color: #dbe2ea; cursor: pointer; font: inherit; padding: 4px 12px; }
  .pager button:hover:not(:disabled) { border-color: #3a4553; color: #fff; }
  .pager button:disabled { opacity: .4; cursor: default; }
  .pager .pg { font-variant-numeric: tabular-nums; }
  .ok { color: #4ade80; } .err { color: #f87171; } .cxl { color: #fbbf24; }
</style></head><body>
<h1>⚡ Session statistics</h1>
<div class="sub">ZCode · stats-composer · read-only on the usage DB, cannot affect the running client · newest request first · click a column header to toggle its sort</div>
<div class="bar">
  <span class="badge" id="refreshBadge">
    <button id="toggleAuto" title="Toggle auto-refresh (updates in place, never reloads the page)">
      <span class="dot"></span><span id="autoLabel">Auto-refresh: on</span>
    </button>
  </span>
  <span class="badge"><button id="refreshNow" title="Refresh now"><span id="ricon">⟳</span> refresh</button></span>
  <span class="sub" id="updated" style="margin:0"></span>
</div>
<div class="cards" id="cards"></div>
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
let sortedRows = [];             // the sorted full set; the page slices it
const NUM = (v) => (v == null ? -Infinity : v);
function card(k,v,n){ return '<div class="card"><div class="k">'+k+'</div><div class="v">'+v+'</div><div class="n">'+(n||'')+'</div></div>'; }
function ms(v){ return v==null?'—':(v>=10000?(v/1000).toFixed(1)+'s':Math.round(v)+'ms'); }
function dur(v){ return v==null?'—':(v>=60000?(v/60000).toFixed(1)+'m':ms(v)); }
async function tick(manual){
  if (busy) return; busy = true;
  const icon = document.getElementById('ricon');
  if (icon) icon.classList.add('spin');
  try {
    const r = await fetch('/stats?full=1'); const s = await r.json();
    const c = document.getElementById('cards'); if(s.error){ c.innerHTML='<div class="card">'+s.error+'</div>'; return; }
    const last=s.last, w=s.window, ss=s.session;
    // Signature of everything shown; skip DOM writes when nothing changed
    // (auto mode only) so idle sessions cause zero reflow.
    const sig = JSON.stringify([s.last&&s.last.id, s.window && [s.window.avgTps,s.window.peakTps,s.window.samples], ss && [ss.samples,ss.outputTokens,ss.avgTps], (s.recent||[]).map(x=>x.id+(x.tokPerSec??'')+(x.status||''))]);
    if (!manual && sig === lastSig) return;
    lastSig = sig;
    c.innerHTML = [
      card('Latest request tok/s', last ? (last.tokPerSec ?? '—') : '—', last ? last.model : '', last?'':'No completed requests yet'),
      card('Latest request TTFT', last ? ms(last.ttftMs) : '—', 'time to first token'),
      card('Last '+(w?.window||10)+' average', w?.avgTps ?? '—', 'peak '+(w?.peakTps ?? '—')+' tok/s'),
      card('Session output tok', ss ? (ss.outputTokens+ss.reasoningTokens) : '—', ss? (ss.samples+' samples · avg '+(ss.avgTps??'—')+' tok/s') : ''),
    ].join('');
    const rows = (s.recent||[]).map(x => Object.assign({}, x, {
      out: (x.outputTokens||0) + (x.reasoningTokens||0),
      time: new Date(x.completedAt||0).toLocaleTimeString(),
    }));
    rows.sort((a,b) => {
      const k = sortKey, dir = sortDesc ? -1 : 1;
      const cmp = (k === 'model' || k === 'status')
        ? String(a[k] ?? '').localeCompare(String(b[k] ?? ''))
        : NUM(a[k]) - NUM(b[k]);
      return cmp * dir;
    });
    sortedRows = rows;
    document.querySelectorAll('#tbl th').forEach(th => {
      th.innerHTML = th.dataset.label + (th.dataset.k === sortKey ? ' <span class="arrow">'+(sortDesc?'▼':'▲')+'</span>' : '');
    });
    // Show one page at a time: a long session has thousands of rows, and
    // rendering them all made the page scroll endlessly. The page index is
    // clamped here (rows can shrink between ticks) so a stale page never
    // leaves an empty table.
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    if (page > pages - 1) page = pages - 1;
    if (page < 0) page = 0;
    const start = page * PAGE_SIZE;
    const pageRows = rows.slice(start, start + PAGE_SIZE);
    // Keyed in-place row update: reuse existing <tr> per request id, patch
    // cell values, then move rows into the sorted order (appendChild of an
    // existing node moves it) — never an innerHTML rebuild, so flicker-free.
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
    // Pager state.
    document.getElementById('pageInfo').textContent =
      rows.length ? ('page ' + (page+1) + ' of ' + pages + ' · ' + rows.length + ' requests') : 'no requests';
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
// user is reading stays frozen while they look at it.
document.querySelectorAll('#tbl th').forEach(th => th.addEventListener('click', () => {
  const k = th.dataset.k;
  if (sortKey === k) sortDesc = !sortDesc; else { sortKey = k; sortDesc = true; }
  page = 0; // a new sort order starts at the top
  if (auto) setAuto(false);
  tick(true);
}));
// Pagination is an inspection action too: pause auto-refresh so the page the
// user is reading is not re-sorted/re-sliced underneath them.
document.getElementById('prev').addEventListener('click', () => { if (page > 0) { page--; if (auto) setAuto(false); tick(true); } });
document.getElementById('next').addEventListener('click', () => { page++; if (auto) setAuto(false); tick(true); });
// Keyboard: left/right arrows page when the table has focus-scope is the page.
document.addEventListener('keydown', (e) => {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
  if (e.key === 'ArrowLeft') { if (page > 0) { page--; if (auto) setAuto(false); tick(true); } }
  else if (e.key === 'ArrowRight') { page++; if (auto) setAuto(false); tick(true); }
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
      // per-request table. Both come from the background refresher's cache —
      // a request never opens the DB (see refreshSnapshot).
      if (url.searchParams.has("full")) return sendJson(200, { ...snap, ...dashboardExtras() });
      const { recent: _r, lastTurn: _t, ...slim } = snap;
      return sendJson(200, slim);
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