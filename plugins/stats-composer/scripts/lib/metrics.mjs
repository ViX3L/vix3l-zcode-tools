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
      ? Math.round(((rateTokens / genMs) * 1000 * 10)) / 10
      : fallbackValid
        ? Math.round(((tok / fallbackMs) * 1000 * 10)) / 10
        : null,
    startedAt: r.started_at,
    completedAt: r.completed_at,
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
    arr.length
      ? Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 10) / 10
      : null;
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
    lines.push(
      `session total ${(snap.session.outputTokens ?? 0) + (snap.session.reasoningTokens ?? 0)} tok` +
      ` · ${snap.session.samples} samples` +
      (snap.session.avgTps != null ? ` · avg ${snap.session.avgTps} tok/s` : "")
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
  const sig = cache ? completedSignature(db, sid) : null;
  let rows;
  let derived;
  if (cache && sig != null && cache.rowSid === sid && cache.rowSig === sig && Array.isArray(cache.rows)) {
    rows = cache.rows;
    // The window and session aggregates are pure functions of `rows` and the
    // window size, so when the rows are reused the derived figures can be
    // reused with them. Re-deriving means re-walking every cached row each
    // tick (aggregate + sessionAggregateFrom over ~1.4k rows, ~2.5 ms warm),
    // which is the bulk of what is left on the hot path.
    if (cache.derivedSid === sid && cache.derivedSig === sig && cache.derivedWin === win && cache.derived) {
      derived = cache.derived;
    }
  } else {
    rows = scopeRows(db, sid);
    if (cache && sig != null) {
      cache.rowSid = sid;
      cache.rowSig = sig;
      cache.rows = rows;
    }
  }
  if (!derived) {
    derived = {
      window: { window: Math.min(win, rows.length), ...aggregate(rows.slice(0, win).reverse()) },
      session: sessionAggregateFrom(rows),
    };
    if (cache && sig != null) {
      cache.derivedSid = sid;
      cache.derivedSig = sig;
      cache.derivedWin = win;
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
export function sessionAggregateFrom(rows) {
  const agg = aggregate(rows);
  // Token panel (the app's own "Token usage" card, image 1). Same decomposition
  // the per-turn layer uses, applied to the whole session's model requests:
  //   cached   = cache_read_input_tokens
  //   uncached = input_tokens - cache_read_input_tokens
  //   output   = output_tokens + reasoning_tokens
  //   total    = cached + uncached + output
  //   hit%     = cached / (cached + uncached)
  // cache_creation_input_tokens is deliberately NOT used: it is 0 in practice
  // and does not equal the uncached figure (verified against live rows).
  const cached = agg.cacheRead || 0;
  const uncached = Math.max(0, (agg.inputTokens || 0) - cached);
  const output = (agg.outputTokens || 0) + (agg.reasoningTokens || 0);
  agg.tokens = {
    total: cached + uncached + output,
    cached,
    uncached,
    output,
    cacheHitPct: cached + uncached > 0 ? Math.round((cached / (cached + uncached)) * 1000) / 10 : null,
  };
  const a = rows.length ? Math.min(...rows.map((r) => r.startedAt ?? Infinity)) : null;
  const b = rows.length ? Math.max(...rows.map((r) => r.completedAt ?? 0)) : null;
  if (a != null && b != null && b > a) {
    agg.spanMs = b - a;
    agg.busyMs = rows.reduce((s, r) => s + (r.genMs ?? r.ttftMs ?? 0), 0);
    agg.otherMs = Math.max(0, agg.spanMs - agg.busyMs);
    agg.requestBusyMs = rows.reduce(
      (s, r) => s + (r.completedAt != null && r.startedAt != null ? r.completedAt - r.startedAt : 0),
      0
    );
  }
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
// Token fields, matched against the app's own usage panel figures:
//   cached    = cache_read_input_tokens
//   uncached  = input_tokens - cache_read_input_tokens
//   output    = output_tokens + reasoning_tokens
//   total     = cached + uncached + output   (equals computed_total_tokens)
//   cacheHit% = cached / (cached + uncached)
// Note: `cache_creation_input_tokens` is NOT the uncached figure — it is 0 on
// almost every row in practice, while input-minus-cache_read is the real
// uncached count (verified: they differ on 1936 of 1943 live rows).
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
    cacheHitPct: cached + uncached > 0 ? Math.round((cached / (cached + uncached)) * 1000) / 10 : null,
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
    const cached = r.cached ?? 0;
    const uncached = Math.max(0, (r.inp ?? 0) - cached);
    const output = (r.out ?? 0) + (r.reas ?? 0);
    return {
      turns: r.turns,
      steps: r.steps ?? 0,
      toolCalls: r.tools ?? 0,
      toolErrors: r.toolErrors ?? 0,
      totalTokens: r.total ?? cached + uncached + output,
      cachedTokens: cached,
      uncachedTokens: uncached,
      outputTokens: output,
      cacheHitPct: cached + uncached > 0 ? Math.round((cached / (cached + uncached)) * 1000) / 10 : null,
    };
  } catch {
    return null; // older DB without the table
  }
}

function turnRow(r) {
  const cached = r.cache_read_input_tokens ?? 0;
  const uncached = Math.max(0, (r.input_tokens ?? 0) - cached);
  const output = (r.output_tokens ?? 0) + (r.reasoning_tokens ?? 0);
  const durationMs = r.duration_ms != null ? r.duration_ms : (r.completed_at != null && r.started_at != null ? r.completed_at - r.started_at : null);
  // Turn-level speed, as the app's "Turn time and speed" card reports it:
  // generated (output) tokens over wall-clock duration. Null when either side
  // is missing — a running turn has no duration yet.
  const tps = durationMs && durationMs > 0 && output > 0 ? Math.round((output / (durationMs / 1000)) * 10) / 10 : null;
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
    cachedTokens: cached,
    uncachedTokens: uncached,
    cacheCreationTokens: r.cache_creation_input_tokens ?? 0,
    outputTokens: output,
    totalTokens: r.computed_total_tokens ?? (cached + uncached + output),
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