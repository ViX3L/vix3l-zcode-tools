// metrics.mjs — read-only access to ZCode's own per-request usage database.
//
// ZCode (the agent CLI it bundles) records one `model_usage` row per HTTP
// model request, for every provider kind it supports (anthropic-messages,
// openai-responses, openai-chat-completions — which covers every custom
// endpoint too). TTFT is recorded per request as time_to_first_token_ms.
// This library only reads that WAL sqlite db (readOnly:true), so it works
// identically for all providers and never interferes with a running app.
//
// Rows whose id starts with "usage_model_subagent_" belong to subagent
// requests; main composer requests use query_source='main_turn'.
//
// A session's own rows are its composer requests (`main_turn`), plus the
// compaction (`compact`) and title (`session_title`) requests it fires — all of
// which ZCode counts in that session's own usage. Subagent requests live in
// separate child sessions that name this one as their parent; see the
// "session tree" section at the bottom for how they are attributed.

process.removeAllListeners("warning");
process.on("warning", () => {});

const { DatabaseSync } = await import("node:sqlite");
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DB_PATH =
  process.env.ZCODE_USAGE_DB ||
  path.join(os.homedir(), ".zcode", "cli", "db", "db.sqlite");

// Samples outside these generation-duration bounds are considered invalid
// (non-streamed, interrupted, or stuck rows). The reasoning tokens are part
// of the streamed output, so they count toward the rate.
const MIN_GEN_MS = Number(process.env.TOKEN_RATE_MIN_MS) || 200;
const MAX_GEN_MS = Number(process.env.TOKEN_RATE_MAX_MS) || 3_600_000;
const STATE_TTL_MS = 7 * 24 * 3600 * 1000;

const COLS = [
  "id",
  "session_id",
  "turn_id",
  "provider_id",
  "model_id",
  "status",
  "started_at",
  "first_token_at",
  "completed_at",
  "time_to_first_token_ms",
  "duration_ms",
  "output_tokens",
  "reasoning_tokens",
  "input_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "query_source",
  "finish_reason",
  "error_type",
]

export function stateFile() {
  return process.env.TPS_MONITOR_STATE_FILE ||
    path.join(os.homedir(), ".zcode", "tps-monitor.last-session.json");
}

export function dbExists() {
  try {
    fs.accessSync(DB_PATH);
    return true;
  } catch {
    return false;
  }
}

export function openDb() {
  return new DatabaseSync(DB_PATH, { readOnly: true });
}

function readState() {
  try {
    const st = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    if (!st || !Number.isFinite(st.ts) || Date.now() - st.ts > STATE_TTL_MS) return null;
    return st;
  } catch {
    return null;
  }
}

// The last session the user interacted with (hooks record this on every
// prompt submit), so passive consumers follow the window the user is in.
export function lastActiveSessionId() {
  const st = readState();
  return st && st.sessionId ? st.sessionId : null;
}

export function recordActiveSession(sessionId, source) {
  if (!sessionId) return;
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(
      stateFile(),
      JSON.stringify({ sessionId, ts: Date.now(), source: source || "hook" })
    );
  } catch {}
}

export function dbInfo() {
  let sizeBytes = null;
  let lastWriteAt = null;
  try {
    const st = fs.statSync(DB_PATH);
    sizeBytes = st.size;
    lastWriteAt = st.mtimeMs;
  } catch {}
  return { path: DB_PATH, exists: dbExists(), sizeBytes, lastWriteAt };
}

// ---------------------------------------------------------------------------
// Row projection
// ---------------------------------------------------------------------------

const SELECT =
  "SELECT id, session_id, turn_id, provider_id, model_id, status, started_at," +
  " first_token_at, completed_at, time_to_first_token_ms, duration_ms," +
  " output_tokens, reasoning_tokens, input_tokens, cache_read_input_tokens," +
  " cache_creation_input_tokens, query_source, finish_reason, error_type" +
  " FROM model_usage";

// Shared token arithmetic, defined once. Three layers need the same numbers —
// the SQL-tier aggregates (which can only SUM columns), the JS row path, and
// the per-turn layer — and four copies of the formula is exactly how a "cache
// hit" on the hover card drifts away from the same figure in the dashboard.
//   cached   = cache_read_input_tokens
//   uncached = input_tokens - cache_read_input_tokens
//   output   = output_tokens + reasoning_tokens
//   total    = cached + uncached + output   (equals computed_total_tokens)
// cache_creation_input_tokens is deliberately NOT used as the uncached figure:
// it is 0 in practice and does not equal `input - cache_read` (verified against
// live rows).
const tokenDecomp = ({ input = 0, cacheRead = 0, output = 0, reasoning = 0 }) => {
  const cached = cacheRead;
  const uncached = Math.max(0, input - cached);
  const out = output + reasoning;
  return { cached, uncached, output: out, total: cached + uncached + out };
};

// cacheHitPct = cached / (cached + uncached) to one decimal, null with no input.
const pct = (cached, uncached) =>
  cached + uncached > 0 ? Math.round((cached / (cached + uncached)) * 1000) / 10 : null;

// One-decimal rounding that passes null/NaN through (rates, averages, shares).
const round1 = (v) => (v == null || Number.isNaN(v) ? null : Math.round(v * 10) / 10);

// One model request (one row): the unit of "per request" stats.
//
// Two quality tiers of rate:
//  - "text" tier: first_token_at present → TPS over (text+reasoning tokens)
//    between first token and completion; TTFT is meaningful. This is the
//    composer-visible streaming (what a human reads), ZCode's own convention.
//  - "wire" tier (fallback): tool-call-only requests never emit a text delta,
//    so ZCode stores no first_token_at — but the tool-input tokens ARE
//    streamed and duration_ms covers that streaming window. TPS = tokens/dur,
//    TTFT reported as null (by definition, no user-visible first token).
// The pill/snapshot prefer the text tier whenever either tier has data.
function toRow(r) {
  const tok = r.output_tokens ?? 0;
  const reasoning = r.reasoning_tokens ?? 0;
  const hasTime =
    Number.isFinite(r.first_token_at) &&
    Number.isFinite(r.completed_at) &&
    r.completed_at > r.first_token_at;
  const genMs = hasTime ? r.completed_at - r.first_token_at : null;
  const rateTokens = tok + reasoning;
  const valid =
    genMs != null && genMs >= MIN_GEN_MS && genMs < MAX_GEN_MS && rateTokens > 0;
  const fallbackMs = Number.isFinite(r.duration_ms) ? r.duration_ms : null;
  const fallbackValid =
    !valid &&
    fallbackMs != null &&
    fallbackMs >= MIN_GEN_MS &&
    fallbackMs < MAX_GEN_MS &&
    tok > 0;
  return {
    id: r.id,
    sessionId: r.session_id,
    turnId: r.turn_id,
    providerId: r.provider_id,
    model: r.model_id,
    status: r.status,
    querySource: r.query_source,
    ttftMs: Number.isFinite(r.time_to_first_token_ms) ? r.time_to_first_token_ms : null,
    outputTokens: tok,
    reasoningTokens: reasoning,
    inputTokens: r.input_tokens ?? 0,
    cacheRead: r.cache_read_input_tokens ?? 0,
    cacheWrite: r.cache_creation_input_tokens ?? 0,
    genMs: genMs ?? (fallbackValid ? fallbackMs : null),
    tokPerSec: valid
      ? round1((rateTokens / genMs) * 1000)
      : fallbackValid
        ? round1((tok / fallbackMs) * 1000)
        : null,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    // The spawning agent (e.g. "zcode-Explore"). Present on subagent rows and
    // empty/absent elsewhere; used only to group the subagent activity surface.
    agent: r.agent ?? null,
  };
}

// Session rows, fetched with ONE scan.
//
// scopeFor() had to probe first (is there any main_turn row for this session?)
// to decide which WHERE clause to use, and that probe re-scanned the table.
// Fetching the session's completed rows unfiltered and then preferring
// main_turn rows in memory produces the same result for one scan instead of
// two. Parallel subagent traffic is still excluded whenever the session has
// any main_turn rows, exactly as before.
function scopeRows(db, sid) {
  const sql =
    "SELECT id, session_id, turn_id, provider_id, model_id, status, started_at," +
    " first_token_at, completed_at, time_to_first_token_ms, duration_ms," +
    " output_tokens, reasoning_tokens, input_tokens, cache_read_input_tokens," +
    " cache_creation_input_tokens, query_source, finish_reason, error_type" +
    " FROM model_usage" + indexHint(sid) + " WHERE status = 'completed'" +
    (sid ? " AND session_id = ?" : "") +
    " ORDER BY completed_at DESC";
  const rows = (sid ? db.prepare(sql).all(sid) : db.prepare(sql).all()).map(toRow);
  const main = rows.filter((r) => r.querySource === "main_turn");
  return main.length ? main : rows;
}

// The session's USAGE rows: every completed model request the conversation
// itself fired — `main_turn` plus the compaction (`compact`) and title
// (`session_title`) requests — which is the set ZCode's own per-session
// accounting covers. Subagent requests are excluded here by definition; they
// belong to child sessions and are folded in separately (see subagentActivity).
//
// Why not `query_source = 'main_turn'`: on the live DB that under-counts a real
// session, because compaction requests can carry millions of tokens. Measured
// against ZCode's own `turn_usage` totals over 22 interactive sessions, the
// median absolute error was 0.67 % for main_turn-only versus 0.001 % for this
// scope, which matched the app exactly on most long sessions (a 494.6 M-token
// session: app 494.60 M, main_turn 490.04 M, this scope 494.60 M).
//
// Written as `<> 'subagent'` rather than a whitelist so a query source ZCode
// adds later is counted by default: anything a session writes that is not
// subagent traffic IS that session's own usage.
function usageRows(db, sid) {
  if (!sid) return [];
  const sql =
    "SELECT id, session_id, turn_id, provider_id, model_id, status, started_at," +
    " first_token_at, completed_at, time_to_first_token_ms, duration_ms," +
    " output_tokens, reasoning_tokens, input_tokens, cache_read_input_tokens," +
    " cache_creation_input_tokens, query_source, finish_reason, error_type" +
    " FROM model_usage" + indexHint(sid) +
    " WHERE status = 'completed' AND query_source <> 'subagent' AND session_id = ?";
  try {
    return db.prepare(sql).all(sid).map(toRow);
  } catch {
    return [];
  }
}

// model_usage IS indexed — `(session_id, turn_id)` among others — but the
// planner prefers `query_source_idx`, whose single column matches one value
// across the whole database. On the live DB that meant every session-scoped
// query scanned all ~24k main_turn rows (global) and sorted them in a temp
// B-tree, instead of reading the ~1.5k rows of this session through the
// session index. Pinning the index when a session id is present is 10–30×
// faster and returns byte-identical rows (verified against the unpinned
// query across recentRequests, scopeRows and turnRequests). Without a session
// id the query is global by definition, so no hint applies.
const SES_INDEX = "model_usage_session_turn_idx";
function indexHint(sid) {
  return sid ? ` INDEXED BY ${SES_INDEX}` : "";
}

// Session scope: prefer main_turn rows when the session has any, so parallel
// subagent traffic does not pollute human-facing numbers.
function scopeFor(db, sid) {
  const base =
    "SELECT id, session_id, turn_id, provider_id, model_id, status, started_at," +
    " first_token_at, completed_at, time_to_first_token_ms, duration_ms," +
    " output_tokens, reasoning_tokens, input_tokens, cache_read_input_tokens," +
    " cache_creation_input_tokens, query_source, finish_reason, error_type" +
    " FROM model_usage" + indexHint(sid) + " WHERE status = 'completed' AND query_source = 'main_turn'";
  const args = sid ? [sid] : [];
  const hasMain = db
    .prepare(base + (sid ? " AND session_id = ?" : "") + " LIMIT 1")
    .get(...args);
  const scopeSql = hasMain
    ? base + (sid ? " AND session_id = ?" : "")
    : base.replace(" AND query_source = 'main_turn'", "") + (sid ? " AND session_id = ?" : "");
  return { scopeSql, args };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

// Most recent completed request, optionally scoped to a session.
export function lastRequest(db, sid) {
  const { scopeSql, args } = scopeFor(db, sid);
  const r = db.prepare(scopeSql + " ORDER BY completed_at DESC LIMIT 1").get(...args);
  return r ? toRow(r) : null;
}

// All completed requests of one turn, ordered by start.
export function turnRequests(db, sid, turnId) {
  const { scopeSql, args } = scopeFor(db, sid);
  return db
    .prepare(scopeSql + " AND turn_id = ? ORDER BY started_at ASC")
    .all(...args, turnId)
    .map(toRow);
}

// Latest turn id for a session (by last completed request).
export function lastTurnId(db, sid) {
  const { scopeSql, args } = scopeFor(db, sid);
  const r = db
    .prepare(scopeSql + " ORDER BY completed_at DESC LIMIT 1")
    .get(...args);
  return r ? r.turn_id : null;
}

// The N most recent distinct turns for a session (newest first).
export function recentTurns(db, sid, n) {
  const { scopeSql, args } = scopeFor(db, sid);
  return db
    .prepare(
      "SELECT turn_id, MAX(completed_at) AS last_at FROM (" + scopeSql + ")" +
      " GROUP BY turn_id ORDER BY last_at DESC LIMIT ?"
    )
    .all(...args, n)
    .map((x) => x.turn_id);
}

// Last N completed main requests per session, newest first.
export function recentRequests(db, sid, n) {
  const { scopeSql, args } = scopeFor(db, sid);
  return db
    .prepare(scopeSql + " ORDER BY completed_at DESC LIMIT ?")
    .all(...args, n)
    .map(toRow);
}

// EVERY completed request of one session, newest first — no LIMIT.
//
// The dashboard's table used to be capped at 500 rows (recentRequests(db, sid,
// 500)), so a long session silently showed "page 1 of 50 · 500 requests" and
// the rest of its history was unreachable. The cap existed to bound what the
// server held per extras refresh, but the snapshot already scans the whole
// session on every tick, so scanning it once more for the table is not the
// expensive part; shipping every row to the browser on each 2 s poll was. The
// page is therefore sliced server-side (see the dashboard's /requests
// handling) and only the visible page crosses the wire, which makes the table
// depth unlimited without the payload growing with the session.
export function sessionRequests(db, sid) {
  const { scopeSql, args } = scopeFor(db, sid);
  return db.prepare(scopeSql + " ORDER BY completed_at DESC").all(...args).map(toRow);
}

// Aggregate for the whole session (see sessionAggregateFrom for the shared
// span/busy accounting).
export function sessionAggregate(db, sid) {
  const { scopeSql, args } = scopeFor(db, sid);
  const rows = db.prepare(scopeSql).all(...args).map(toRow);
  return sessionAggregateFrom(rows);
}

// A request that has started but not yet completed (live generation).
export function runningRequest(db, sid) {
  const sql =
    "SELECT id, session_id, turn_id, provider_id, model_id, status, started_at," +
    " first_token_at, completed_at, time_to_first_token_ms, duration_ms," +
    " output_tokens, reasoning_tokens, input_tokens, cache_read_input_tokens," +
    " cache_creation_input_tokens, query_source, finish_reason, error_type" +
    " FROM model_usage" + indexHint(sid) + " WHERE status = 'running'" +
    (sid ? " AND session_id = ?" : "") +
    " ORDER BY started_at DESC LIMIT 1";
  const r = sid
    ? db.prepare(sql).get(sid)
    : db.prepare(sql).get();
  return r ? toRow(r) : null;
}

export function aggregate(rows) {
  const rated = rows.filter((r) => r.tokPerSec != null);
  const ttfts = rated.map((r) => r.ttftMs).filter((t) => t != null);
  const rate = (arr) =>
    arr.length ? round1(arr.reduce((s, v) => s + v, 0) / arr.length) : null;
  const sum = (arr) => arr.reduce((s, v) => s + v, 0);
  return {
    samples: rated.length,
    requests: rows.length,
    avgTps: rate(rated.map((r) => r.tokPerSec)),
    peakTps: rated.length ? Math.max(...rated.map((r) => r.tokPerSec)) : null,
    avgTtftMs: rate(ttfts),
    outputTokens: sum(rows.map((r) => r.outputTokens)),
    reasoningTokens: sum(rows.map((r) => r.reasoningTokens)),
    inputTokens: sum(rows.map((r) => r.inputTokens)),
    cacheRead: sum(rows.map((r) => r.cacheRead)),
  };
}

// Session-window rate, Hermes-style: mean over the last N requests.
export function windowStats(db, sid, windowN) {
  const rows = recentRequests(db, sid, windowN).reverse();
  const agg = aggregate(rows);
  return { window: rows.length, ...agg };
}

// Turn stats: all requests of a turn averaged (turn = one user question).
// sinceTs scopes a resumed turn — one DB turn_id can chain across prompt
// submissions after a session continuation, so keep only requests that
// started at/after this prompt (1 s slack for clock jitter). Falls back to
// the unscoped turn when nothing qualifies, so first requests of a fresh
// turn are never lost.
export function turnStats(db, sid, turnId, sinceTs) {
  let rows = turnRequests(db, sid, turnId);
  if (Number.isFinite(sinceTs)) {
    const scoped = rows.filter((r) => r.startedAt >= sinceTs - 1000);
    if (scoped.length) rows = scoped;
  }
  return { turnId, ...aggregate(rows) };
}

// Latest turn that produced at least one valid sample.
export function lastTurnStats(db, sid, sinceTs) {
  for (const turnId of recentTurns(db, sid, 5)) {
    const st = turnStats(db, sid, turnId, sinceTs);
    if (st.samples > 0) return st;
  }
  return null;
}

export function resolveSession(requested) {
  return requested || lastActiveSessionId() || null;
}

export function openResolved(requested) {
  const db = openDb();
  return { db, sid: resolveSession(requested) };
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

const fmt = (v, suffix = "") => (v == null ? "—" : `${v}${suffix}`);
const ms = (v) => (v == null ? "—" : (v >= 10000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`));

export function formatLine(row) {
  return (
    `⚡ ${fmt(row.tokPerSec, " tok/s")}` +
    ` · TTFT ${ms(row.ttftMs)}` +
    ` · out ${(row.outputTokens ?? 0) + (row.reasoningTokens ?? 0)} tok` +
    ` · ${row.model || "?"}` +
    ` · ${row.status === "completed" ? "✓" : (row.status || "no data")}`
  );
}

export function formatTurnLine(turn) {
  return (
    `⚡ this question ${fmt(turn.avgTps, " tok/s")}` +
    ` · TTFT ${ms(turn.avgTtftMs)}` +
    ` · out ${(turn.outputTokens ?? 0) + (turn.reasoningTokens ?? 0)} tok` +
    ` · ${turn.samples} request${turn.samples === 1 ? "" : "s"}`
  );
}

export function formatSnapshot(snap) {
  const lines = [];
  lines.push(
    `⚡ ${fmt(snap.last?.tokPerSec, " tok/s")}${snap.live ? "(live)" : ""}` +
      ` · TTFT ${ms(snap.last?.ttftMs)}`
  );
  if (snap.window && snap.window.samples) {
    lines.push(`last ${snap.window.window}: avg ${fmt(snap.window.avgTps, " tok/s")} / peak ${fmt(snap.window.peakTps, " tok/s")}`);
  }
  if (snap.session) {
    // The session figure is the SESSION TREE, the same number the hover card's
    // token panel shows — every surface must agree — with the subagent share
    // stated rather than left implicit.
    const tk = snap.session.tokens || {};
    lines.push(
      `session ${tk.total ?? 0} tok` +
      ` · ${snap.session.samples} samples` +
      (snap.session.avgTps != null ? ` · avg ${snap.session.avgTps} tok/s` : "") +
      (tk.subagentSharePct ? ` · ${tk.subagentSharePct}% from subagents` : "")
    );
  }
  if (snap.subagents && (snap.subagents.requests || snap.subagents.running)) {
    lines.push(
      `subagents ${snap.subagents.requests} req${snap.subagents.requests === 1 ? "" : "s"}` +
      (snap.subagents.running ? ` (${snap.subagents.running} running)` : "") +
      ` · ${snap.subagents.generated ?? 0} tok` +
      (snap.subagents.avgTps != null ? ` · avg ${snap.subagents.avgTps} tok/s` : "")
    );
  }
  return lines.join(" · ");
}

// Cheap change probes for the snapshot cache: "has any request completed since
// the last scan?" Both are single index-assisted aggregates (well under a
// millisecond on the live DB) that make a full re-scan unnecessary when the
// answer is no. The session index is pinned for the same reason as elsewhere.
function completedSignature(db, sid) {
  try {
    const r = db
      .prepare(
        "SELECT COUNT(*) n, MAX(completed_at) m FROM model_usage" + indexHint(sid) +
          " WHERE status = 'completed'" +
          (sid ? " AND session_id = ?" : "")
      )
      .get(...(sid ? [sid] : []));
    return `${r.n}:${r.m ?? 0}`;
  } catch {
    return null;
  }
}
function toolSignature(db, sid) {
  try {
    const r = db
      .prepare(
        "SELECT COUNT(*) n, MAX(completed_at) m FROM tool_usage" + (sid ? " WHERE session_id = ?" : "")
      )
      .get(...(sid ? [sid] : []));
    return `${r.n}:${r.m ?? 0}`;
  } catch {
    return null;
  }
}

// One-stop snapshot for the session: reads the session's rows ONCE and derives
// the last request, the recent window, and the whole-session aggregate from
// that single result set.
//
// The previous implementation ran three separate session queries per refresh
// (lastRequest, windowStats, sessionAggregate) plus a scope probe, ~160 ms of
// synchronous work per second in the sidecar. One scan plus in-memory
// derivation costs roughly a third of that, which matters because node:sqlite
// blocks the event loop.
export function sessionSnapshot(db, requestedSid, opts = {}) {
  const sid = resolveSession(requestedSid);
  if (!sid) return { error: "no session", dbInfo: dbInfo() };
  const win = Math.max(1, Number(opts.window) || 10);
  const cache = opts.cache || null;

  // Reuse the previous scan when nothing has completed since. The session
  // aggregate depends only on COMPLETED rows, so a COUNT + MAX(completed_at)
  // probe (served by the session index in under a millisecond) decides whether
  // the full scan and its per-row projection can be skipped. Without this,
  // every refresh re-scanned and re-projected all ~1.5k rows of a long session
  // even when no request had landed.
  // The subagent side of the tree is a set of indexed SQL aggregates, not a row
  // read: measured 2026-10-17, the whole block costs ~12-16 ms on a 92-child,
  // 5,467-request session and ~26 ms on a 112-child, 12,041-request one when
  // only another session's traffic moved (its aggregate doubles as the block's
  // change signature, so it cannot be skipped), against ~0.2 ms for a session
  // that never spawned a subagent.
  const sub = opts.subagents === false ? null : subagentActivity(db, sid, cache);

  const sig = cache ? completedSignature(db, sid) : null;
  let rows;
  let usage;
  let derived;
  if (cache && sig != null && cache.rowSid === sid && cache.rowSig === sig && Array.isArray(cache.rows)) {
    rows = cache.rows;
    usage = Array.isArray(cache.usage) ? cache.usage : rows;
    // The window, session and tree aggregates are pure functions of the rows,
    // the window size, and the subagent aggregate, so when those are reused the
    // derived figures can be reused with them. Re-deriving means re-walking
    // every cached row each tick (aggregate + sessionAggregateFrom over ~1.4k
    // rows, ~2.5 ms warm), which is the bulk of what is left on the hot path.
    if (
      cache.derivedSid === sid && cache.derivedSig === sig && cache.derivedWin === win &&
      cache.derivedSubSig === (sub ? sub.sig : null) && cache.derived
    ) {
      derived = cache.derived;
    }
  } else {
    rows = scopeRows(db, sid);
    usage = usageRows(db, sid);
    if (cache && sig != null) {
      cache.rowSid = sid;
      cache.rowSig = sig;
      cache.rows = rows;
      cache.usage = usage;
    }
  }
  if (!derived) {
    derived = {
      window: { window: Math.min(win, rows.length), ...aggregate(rows.slice(0, win).reverse()) },
      session: sessionAggregateFrom(rows, { usage, subagents: sub }),
    };
    if (cache && sig != null) {
      cache.derivedSid = sid;
      cache.derivedSig = sig;
      cache.derivedWin = win;
      cache.derivedSubSig = sub ? sub.sig : null;
      cache.derived = derived;
    }
  }

  const snap = {
    sessionId: sid,
    generatedAt: new Date().toISOString(),
    last: rows.length ? rows[0] : null,
    window: derived.window,
    // Copy before mutating: the cached object must not absorb the tool fields
    // merged in below, or a later tick would report them as if freshly derived.
    session: { ...derived.session },
    dbInfo: dbInfo(),
  };
  // The subagent block, as its own top-level surface: the card's last band reads
  // it here, and it is NOT copied out of `session` (the payload ships it once).
  if (sub) snap.subagents = sub;
  // Measured tool time. Its own table and its own signature: tool rows land
  // far more often than model rows, but the aggregate still only moves when one
  // completes, so the same reuse applies.
  if (opts.tools !== false) {
    const tsig = cache ? toolSignature(db, sid) : null;
    let tu;
    if (cache && tsig != null && cache.toolSid === sid && cache.toolSig === tsig && cache.tools) {
      tu = cache.tools;
    } else {
      tu = toolUsageFor(db, sid);
      if (cache && tsig != null) {
        cache.toolSid = sid;
        cache.toolSig = tsig;
        cache.tools = tu;
      }
    }
    if (tu.count) {
      snap.tools = tu;
      // Replace the estimated figures with measured ones where they exist.
      snap.session.toolBusyMs = tu.busyMs;
      snap.session.toolWallMs = tu.wallMs;
      snap.session.toolCount = tu.count;
      snap.session.toolErrorCount = tu.errorCount;
    }
  }
  if (snap.last && opts.live !== false) {
    // Live flag: is a request running right now? That is a different query
    // (status='running'), which cannot be derived from completed rows.
    const running = runningRequest(db, sid);
    if (running) {
      snap.live = {
        streaming: true,
        turnId: running.turnId,
        model: running.model,
        startedAt: running.startedAt,
        waitingMs: running.startedAt ? Date.now() - running.startedAt : null,
        estTps: snap.last.tokPerSec != null ? snap.last.tokPerSec : null,
      };
    }
  }
  return snap;
}

// Whole-session aggregate computed from already-fetched rows (see
// sessionSnapshot): the wall-clock span vs LLM-busy time accounting lives here
// so both entry points report identical numbers.
//
// TWO SCOPES LIVE IN THIS ONE OBJECT, deliberately:
//
//   * conversation figures — `samples`, `requests`, the rates, the spans and
//     the busy times — come from the session's own composer requests, so
//     parallel subagent streams can never distort "how fast is MY conversation
//     running";
//   * token and model figures are the SESSION TREE: the conversation's own
//     requests (including its compaction and title requests) plus every request
//     in the sessions it spawned. "How much did this session consume" is only
//     answerable with all of it counted, and `tokens.main` / `tokens.subagents`
//     carry the split so the sum hides nothing.
export function sessionAggregateFrom(rateRows, opts = {}) {
  const agg = aggregate(rateRows);
  // The usage basis is the conversation's own rows — main_turn plus its
  // compaction / title requests (see usageRows for why). Fall back to the rate
  // rows when the caller has none: a global (session-less) query, or a DB whose
  // session scope could not be read.
  const usage = Array.isArray(opts.usage) && opts.usage.length ? opts.usage : rateRows;
  const u = aggregate(usage);
  const sub = opts.subagents || null;
  const subTok = sub ? sub.tokens : null;

  // Token panel (the app's own "Token usage" card, image 1). The conversation's
  // own requests and the tree's children are decomposed by the one shared
  // helper, then added, so the panel's figures and the app's cannot drift.
  const main = tokenDecomp({
    input: u.inputTokens,
    cacheRead: u.cacheRead,
    output: u.outputTokens,
    reasoning: u.reasoningTokens,
  });
  const cached = main.cached + (subTok ? subTok.cached : 0);
  const uncached = main.uncached + (subTok ? subTok.uncached : 0);
  const output = main.output + (subTok ? subTok.output : 0);
  const total = cached + uncached + output;
  agg.tokens = {
    total,
    cached,
    uncached,
    output,
    cacheHitPct: pct(cached, uncached),
    // The split, so "which part of this came from subagents?" never has to be
    // guessed and the panel can still be reconciled with the app's own
    // (conversation-only) token card.
    main: {
      total: main.total,
      cached: main.cached,
      uncached: main.uncached,
      output: main.output,
      cacheHitPct: pct(main.cached, main.uncached),
    },
    subagents: {
      total: subTok ? subTok.total : 0,
      cached: subTok ? subTok.cached : 0,
      uncached: subTok ? subTok.uncached : 0,
      output: subTok ? subTok.output : 0,
      cacheHitPct: subTok ? subTok.cacheHitPct : null,
    },
    subagentSharePct:
      subTok && subTok.total > 0 && total > 0
        ? round1((subTok.total / total) * 100)
        : null,
  };
  // The token sums on the aggregate itself are TREE-wide: every surface that
  // shows "the session's tokens" (CLI, MCP, dashboard card) must show the same
  // number the hover card's token panel shows, or the plugin contradicts itself.
  // `tokens.main` is the conversation-only figure for anyone who wants it.
  agg.outputTokens = (u.outputTokens || 0) + (sub ? sub.outputTokens : 0);
  agg.reasoningTokens = (u.reasoningTokens || 0) + (sub ? sub.reasoningTokens : 0);
  agg.inputTokens = (u.inputTokens || 0) + (sub ? sub.inputTokens : 0);
  agg.cacheRead = (u.cacheRead || 0) + (sub ? sub.cacheRead : 0);

  const a = rateRows.length ? Math.min(...rateRows.map((r) => r.startedAt ?? Infinity)) : null;
  const b = rateRows.length ? Math.max(...rateRows.map((r) => r.completedAt ?? 0)) : null;
  if (a != null && b != null && b > a) {
    agg.spanMs = b - a;
    agg.busyMs = rateRows.reduce((s, r) => s + (r.genMs ?? r.ttftMs ?? 0), 0);
    agg.otherMs = Math.max(0, agg.spanMs - agg.busyMs);
    agg.requestBusyMs = rateRows.reduce(
      (s, r) => s + (r.completedAt != null && r.startedAt != null ? r.completedAt - r.startedAt : 0),
      0
    );
  }
  // Which models did this session actually use, and how much of it did each
  // account for? A session can switch models mid-flight (a fast model for
  // mechanical turns, a heavier one for reasoning), and that split is invisible
  // in the whole-session totals. Derived from the same rows the snapshot already
  // pays for, plus the subagent per-model groups (which arrive as SQL sums, so
  // no subagent rows are read).
  //
  // Share is measured on generated tokens (output + reasoning), the quantity a
  // user means by "how much work did each model do". Requests are carried
  // alongside so a model that ran many cheap turns is not misread as minor.
  //
  // The map covers the SESSION TREE, because the donut's slices must sum to the
  // token total the card above it shows. `subagentRequests` says how much of
  // each model's traffic came from spawned agents.
  const byModel = new Map();
  const modelEntry = (key, provider) => {
    let m = byModel.get(key);
    if (!m) {
      m = {
        model: key,
        provider,
        requests: 0,
        subagentRequests: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        tokPerSecSum: 0,
        rated: 0,
      };
      byModel.set(key, m);
    }
    return m;
  };
  for (const r of usage) {
    const m = modelEntry(r.model || "(unknown)", providerLabel(r.providerId, r.model));
    m.requests += 1;
    m.outputTokens += r.outputTokens || 0;
    m.reasoningTokens += r.reasoningTokens || 0;
    if (r.tokPerSec != null) { m.tokPerSecSum += r.tokPerSec; m.rated += 1; }
  }
  for (const sm of sub ? sub.models || [] : []) {
    const m = modelEntry(sm.model, sm.provider);
    m.requests += sm.requests || 0;
    m.subagentRequests += sm.requests || 0;
    m.outputTokens += sm.outputTokens || 0;
    m.reasoningTokens += sm.reasoningTokens || 0;
    m.tokPerSecSum += sm.rateSum || 0;
    m.rated += sm.rated || 0;
  }
  const models = Array.from(byModel.values()).map((m) => {
    const generated = m.outputTokens + m.reasoningTokens;
    return {
      model: m.model,
      provider: m.provider,
      requests: m.requests,
      subagentRequests: m.subagentRequests,
      outputTokens: m.outputTokens,
      reasoningTokens: m.reasoningTokens,
      generated,
      avgTps: m.rated ? round1(m.tokPerSecSum / m.rated) : null,
    };
  });
  const totalGenerated = models.reduce((s, m) => s + m.generated, 0);
  for (const m of models) {
    m.share = totalGenerated > 0 ? round1((m.generated / totalGenerated) * 100) : 0;
  }
  // Rank by share, then by generated tokens, so the chart's largest slice is
  // first and ties break deterministically.
  models.sort((a, b) => b.share - a.share || b.generated - a.generated || String(a.model).localeCompare(String(b.model)));
  agg.models = models;
  agg.modelCount = models.length;
  return agg;
}

// ---------------------------------------------------------------------------
// Tool time (measured, not estimated)
// ---------------------------------------------------------------------------

// ZCode records every tool invocation in its own `tool_usage` table (started_at,
// completed_at, duration_ms, tool_name) — indexed on (session_id, turn_id) and
// (session_id, tool_call_id). So "Tool time" can be read exactly instead of
// inferred as `session span − LLM time` (which, on this session, produced
// ~170 min against a real 91 min of tool execution: the estimate also swallowed
// every idle gap between turns).
//
// Fast path (default): the three fields the UI actually shows — the number of
// tool calls, the summed duration ("tool work performed"), and the error count
// — as ONE indexed SQL aggregate. Measured at ~0.4 ms on a 1.5k-row session
// versus ~3.8 ms for the full row scan, and it produced byte-identical numbers
// (verified against the detailed path).
//
// Detailed path (opts.detail): also returns per-tool totals and the union of
// tool intervals. Nothing in the plugin displays those today, so it stays
// opt-in and off the hot refresh path.
export function toolUsageFor(db, sid, opts = {}) {
  const out = { count: 0, busyMs: 0, wallMs: 0, errorCount: 0, byTool: [] };
  if (!sid) return out;

  if (!opts.detail) {
    try {
      const r = db
        .prepare(
          "SELECT COUNT(*) n," +
            " SUM(CASE WHEN duration_ms IS NOT NULL THEN duration_ms" +
            "          WHEN completed_at IS NOT NULL AND started_at IS NOT NULL THEN completed_at - started_at" +
            "          ELSE 0 END) busy," +
            " SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) errs" +
            " FROM tool_usage WHERE session_id = ?"
        )
        .get(sid);
      out.count = r?.n ?? 0;
      out.busyMs = r?.busy ?? 0;
      out.errorCount = r?.errs ?? 0;
      return out;
    } catch {
      return out; // older DB without the table: leave the figures absent
    }
  }

  let rows;
  try {
    rows = db
      .prepare(
        "SELECT tool_name, status, started_at, completed_at, duration_ms" +
          " FROM tool_usage WHERE session_id = ? ORDER BY started_at ASC"
      )
      .all(sid);
  } catch {
    return out; // older DB without the table: leave the figures absent
  }
  if (!rows.length) return out;
  const intervals = [];
  const perTool = new Map();
  for (const r of rows) {
    out.count++;
    if (r.status === "error") out.errorCount++;
    const dur =
      r.duration_ms != null
        ? r.duration_ms
        : r.completed_at != null && r.started_at != null
          ? r.completed_at - r.started_at
          : 0;
    if (dur > 0) {
      out.busyMs += dur;
      const t = perTool.get(r.tool_name) || { name: r.tool_name, count: 0, ms: 0 };
      t.count++;
      t.ms += dur;
      perTool.set(r.tool_name, t);
    }
    if (r.started_at != null && r.completed_at != null && r.completed_at >= r.started_at) {
      intervals.push([r.started_at, r.completed_at]);
    }
  }
  // Union of intervals: merge overlaps so nested/parallel tools count once.
  intervals.sort((x, y) => x[0] - y[0]);
  let curS = null;
  let curE = null;
  for (const [s, e] of intervals) {
    if (curS === null) {
      curS = s;
      curE = e;
    } else if (s <= curE) {
      if (e > curE) curE = e;
    } else {
      out.wallMs += curE - curS;
      curS = s;
      curE = e;
    }
  }
  if (curS !== null) out.wallMs += curE - curS;
  out.byTool = [...perTool.values()].sort((x, y) => y.ms - x.ms).slice(0, 10);
  return out;
}

export function fullSnapshot(db, requestedSid, opts = {}) {
  return sessionSnapshot(db, requestedSid, opts);
}

// ---------------------------------------------------------------------------
// Turn usage (ZCode's own per-turn accounting)
// ---------------------------------------------------------------------------

// ZCode records one row per TURN in its own `turn_usage` table — the same
// accounting its own usage UI shows. This is a different grain from
// `model_usage` (one row per HTTP model request): a turn is one user question
// and may contain many model requests ("steps") and tool calls.
//
// The rendered conversation can be joined to these rows: each assistant turn in
// the DOM carries data-turn-id, and that value equals turn_usage.user_message_id
// (verified live: 28 of 30 rendered turns matched a row directly). The
// (session_id, turn_id) primary key serves the session query; user_message_id
// is NOT indexed, but a session holds only tens of turns, so the whole session
// is read once and mapped in memory.
//
// Token fields come from the shared decomposition above (tokenDecomp / pct),
// matched against the app's own usage panel figures; the one caveat that belongs
// to this table is that `cache_creation_input_tokens` is NOT the uncached figure
// — it is 0 on almost every row in practice, while input-minus-cache_read is the
// real uncached count (verified: they differ on 1936 of 1943 live rows).
// `model_usage.provider_id` is an internal id — a UUID for custom endpoints
// (e.g. 35d6923f-… → "Ollama Cloud") or a builtin slug like
// "builtin:zai-coding-plan". The user-facing provider NAME lives in ZCode's own
// provider config, so read it from there (read-only) and fall back to the raw id
// when the config or the entry is missing. Cached: the file changes rarely, and
// this keeps the mapping off every turn query.
let PROVIDER_NAMES = null;
function providerNames() {
  if (PROVIDER_NAMES) return PROVIDER_NAMES;
  PROVIDER_NAMES = {};
  const cfgPath = path.join(os.homedir(), ".zcode", "v2", "provider_config.json");
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    const rules = cfg?.config?.providerConfigRules?.providerRules;
    if (Array.isArray(rules)) {
      for (const r of rules) {
        if (r && r.providerId && r.providerName) PROVIDER_NAMES[r.providerId] = r.providerName;
      }
    }
  } catch {
    /* no config: fall back to raw ids */
  }
  return PROVIDER_NAMES;
}

// "Ollama Cloud/deepseek-v4.1-flash:cloud" — provider display name / model id,
// matching the app's own "Provider / model" row.
function providerLabel(providerId, modelId) {
  const name = providerNames()[providerId] || providerId || "";
  return name && modelId ? name + "/" + modelId : (modelId || name || null);
}

export function turnUsageFor(db, sid) {
  const out = { turns: [], byUserMessage: {}, totals: null };
  if (!sid) return out;
  let rows;
  try {
    // `turn_usage` carries no model column, but the app's own per-turn panel
    // shows "Provider / model". It is available on model_usage for the same
    // turn; take the most recent request's (provider_id, model_id) so a turn
    // that switched models mid-flight reports the last one it used.
    rows = db
      .prepare(
        "SELECT t.turn_id, t.user_message_id, t.status, t.started_at, t.completed_at, t.duration_ms," +
          " t.time_to_first_token_ms, t.model_request_count, t.tool_call_count, t.tool_error_count," +
          " t.input_tokens, t.output_tokens, t.reasoning_tokens," +
          " t.cache_read_input_tokens, t.cache_creation_input_tokens, t.computed_total_tokens," +
          " (SELECT m.provider_id FROM model_usage m" +
          "   WHERE m.session_id = t.session_id AND m.turn_id = t.turn_id" +
          "   ORDER BY m.completed_at DESC LIMIT 1) AS provider_id," +
          " (SELECT m.model_id FROM model_usage m" +
          "   WHERE m.session_id = t.session_id AND m.turn_id = t.turn_id" +
          "   ORDER BY m.completed_at DESC LIMIT 1) AS model_id" +
          " FROM turn_usage t WHERE t.session_id = ? ORDER BY t.started_at ASC"
      )
      .all(sid);
  } catch {
    return out; // older DB without the table: leave the figures absent
  }
  let turns = 0, steps = 0, tools = 0, toolErrors = 0, total = 0, cached = 0, uncached = 0, output = 0;
  for (const r of rows) {
    const t = turnRow(r);
    if (t.userMessageId) out.byUserMessage[t.userMessageId] = t;
    out.turns.push(t);
    turns++;
    steps += t.steps || 0;
    tools += t.toolCalls || 0;
    toolErrors += t.toolErrors || 0;
    total += t.totalTokens || 0;
    cached += t.cachedTokens || 0;
    uncached += t.uncachedTokens || 0;
    output += t.outputTokens || 0;
  }
  out.totals = {
    turns, steps, toolCalls: tools, toolErrors,
    totalTokens: total, cachedTokens: cached, uncachedTokens: uncached, outputTokens: output,
    cacheHitPct: pct(cached, uncached),
  };
  return out;
}

// Cheap session totals for the card: one indexed aggregate served by
// turn_usage's (session_id, turn_id) primary key. The pill needs only these
// counts, not the per-turn rows, so this stays off the heavier row read.
export function turnTotals(db, sid) {
  if (!sid) return null;
  try {
    const r = db
      .prepare(
        "SELECT COUNT(*) turns, SUM(model_request_count) steps, SUM(tool_call_count) tools," +
          " SUM(tool_error_count) toolErrors, SUM(computed_total_tokens) total," +
          " SUM(cache_read_input_tokens) cached, SUM(input_tokens) inp, SUM(output_tokens) out," +
          " SUM(reasoning_tokens) reas" +
          " FROM turn_usage WHERE session_id = ?"
      )
      .get(sid);
    if (!r || !r.turns) return null;
    const d = tokenDecomp({ input: r.inp, cacheRead: r.cached, output: r.out, reasoning: r.reas });
    return {
      turns: r.turns,
      steps: r.steps ?? 0,
      toolCalls: r.tools ?? 0,
      toolErrors: r.toolErrors ?? 0,
      totalTokens: r.total ?? d.total,
      cachedTokens: d.cached,
      uncachedTokens: d.uncached,
      outputTokens: d.output,
      cacheHitPct: pct(d.cached, d.uncached),
    };
  } catch {
    return null; // older DB without the table
  }
}

function turnRow(r) {
  const d = tokenDecomp({
    input: r.input_tokens,
    cacheRead: r.cache_read_input_tokens,
    output: r.output_tokens,
    reasoning: r.reasoning_tokens,
  });
  const durationMs = r.duration_ms != null ? r.duration_ms : (r.completed_at != null && r.started_at != null ? r.completed_at - r.started_at : null);
  // Turn-level speed, as the app's "Turn time and speed" card reports it:
  // generated (output) tokens over wall-clock duration. Null when either side
  // is missing — a running turn has no duration yet.
  const tps = durationMs && durationMs > 0 && d.output > 0 ? round1(d.output / (durationMs / 1000)) : null;
  return {
    turnId: r.turn_id,
    userMessageId: r.user_message_id,
    status: r.status,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    durationMs,
    tps,
    ttftMs: r.time_to_first_token_ms,
    steps: r.model_request_count ?? 0,          // one step = one model request
    toolCalls: r.tool_call_count ?? 0,
    toolErrors: r.tool_error_count ?? 0,
    inputTokens: r.input_tokens ?? 0,
    cachedTokens: d.cached,
    uncachedTokens: d.uncached,
    cacheCreationTokens: r.cache_creation_input_tokens ?? 0,
    outputTokens: d.output,
    totalTokens: r.computed_total_tokens ?? d.total,
    model: providerLabel(r.provider_id, r.model_id),
  };
}

// Per-turn lookup by the DOM's data-turn-id (= user_message_id). Returns null
// when the turn has not been accounted yet (still running, or an older DB).
export function turnUsageByMessage(db, sid, userMessageId) {
  if (!sid || !userMessageId) return null;
  try {
    const r = db
      .prepare("SELECT * FROM turn_usage WHERE session_id = ? AND user_message_id = ? LIMIT 1")
      .get(sid, userMessageId);
    return r ? turnRow(r) : null;
  } catch {
    return null;
  }
}

// Live interpolation: while a request is running (status='running'), token
// counts reach the DB only on completion, so the last completed request's
// rate is used as the live estimate; waiting time before the first token is
// reported from the running row's start.
export function liveRate(db, sid) {
  const running = runningRequest(db, sid);
  if (!running) return { streaming: false };
  const last = lastRequest(db, sid);
  return {
    streaming: true,
    turnId: running.turnId,
    model: running.model,
    startedAt: running.startedAt,
    waitingMs: running.startedAt ? Date.now() - running.startedAt : null,
    estTps: last && last.tokPerSec != null ? last.tokPerSec : null,
  };
}

// ---------------------------------------------------------------------------
// Subagent activity — the tree's spawned sessions, attributed by parent link
// ---------------------------------------------------------------------------
//
// A subagent's model requests are written to its OWN session
// (`sess_subagent_agent_<uuid>`), never the parent conversation's. What was
// believed missing was any attribution route, and there is one: the child
// session names its parent.
//
//   session.parent_id → the session that spawned it (task_type =
//                       'subagent_child')
//
// Verified on the live DB: 735 of 735 subagent sessions have a parent, every
// parent is an interactive session (no nesting — so one level is the whole
// tree), and the link exists from the moment the child session is created, so a
// subagent that is running right now is attributable too.
//
// What does NOT exist is a per-TURN link, and nothing here pretends otherwise:
// a subagent row's `turn_id` never equals a parent main_turn `turn_id`
// (0 of 26k), and its `parent_user_message_id` matches no
// `turn_usage.user_message_id` (0 of 22,332 rows). Session attribution is
// exact; turn attribution would be a fabrication.
//
// WHY THIS REPLACED A TIME WINDOW. This surface used to report "subagents that
// ran in the last 15 minutes, machine-wide", because attribution was believed
// impossible. That had three consequences, each visible to a user:
//
//   * the count was a MOVING window, so it fell as rows aged out. A card
//     reading "91 reqs" could read "89 reqs" a second later with no work undone
//     — and because the window's lower bound only advances when a refresh runs,
//     the first refresh after an idle stretch dropped every expired row at once;
//   * it counted other conversations' subagents, so a chat that had spawned none
//     could show a busy block;
//   * its tokens belonged to no session, so they could not be part of the
//     session's totals and its cache-hit % described only part of its traffic.
//
// Scoped to the session, the count only ever grows, the block belongs to the
// conversation being read, and its tokens fold into the tree totals
// (sessionAggregateFrom) with `tokens.subagents` / `tokens.subagentSharePct`
// carrying the split.
//
// The block covers EVERY request in the spawned sessions (`query_source` is not
// filtered): by definition, whatever a child session ran, it ran for this
// conversation. Those sessions' own compaction requests are included for the
// same reason the conversation's are — see usageRows.

// The per-row rate, in SQL, so the whole subagent surface is a handful of
// indexed aggregates rather than a row read plus a per-row projection in JS.
// The two tiers mirror toRow exactly:
//
//   text tier: a first token exists and the generation window is in bounds
//              → (output + reasoning) / (completed - first_token)
//   wire tier: no first token (tool-call-only) → output / duration_ms
//
// AVG/SUM/MAX skip NULLs in SQL exactly as the JS path drops unrated rows, so
// the statistics cover rated samples only. The one difference from the JS path
// is that the mean is taken over exact rates rather than over rates rounded to
// 0.1 first, which moves an average by at most 0.05 tok/s (the JS path had the
// rounding error, this one does not).
const RATE_SQL =
  "CASE WHEN first_token_at IS NOT NULL AND completed_at > first_token_at" +
  "          AND completed_at - first_token_at >= ? AND completed_at - first_token_at < ?" +
  "          AND output_tokens + reasoning_tokens > 0" +
  "     THEN (output_tokens + reasoning_tokens) * 1000.0 / (completed_at - first_token_at)" +
  "     WHEN duration_ms >= ? AND duration_ms < ? AND output_tokens > 0" +
  "     THEN output_tokens * 1000.0 / duration_ms END";
const RATE_ARGS = [MIN_GEN_MS, MAX_GEN_MS, MIN_GEN_MS, MAX_GEN_MS];

// The child set, as a SUBQUERY rather than an `IN (?, ?, …)` list of ids, so
// the set is never materialised in JS and the query is one statement whatever
// the tree's size. Confirmed with EXPLAIN QUERY PLAN: the planner walks
// `session_parent_idx` and then does one index seek per child through
// `model_usage_session_turn_idx`, so the cost tracks the TREE's rows rather than
// the database's — which is what keeps a 92-child tree's block in the tens of
// milliseconds while the table itself holds ~55k model rows.
const CHILD_SESSIONS = "(SELECT id FROM session WHERE parent_id = ?)";

export function subagentActivity(db, sid, cache) {
  const empty = {
    sessionId: sid || null,
    sig: "0:0",
    sessions: 0,
    requests: 0,
    running: 0,
    runningAgents: [],
    avgTps: null,
    peakTps: null,
    avgTtftMs: null,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheRead: 0,
    generated: 0,
    tokens: { total: 0, cached: 0, uncached: 0, output: 0, cacheHitPct: null },
    lastAt: null,
    active: false,
    agents: [],
    models: [],
  };
  if (!sid) return empty;
  let agg;
  try {
    agg = db
      .prepare(
        "SELECT" +
          " SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) requests," +
          " SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) running," +
          " SUM(CASE WHEN status = 'completed' THEN input_tokens ELSE 0 END) inp," +
          " SUM(CASE WHEN status = 'completed' THEN output_tokens ELSE 0 END) out," +
          " SUM(CASE WHEN status = 'completed' THEN reasoning_tokens ELSE 0 END) reas," +
          " SUM(CASE WHEN status = 'completed' THEN cache_read_input_tokens ELSE 0 END) cr," +
          " MAX(CASE WHEN status = 'completed' THEN completed_at END) lastAt," +
          " AVG(CASE WHEN status = 'completed' THEN (" + RATE_SQL + ") END) avgTps," +
          " MAX(CASE WHEN status = 'completed' THEN (" + RATE_SQL + ") END) peakTps," +
          " AVG(CASE WHEN (" + RATE_SQL + ") IS NOT NULL THEN time_to_first_token_ms END) avgTtftMs" +
          " FROM model_usage WHERE session_id IN " + CHILD_SESSIONS
      )
      .get(...RATE_ARGS, ...RATE_ARGS, ...RATE_ARGS, sid);
  } catch {
    // No `session` table (an older DB) or no `model_usage`: report no subagent
    // activity rather than throwing into the snapshot path.
    return empty;
  }
  if (!agg || !agg.requests && !agg.running) return empty;

  // The signature makes the group-by queries below skippable when nothing has
  // moved since the last refresh.
  const sig = `${agg.requests || 0}:${agg.lastAt || 0}:${agg.running || 0}`;
  if (cache && cache.subSid === sid && cache.subSig === sig && cache.sub) return cache.sub;

  const requests = agg.requests || 0;
  const agents = requests
    ? db
        .prepare(
          "SELECT agent, COUNT(*) requests, SUM(output_tokens + reasoning_tokens) generated" +
            " FROM model_usage WHERE session_id IN " + CHILD_SESSIONS +
            " AND status = 'completed' GROUP BY agent ORDER BY requests DESC, agent ASC"
        )
        .all(sid)
        .map((r) => ({ agent: r.agent || "subagent", requests: r.requests, generated: r.generated || 0 }))
    : [];
  const models = requests
    ? db
        .prepare(
          "SELECT model_id, MAX(provider_id) provider_id, COUNT(*) requests," +
            " SUM(output_tokens) out, SUM(reasoning_tokens) reas," +
            " SUM((" + RATE_SQL + ")) rateSum," +
            " SUM(CASE WHEN (" + RATE_SQL + ") IS NOT NULL THEN 1 ELSE 0 END) rated" +
            " FROM model_usage WHERE session_id IN " + CHILD_SESSIONS +
            " AND status = 'completed' GROUP BY model_id"
        )
        .all(...RATE_ARGS, ...RATE_ARGS, sid)
        .map((r) => ({
          model: r.model_id,
          provider: providerLabel(r.provider_id, r.model_id),
          requests: r.requests,
          outputTokens: r.out || 0,
          reasoningTokens: r.reas || 0,
          // The per-model rate sum and its sample count, so the merged model mix
          // can weight them exactly instead of averaging averages.
          rateSum: r.rateSum || 0,
          rated: r.rated || 0,
        }))
    : [];
  const runningAgents = agg.running
    ? db
        .prepare(
          "SELECT DISTINCT agent FROM model_usage WHERE session_id IN " + CHILD_SESSIONS +
            " AND status = 'running'"
        )
        .all(sid)
        .map((r) => r.agent || "subagent")
    : [];
  let sessions = 0;
  try {
    sessions = db.prepare("SELECT COUNT(*) n FROM session WHERE parent_id = ?").get(sid)?.n ?? 0;
  } catch {
    /* the count is cosmetic; the aggregate above already proves there is a tree */
  }

  const d = tokenDecomp({ input: agg.inp, cacheRead: agg.cr, output: agg.out, reasoning: agg.reas });
  const out = {
    sessionId: sid,
    sig,
    sessions,
    requests,
    running: agg.running || 0,
    runningAgents,
    avgTps: round1(agg.avgTps),
    peakTps: round1(agg.peakTps),
    avgTtftMs: round1(agg.avgTtftMs),
    inputTokens: agg.inp || 0,
    outputTokens: agg.out || 0,
    reasoningTokens: agg.reas || 0,
    cacheRead: d.cached,
    generated: d.output,
    tokens: {
      total: d.total,
      cached: d.cached,
      uncached: d.uncached,
      output: d.output,
      cacheHitPct: pct(d.cached, d.uncached),
    },
    lastAt: agg.lastAt || null,
    // "Active" means a subagent is working now, or one finished in the last
    // minute — recent enough that the user still considers it happening.
    active: (agg.running || 0) > 0 || (agg.lastAt != null && Date.now() - agg.lastAt < 60_000),
    agents,
    models,
  };
  if (cache) {
    cache.subSid = sid;
    cache.subSig = sig;
    cache.sub = out;
  }
  return out;
}
