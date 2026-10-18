// Human-readable renderers shared by the CLI, MCP and hooks.
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
