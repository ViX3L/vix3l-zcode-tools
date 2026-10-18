#!/usr/bin/env node
// stats-composer MCP server — stdio JSON-RPC, newline-delimited framing.
//
// ZCode's stdio MCP client reads ONE JSON object per line (it splits on "\n"
// and skips parse failures). It does NOT speak LSP-style Content-Length
// framing: an earlier version wrote Content-Length headers, so every reply
// arrived glued to its header and the client timed out waiting for
// `initialize`. Reads stay permissive (both framings are accepted) so manual
// smoke tests still work.
//
// Smoke test:
//   printf '%s\n' \
//     '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"manual","version":"0"}}}' \
//     '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
//     | node mcp/stats-server.mjs
import path from "node:path";
import { TOOLS, callTool } from "./lib/tools.mjs";
import { pluginVersion } from "../scripts/lib/version.mjs";

const PLUGIN_ROOT = path.resolve(import.meta.dirname, "..");
const SERVER_INFO = { name: "stats-composer", version: pluginVersion(PLUGIN_ROOT) };

function writeMessage(message) {
  // One line per message — see the framing note in the header. A single
  // process.stdout.write of the whole line keeps messages from interleaving.
  process.stdout.write(JSON.stringify(message) + "\n");
}

const ok = (id, result) => writeMessage({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) =>
  writeMessage({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

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
      if (!TOOLS.some((t) => t.name === name)) {
        return fail(id, -32602, `unknown tool: ${name}`);
      }
      try {
        return ok(id, callTool(name, params?.arguments));
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
}).on("end", () => process.exit(0));

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
