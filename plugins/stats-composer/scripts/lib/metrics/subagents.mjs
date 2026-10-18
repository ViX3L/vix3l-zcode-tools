// Subagent activity: the spawned sessions, attributed by parent link.
import { MAX_GEN_MS, MIN_GEN_MS, pct, providerLabel, round1, tokenDecomp } from "./db.mjs";

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

function emptyActivity(sid) {
  return {
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
}

function summaryQuery(db, sid) {
  try {
    return db
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
    // No `session` table (an older DB) or no `model_usage`: report no activity
    // rather than throwing into the snapshot path.
    return null;
  }
}

function agentsQuery(db, sid) {
  return db
    .prepare(
      "SELECT agent, COUNT(*) requests, SUM(output_tokens + reasoning_tokens) generated" +
        " FROM model_usage WHERE session_id IN " + CHILD_SESSIONS +
        " AND status = 'completed' GROUP BY agent ORDER BY requests DESC, agent ASC"
    )
    .all(sid)
    .map((r) => ({ agent: r.agent || "subagent", requests: r.requests, generated: r.generated || 0 }));
}

function modelsQuery(db, sid) {
  return db
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
    }));
}

function runningAgentsQuery(db, sid) {
  return db
    .prepare(
      "SELECT DISTINCT agent FROM model_usage WHERE session_id IN " + CHILD_SESSIONS +
        " AND status = 'running'"
    )
    .all(sid)
    .map((r) => r.agent || "subagent");
}

function sessionCount(db, sid) {
  try {
    return db.prepare("SELECT COUNT(*) n FROM session WHERE parent_id = ?").get(sid)?.n ?? 0;
  } catch {
    return 0; // cosmetic; the aggregate already proves there is a tree
  }
}

function buildActivity(sid, agg, requests, extra) {
  const d = tokenDecomp({ input: agg.inp, cacheRead: agg.cr, output: agg.out, reasoning: agg.reas });
  return {
    sessionId: sid,
    sig: `${requests}:${agg.lastAt || 0}:${agg.running || 0}`,
    sessions: extra.sessions,
    requests,
    running: agg.running || 0,
    runningAgents: extra.runningAgents,
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
    agents: extra.agents,
    models: extra.models,
  };
}

export function subagentActivity(db, sid, cache) {
  if (!sid) return emptyActivity(null);
  const agg = summaryQuery(db, sid);
  if (!agg || (!agg.requests && !agg.running)) return emptyActivity(sid);
  const requests = agg.requests || 0;
  const sig = `${requests}:${agg.lastAt || 0}:${agg.running || 0}`;
  if (cache && cache.subSid === sid && cache.subSig === sig && cache.sub) return cache.sub;

  const out = buildActivity(sid, agg, requests, {
    sessions: sessionCount(db, sid),
    agents: requests ? agentsQuery(db, sid) : [],
    models: requests ? modelsQuery(db, sid) : [],
    runningAgents: agg.running ? runningAgentsQuery(db, sid) : [],
  });
  if (cache) {
    cache.subSid = sid;
    cache.subSig = sig;
    cache.sub = out;
  }
  return out;
}
