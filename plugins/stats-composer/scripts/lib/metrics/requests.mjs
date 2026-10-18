// Request-level queries and aggregates.
import {
  indexHint,
  lastActiveSessionId,
  round1,
  scopeFor,
  toRow,
} from "./db.mjs";

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

// The N most recent distinct turns for a session (newest first).
function recentTurns(db, sid, n) {
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
function turnStats(db, sid, turnId, sinceTs) {
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
