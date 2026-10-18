// The MCP tools: schemas and the two read-only handlers.
//
// Kept apart from the stdio framing so the protocol loop stays small and the
// database work can be read (and tested) without a JSON-RPC client.
import { DatabaseSync } from "node:sqlite";
import * as metrics from "../../scripts/lib/metrics.mjs";

export const TOOLS = [
  {
    name: "request_stats",
    description:
      "Per-request TPS (output tok/s) and TTFT (time-to-first-token) stats from ZCode's usage DB: latest request, last-N window average/peak, and per-turn aggregate. Also reports the session's token accounting (total / cached / uncached / output, cache-hit %) including the subagents the session spawned, and that subagent activity separately. Works for every provider including custom endpoints.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Scope to a session; default follows the user's most recent session." },
        window: { type: "integer", minimum: 1, maximum: 100, description: "Window size for the average, default 10." },
      },
    },
  },
  {
    name: "history_stats",
    description:
      "Recent per-request samples with per-request tok/s and TTFT, newest last. For spotting slow providers or speed regressions.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 50, description: "How many recent samples, default 15." },
        session_id: { type: "string" },
      },
    },
  },
];

// The usage DB is created by ZCode the first time a message is sent, so "the DB
// file does not exist yet" and "there is no session yet" are the same, ordinary
// situation on a fresh install. Open once, here, and turn that case into the
// tool's own sentence instead of letting a raw sqlite error ("unable to open
// database file") reach the user through a tool result.
function openDbOrNull() {
  try {
    if (!metrics.dbExists()) return null;
    return new DatabaseSync(metrics.DB_PATH, { readOnly: true });
  } catch {
    return null;
  }
}
const NO_DB = { content: [{ type: "text", text: "no session yet — ZCode creates its usage database with the first message" }] };

function toolRequestStats(args) {
  const db = openDbOrNull();
  if (!db) return NO_DB;
  try {
    const sid = metrics.resolveSession(args?.session_id || null);
    if (!sid) return { content: [{ type: "text", text: "no session yet" }] };
    const snap = metrics.fullSnapshot(db, sid, { window: args?.window || 10 });
    const recent = metrics.recentRequests(db, sid, 5).reverse();
    const lines = [];
    lines.push(`session: ${sid}`);
    if (snap.last) lines.push(`last: ${metrics.formatLine(snap.last)}`);
    if (snap.live?.streaming) lines.push(`live: streaming now (est ${snap.live.estTps ?? "?"} tok/s)`);
    if (snap.window?.samples) lines.push(`window(${snap.window.window}): avg ${snap.window.avgTps} tok/s · peak ${snap.window.peakTps} tok/s · avg TTFT ${snap.window.avgTtftMs ?? "?"} ms`);
    if (snap.session) {
      const tk = snap.session.tokens || {};
      lines.push(
        `session: ${tk.total ?? 0} tokens (${tk.cached ?? 0} cached / ${tk.uncached ?? 0} uncached / ${tk.output ?? 0} output)` +
          ` · cache hit ${tk.cacheHitPct ?? "—"}% · ${snap.session.samples} samples · avg ${snap.session.avgTps ?? "—"} tok/s`
      );
      if (tk.subagentSharePct) lines.push(`  of which subagents: ${tk.subagentSharePct}%`);
    }
    // Subagent activity belongs to THIS session (attributed through the child
    // sessions' parent link), so it explains part of the totals above rather
    // than being a separate, machine-wide window.
    const sa = snap.subagents;
    if (sa && (sa.requests || sa.running)) {
      lines.push(
        `subagents: ${sa.requests} request${sa.requests === 1 ? "" : "s"}` +
          (sa.running ? ` (${sa.running} running now)` : "") +
          ` · ${sa.generated ?? 0} generated tok · cache hit ${sa.tokens?.cacheHitPct ?? "—"}%` +
          ` · avg ${sa.avgTps ?? "—"} tok/s · avg TTFT ${sa.avgTtftMs ?? "—"} ms` +
          (sa.agents?.length ? ` · ${sa.agents.map((a) => a.agent + "×" + a.requests).join(", ")}` : "")
      );
    }
    if (recent.length) {
      lines.push("recent:");
      for (const r of recent) lines.push(`  - ${metrics.formatLine(r)}`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  } finally {
    try { db.close(); } catch {}
  }
}

function toolHistoryStats(args) {
  const db = openDbOrNull();
  if (!db) return NO_DB;
  try {
    const sid = metrics.resolveSession(args?.session_id || null);
    if (!sid) return { content: [{ type: "text", text: "no session yet" }] };
    const rows = metrics.recentRequests(db, sid, args?.limit || 15).reverse();
    const lines = rows.map((r) => {
      const t = new Date(r.completedAt || 0).toISOString().slice(11, 19);
      return `${t}  ${r.tokPerSec ?? "—"} tok/s  ttft ${r.ttftMs ?? "?"}ms  ${r.outputTokens + r.reasoningTokens} tok  ${r.model}${r.status === "completed" ? "" : " (" + r.status + ")"}`;
    });
    return { content: [{ type: "text", text: rows.length ? lines.join("\n") : "no completed requests yet" }] };
  } finally {
    try { db.close(); } catch {}
  }
}

// One dispatch point for the protocol layer. A tool failure is returned as
// text, matching how MCP clients expect tool errors to arrive.
export function callTool(name, args) {
  if (name === "request_stats") return toolRequestStats(args);
  if (name === "history_stats") return toolHistoryStats(args);
  throw new Error(`unknown tool: ${name}`);
}
