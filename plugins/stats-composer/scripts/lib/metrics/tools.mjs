// Measured tool time. ZCode records every tool invocation in its own
// tool_usage table, so the figures are read exactly instead of estimated as
// session span minus LLM time.
export function toolSignature(db, sid) {
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
function toolSummary(db, sid) {
  const out = { count: 0, busyMs: 0, wallMs: 0, errorCount: 0, byTool: [] };
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
  } catch { /* older DB without the table: leave the figures absent */ }
  return out;
}

function toolRows(db, sid) {
  try {
    return db
      .prepare(
        "SELECT tool_name, status, started_at, completed_at, duration_ms" +
          " FROM tool_usage WHERE session_id = ? ORDER BY started_at ASC"
      )
      .all(sid);
  } catch {
    return [];
  }
}

function unionMs(intervals) {
  intervals.sort((x, y) => x[0] - y[0]);
  let total = 0;
  let start = null;
  let end = null;
  for (const [s, e] of intervals) {
    if (start === null) { start = s; end = e; }
    else if (s <= end) { if (e > end) end = e; }
    else { total += end - start; start = s; end = e; }
  }
  return start === null ? 0 : total + (end - start);
}

function toolDetail(db, sid) {
  const out = { count: 0, busyMs: 0, wallMs: 0, errorCount: 0, byTool: [] };
  const rows = toolRows(db, sid);
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
  out.wallMs = unionMs(intervals);
  out.byTool = [...perTool.values()].sort((x, y) => y.ms - x.ms).slice(0, 10);
  return out;
}

export function toolUsageFor(db, sid, opts = {}) {
  if (!sid) return { count: 0, busyMs: 0, wallMs: 0, errorCount: 0, byTool: [] };
  return opts.detail ? toolDetail(db, sid) : toolSummary(db, sid);
}
