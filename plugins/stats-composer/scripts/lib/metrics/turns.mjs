// Per-turn accounting from ZCode's turn_usage table.
import { pct, providerLabel, round1, tokenDecomp } from "./db.mjs";

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
