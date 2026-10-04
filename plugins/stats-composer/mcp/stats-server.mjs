#!/usr/bin/env node
// stats-composer MCP server — stdio JSON-RPC (Content-Length framing).
// Tools expose the same per-request TPS / TTFT data as the sidecar.
//
// Smoke test:
//   printf '%s\n' \
//     '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"manual","version":"0"}}}' \
//     '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
//     | node mcp/stats-server.mjs

process.removeAllListeners("warning");
process.on("warning", () => {});
const { DatabaseSync } = await import("node:sqlite");
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as metrics from "../scripts/lib/metrics.mjs";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let VERSION = "0.0.0";
try {
  VERSION = JSON.parse(readFileSync(join(PLUGIN_ROOT, ".zcode-plugin", "plugin.json"), "utf8")).version;
} catch {}
const SERVER_INFO = { name: "stats-composer", version: VERSION };

const TOOLS = [
  {
    name: "request_stats",
    description:
      "Per-request TPS (output tok/s) and TTFT (time-to-first-token) stats from ZCode's usage DB: latest request, last-N window average/peak, and per-turn aggregate. Works for every provider including custom endpoints.",
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

function writeMessage(message) {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

const ok = (id, result) => writeMessage({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) =>
  writeMessage({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

function toolRequestStats(args) {
  const db = new DatabaseSync(metrics.DB_PATH, { readOnly: true });
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
    if (snap.session) lines.push(`session: ${snap.session.samples} samples · avg ${snap.session.avgTps ?? "—"} tok/s`);
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
  const db = new DatabaseSync(metrics.DB_PATH, { readOnly: true });
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

async function handleRequest(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return;
  switch (method) {
    case "initialize":
      return ok(id, {
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: TOOLS });
    case "tools/call": {
      const name = params?.name;
      try {
        if (name === "request_stats") return ok(id, toolRequestStats(params?.arguments));
        if (name === "history_stats") return ok(id, toolHistoryStats(params?.arguments));
        return fail(id, -32602, `unknown tool: ${name}`);
      } catch (e) {
        return ok(id, { content: [{ type: "text", text: `error: ${e?.message || e}` }] });
      }
    }
    default:
      return fail(id, -32601, `method not found: ${method}`);
  }
}

let buf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (true) {
    const header = buf.indexOf("\r\n\r\n");
    if (header < 0) {
      // newline-delimited fallback
      const nl = buf.indexOf("\n");
      if (nl < 0) break;
      const line = buf.subarray(0, nl).toString().trim();
      buf = buf.subarray(nl + 1);
      if (line) handleLine(line);
      continue;
    }
    const head = buf.subarray(0, header).toString();
    const match = /Content-Length:\s*(\d+)/i.exec(head);
    buf = buf.subarray(header + 4);
    if (!match) continue;
    const len = Number(match[1]);
    if (buf.length < len) break;
    const body = buf.subarray(0, len).toString();
    buf = buf.subarray(len);
    handleLine(body);
  }
})
.on("end", () => process.exit(0));

async function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  try {
    await handleRequest(msg);
  } catch (e) {
    if (msg?.id != null) fail(msg.id, -32603, String(e?.message || e));
  }
}