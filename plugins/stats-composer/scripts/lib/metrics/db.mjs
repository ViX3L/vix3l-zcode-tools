// Database access, row projection and shared token arithmetic.
//
// Everything that touches node:sqlite or turns a stored row into the shape the
// rest of the plugin reads lives here, so the one projection cannot drift.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DB_PATH =
  process.env.ZCODE_USAGE_DB ||
  path.join(os.homedir(), ".zcode", "cli", "db", "db.sqlite");

// Samples outside these generation-duration bounds are considered invalid
// (non-streamed, interrupted, or stuck rows). The reasoning tokens are part
// of the streamed output, so they count toward the rate.
export const MIN_GEN_MS = Number(process.env.TOKEN_RATE_MIN_MS) || 200;
export const MAX_GEN_MS = Number(process.env.TOKEN_RATE_MAX_MS) || 3_600_000;
const STATE_TTL_MS = 7 * 24 * 3600 * 1000;

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

export function dbInfo() {
  let sizeBytes = null;
  let lastWriteAt = null;
  try {
    const st = fs.statSync(DB_PATH);
    sizeBytes = st.size;
    lastWriteAt = st.mtimeMs;
  } catch { /* an absent DB is reported as exists:false */ }
  return { path: DB_PATH, exists: dbExists(), sizeBytes, lastWriteAt };
}

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
export const tokenDecomp = ({ input = 0, cacheRead = 0, output = 0, reasoning = 0 }) => {
  const cached = cacheRead;
  const uncached = Math.max(0, input - cached);
  const out = output + reasoning;
  return { cached, uncached, output: out, total: cached + uncached + out };
};

// cacheHitPct = cached / (cached + uncached) to one decimal, null with no input.
export const pct = (cached, uncached) =>
  cached + uncached > 0 ? Math.round((cached / (cached + uncached)) * 1000) / 10 : null;

// One-decimal rounding that passes null/NaN through (rates, averages, shares).
export const round1 = (v) => (v == null || Number.isNaN(v) ? null : Math.round(v * 10) / 10);

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
export function toRow(r) {
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
export function scopeRows(db, sid) {
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
export function usageRows(db, sid) {
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
export function indexHint(sid) {
  return sid ? ` INDEXED BY ${SES_INDEX}` : "";
}

// Session scope: prefer main_turn rows when the session has any, so parallel
// subagent traffic does not pollute human-facing numbers.
export function scopeFor(db, sid) {
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
export function providerLabel(providerId, modelId) {
  const name = providerNames()[providerId] || providerId || "";
  return name && modelId ? name + "/" + modelId : (modelId || name || null);
}
