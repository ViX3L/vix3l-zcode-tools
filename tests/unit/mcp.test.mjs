// The MCP server's wire contract, spoken the way ZCode speaks it.
//
// This is the test that would have caught the plugin's most embarrassing
// failure: the server used to reply with LSP-style `Content-Length` framing, but
// ZCode's stdio client reads ONE JSON OBJECT PER LINE (it splits on "\n",
// strips a trailing "\r", and skips lines that fail JSON.parse). Every reply
// therefore arrived glued to its header, parsed as a SyntaxError, and the app
// timed out on `initialize` — the plugin's MCP row went red while the process
// was perfectly healthy.
//
// So the client here is deliberately dumb in the same way the app is: it reads
// bytes, cuts at "\n", and requires each line to be JSON on its own. A
// regression to Content-Length fails here immediately.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { STATS_MCP_SERVER, STATS_PLUGIN_JSON, readJson } from "../lib/paths.mjs";

// Every child we start is tracked, so a test that fails before its own stop()
// cannot leak a process and keep the test runner's event loop alive forever.
// (That leak is exactly what made an earlier version of this file hang: one
// assertion threw, the server stayed running, and the runner waited on it.)
const LIVE = new Set();
after(() => {
  for (const c of LIVE) { try { c.kill("SIGKILL"); } catch {} }
  LIVE.clear();
});

// A minimal client shaped exactly like the app's: newline-delimited, permissive
// about a trailing CR, strict about each line being standalone JSON.
class LineClient {
  constructor(child) {
    this.child = child;
    this.buf = "";
    this.messages = [];
    this.raw = "";
    this.waiters = [];
    child.stdout.on("data", (chunk) => {
      this.raw += chunk.toString();
      this.buf += chunk.toString();
      let nl;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl).replace(/\r$/, "");
        this.buf = this.buf.slice(nl + 1);
        if (!line.trim()) continue;
        // The app skips SyntaxErrors; we record them so a test can see them.
        let msg = null;
        try { msg = JSON.parse(line); } catch { msg = { __parseError: line.slice(0, 60) }; }
        // Hand the message to a waiting reader, or queue it — never both, or a
        // later read would receive an earlier reply a second time.
        const w = this.waiters.shift();
        if (w) w(msg);
        else this.messages.push(msg);
      }
    });
  }
  send(obj) { this.child.stdin.write(JSON.stringify(obj) + "\n"); }
  next(timeoutMs = 5000) {
    if (this.messages.length) return Promise.resolve(this.messages.shift());
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        const i = this.waiters.indexOf(entry);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error("no reply within " + timeoutMs + "ms; raw=" + JSON.stringify(this.raw.slice(0, 200))));
      }, timeoutMs);
      const entry = (m) => { clearTimeout(t); resolve(m); };
      this.waiters.push(entry);
    });
  }
}

function start(env = {}) {
  const child = spawn(process.execPath, [STATS_MCP_SERVER], {
    env: { ...process.env, NODE_NO_WARNINGS: "1", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  LIVE.add(child);
  const err = [];
  child.stderr.on("data", (c) => err.push(c.toString()));
  const client = new LineClient(child);
  client.stderrText = () => err.join("");
  client.stop = async () => {
    LIVE.delete(child);
    if (child.exitCode != null || child.signalCode != null) return;
    const closed = new Promise((r) => child.once("close", r));
    try { child.kill("SIGKILL"); } catch {}
    await Promise.race([closed, new Promise((r) => setTimeout(r, 500))]);
  };
  return client;
}

// A fixture DB so the tools have a session to report on.
async function fixtureEnv() {
  const F = await import("../lib/fixtures.mjs");
  const m = F.makeMachine("mcp");
  const db = F.createDb(m);
  F.addSession(db, "sess_mcp_1", "MCP fixture");
  F.addRequest(db, { sessionId: "sess_mcp_1", turnId: "turn_1", tokPerSec: 100, outputTokens: 300, genMs: 3000, ttftMs: 200 });
  F.addTurn(db, { sessionId: "sess_mcp_1", turnId: "turn_1", userMessageId: "msg_1", totalTokens: 1234, durationMs: 4000 });
  db.close();
  const stateFile = path.join(m.dir, "tps-monitor.last-session.json");
  fs.writeFileSync(stateFile, JSON.stringify({ sessionId: "sess_mcp_1", ts: Date.now(), source: "test" }));
  return {
    env: { HOME: m.dir, USERPROFILE: m.dir, ZCODE_USAGE_DB: m.dbPath, TPS_MONITOR_STATE_FILE: stateFile },
    machine: m,
  };
}

test("initialize replies with ONE standalone JSON line (the framing the app reads)", async () => {
  const c = start();
  c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
  const msg = await c.next();
  assert.equal(msg.__parseError, undefined, "reply was not standalone JSON: " + msg.__parseError);
  assert.equal(msg.jsonrpc, "2.0");
  assert.equal(msg.id, 1);
  assert.equal(msg.result.protocolVersion, "2024-11-05");
  assert.equal(msg.result.serverInfo.name, "stats-composer");
  assert.ok(Array.isArray(Object.keys(msg.result.capabilities.tools)) || msg.result.capabilities.tools, "must declare tools capability");
  await c.stop();
});

test("the first bytes of a reply are never a Content-Length header", async () => {
  // The exact regression: Content-Length framing, which the app cannot parse.
  const c = start();
  c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  await c.next();
  assert.doesNotMatch(c.raw, /^\s*Content-Length:/i, "server reverted to LSP-style framing: " + JSON.stringify(c.raw.slice(0, 60)));
  assert.match(c.raw.slice(0, 1), /\{/, "a reply must BEGIN with a JSON object");
  await c.stop();
});

test("the server version matches the plugin manifest", async () => {
  const pkg = readJson(STATS_PLUGIN_JSON);
  const c = start();
  c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  const msg = await c.next();
  assert.equal(msg.result.serverInfo.version, pkg.version);
  await c.stop();
});

test("tools/list advertises both tools with input schemas", async () => {
  const c = start();
  c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  await c.next();
  c.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const msg = await c.next();
  const names = msg.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["history_stats", "request_stats"]);
  for (const t of msg.result.tools) {
    assert.ok(t.description && t.description.length > 20, `${t.name}: needs a description`);
    assert.equal(t.inputSchema.type, "object");
    assert.ok(t.inputSchema.properties, `${t.name}: needs properties`);
  }
  await c.stop();
});

test("ping and unknown methods follow the JSON-RPC shape", async () => {
  const c = start();
  c.send({ jsonrpc: "2.0", id: 1, method: "ping" });
  const pong = await c.next();
  assert.deepEqual(pong.result, {});
  c.send({ jsonrpc: "2.0", id: 2, method: "no/such/method" });
  const err = await c.next();
  assert.equal(err.error.code, -32601);
  assert.equal(err.id, 2);
  await c.stop();
});

test("a notification (no id) produces no reply, and the next request still works", async () => {
  // JSON-RPC: notifications are unanswered. If the server answered one, an id
  // could desynchronise against the app's expectations.
  const c = start();
  c.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  c.send({ jsonrpc: "2.0", id: 7, method: "ping" });
  const msg = await c.next();
  assert.equal(msg.id, 7, "first reply should be for id 7, i.e. the notification was not answered");
  await c.stop();
});

test("malformed input is skipped and does not desynchronise the stream", async () => {
  const c = start();
  c.child.stdin.write("this is not json\n");
  c.send({ jsonrpc: "2.0", id: 9, method: "ping" });
  const msg = await c.next();
  assert.equal(msg.id, 9);
  await c.stop();
});

test("two requests on one line-parse produce two replies in order", async () => {
  // The parser loops per newline; a burst must not merge or drop messages.
  const c = start();
  c.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 11, method: "ping" }) + "\n");
  c.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 12, method: "ping" }) + "\n");
  const a = await c.next();
  const b = await c.next();
  assert.deepEqual([a.id, b.id], [11, 12]);
  await c.stop();
});

test("request_stats returns session figures grounded in the fixture DB", async () => {
  const { env, machine } = await fixtureEnv();
  const c = start(env);
  c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  await c.next();
  c.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "request_stats", arguments: { session_id: "sess_mcp_1" } } });
  const msg = await c.next();
  const text = msg.result.content[0].text;
  assert.match(text, /session: sess_mcp_1/);
  assert.match(text, /last:/);
  assert.match(text, /100 tok\/s/, "the fixture's rate must appear:\n" + text);
  await c.stop();
  const F = await import("../lib/fixtures.mjs");
  F.cleanup(machine);
});

test("history_stats lists per-request samples newest last", async () => {
  const { env, machine } = await fixtureEnv();
  const c = start(env);
  c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  await c.next();
  c.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "history_stats", arguments: { session_id: "sess_mcp_1", limit: 5 } } });
  const msg = await c.next();
  const text = msg.result.content[0].text;
  assert.match(text, /tok\/s/);
  assert.match(text, /ttft/);
  await c.stop();
  const F = await import("../lib/fixtures.mjs");
  F.cleanup(machine);
});

test("an unknown tool is a JSON-RPC error, not a crash", async () => {
  const c = start();
  c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  await c.next();
  c.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "nope" } });
  const msg = await c.next();
  assert.equal(msg.error.code, -32602);
  c.send({ jsonrpc: "2.0", id: 3, method: "ping" });
  assert.equal((await c.next()).id, 3, "server must stay alive after a bad tool name");
  await c.stop();
});

test("with no session the tools answer instead of failing", async () => {
  // No DB, no state file: the tool must return a sentence, not an error, because
  // the app surfaces a tool error to the user.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zstats-mcp-empty-"));
  const c = start({ HOME: dir, USERPROFILE: dir, ZCODE_USAGE_DB: path.join(dir, "missing.sqlite"), TPS_MONITOR_STATE_FILE: path.join(dir, "none.json") });
  c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  await c.next();
  c.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "request_stats", arguments: {} } });
  const msg = await c.next();
  assert.equal(msg.error, undefined, "no session is a normal state, not an error");
  const text = msg.result.content[0].text;
  assert.match(text, /no session/i);
  await c.stop();
});

test("the server exits cleanly on stdin EOF", async () => {
  const c = start();
  c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  await c.next();
  const closed = new Promise((r) => c.child.on("close", r));
  c.child.stdin.end();
  const code = await Promise.race([closed, new Promise((r) => setTimeout(() => r("timeout"), 4000))]);
  assert.notEqual(code, "timeout", "server did not exit when the app closed the pipe");
  await c.stop();
});
