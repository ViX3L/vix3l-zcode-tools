#!/usr/bin/env node
// doctor.mjs — health checks for stats-composer: node version, usage DB and
// schema, state file, sidecar health, CDP availability (for the composer
// pill), config sanity. Exit 0 = healthy; 1 = degraded; 2 = broken.

process.removeAllListeners("warning");
process.on("warning", () => {});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as m from "./lib/metrics.mjs";
import { appRootFromEnv, appBinaryFor, candidateAppBinaries } from "./lib/runtime.mjs";

const RUN_DIR = path.join(os.homedir(), ".zcode", "stats-composer");
const CONFIG_FILE = path.join(RUN_DIR, "config.json");
const results = [];
const add = (name, ok, detail) => results.push({ name, ok, detail });

const wantJson = process.argv.includes("--json");

// 1. node version (node:sqlite needs >=22.5)
const [major, minor] = process.versions.node.split(".").map(Number);
const nodeOk = major > 22 || (major === 22 && minor >= 5);
// When ZCode runs us, the "node" here may be ZCode's own embedded Node, which
// is fine and is the whole point of the runtime helper: report which one it is.
const embedded = process.env.ELECTRON_RUN_AS_NODE === "1" || process.versions.electron != null;
add("node", nodeOk, `${process.versions.node}${embedded ? " (embedded in ZCode)" : ""} — node:sqlite needs >=22.5`);

// 1b. platform + app discovery. The launcher and the hooks need to find the
// ZCode binary on any OS; runtime.mjs does it from the environment, then from
// the conventional install locations. Report what it resolves here.
{
  const root = appRootFromEnv();
  const bin = appBinaryFor(root);
  const found = bin && fs.existsSync(bin)
    ? bin
    : candidateAppBinaries().find((c) => fs.existsSync(c)) || null;
  add("platform", true, `${process.platform}/${process.arch}${found ? ` · app at ${found}` : " · app binary not found (set ZCODE_APP_BINARY for the launcher)"}`);
}

// 2. usage db + schema
add("usage-db", m.dbExists(), m.DB_PATH);
if (m.dbExists()) {
  try {
    const db = m.openDb();
    const cols = db.prepare("SELECT name FROM pragma_table_info('model_usage')").all().map((c) => c.name);
    const need = [
      "session_id", "turn_id", "provider_id", "model_id", "status",
      "time_to_first_token_ms", "output_tokens", "reasoning_tokens",
      "started_at", "first_token_at", "completed_at", "query_source",
    ];
    const missing = need.filter((c) => !cols.includes(c));
    add("usage-schema", missing.length === 0, missing.length ? `missing: ${missing.join(",")}` : "model_usage columns ok");
    const rows = db.prepare("SELECT COUNT(*) c FROM model_usage").get();
    const withTtft = db.prepare("SELECT COUNT(*) c FROM model_usage WHERE time_to_first_token_ms IS NOT NULL").get();
    add("usage-data", rows.c > 0, `${rows.c} rows, ${withTtft.c} with TTFT`);
    try { db.close(); } catch {}
  } catch (e) {
    add("usage-schema", false, String(e?.message || e));
  }
} else {
  add("usage-schema", false, "db missing");
}

// 3. state file (session following)
let st = null;
try { st = JSON.parse(fs.readFileSync(m.stateFile(), "utf8")); } catch {}
add("state-file", !!st, st ? `${st.sessionId} @ ${new Date(st.ts).toISOString()} (${st.source})` : "missing — send a message in ZCode first");

// 4. sidecar
let port = null;
try { port = Number(fs.readFileSync(path.join(RUN_DIR, "port"), "utf8").trim()); } catch {}
let sidecar = false;
if (port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) });
    sidecar = r.ok;
  } catch {}
}
add("sidecar", !!port && sidecar, port && sidecar ? `http://127.0.0.1:${port} (dashboard /dashboard)` : port ? `stale port file :${port}` : "not running (started automatically when needed)");

// 4b. MCP server handshake. ZCode's stdio client reads NEWLINE-DELIMITED JSON
// (it splits on "\n" and parses each line, skipping SyntaxErrors), so a server
// that writes any other framing — LSP-style Content-Length, say — never
// completes `initialize` and the plugin's MCP row turns red with a 30 s
// timeout while the process itself is perfectly healthy. That failure is
// invisible to every other check here (the process starts, the tools work over
// stdin), so the doctor speaks to it the same way the app does: one JSON line
// in, and the reply must parse as a single line.
async function checkMcp() {
  const { spawn } = await import("node:child_process");
  const serverPath = path.join(import.meta.dirname, "..", "mcp", "stats-server.mjs");
  if (!fs.existsSync(serverPath)) return { ok: false, detail: "mcp/stats-server.mjs missing" };
  return await new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [serverPath], { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, ZCODE_PLUGIN_ROOT: path.join(import.meta.dirname, "..") } });
    } catch (e) {
      return resolve({ ok: false, detail: `spawn failed: ${e?.message || e}` });
    }
    let out = "";
    const done = (r) => { try { child.kill(); } catch {} resolve(r); };
    const timer = setTimeout(() => done({ ok: false, detail: "no reply to initialize within 5s — framing or startup problem" }), 5000);
    child.stdout.on("data", (c) => {
      out += c.toString();
      const nl = out.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(timer);
      const line = out.slice(0, nl).replace(/\r$/, "");
      // The app parses exactly this line. If it is a Content-Length header or
      // otherwise not standalone JSON, the handshake would fail there.
      if (/^\s*Content-Length:/i.test(line)) return done({ ok: false, detail: "replied with Content-Length framing — the app reads newline-delimited JSON and would time out" });
      try {
        const msg = JSON.parse(line);
        const name = msg?.result?.serverInfo?.name;
        done(name ? { ok: true, detail: `handshake ok — ${name} (newline-delimited JSON)` } : { ok: false, detail: `unexpected reply: ${line.slice(0, 80)}` });
      } catch {
        done({ ok: false, detail: `reply is not standalone JSON: ${line.slice(0, 80)}` });
      }
    });
    child.on("error", (e) => { clearTimeout(timer); done({ ok: false, detail: `spawn error: ${e?.message || e}` }); });
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "doctor", version: "0" } } }) + "\n");
    } catch (e) {
      clearTimeout(timer);
      done({ ok: false, detail: `write failed: ${e?.message || e}` });
    }
  });
}
{
  const r = await checkMcp();
  add("mcp", r.ok, r.detail);
}

// 5. CDP (composer pill availability). Electron's /json/version reports a
// bare Chromium identity ("Chrome/146..."), so Browser-header matching is
// wrong — recognize the app by its renderer page shape, same as the injector.
async function looksLikeZcodeApp(port) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(800) })).json();
    return (Array.isArray(list) ? list : []).some(
      (t) => t.type === "page" && /\/out\/renderer\/[^/]*\.html/.test(t.url || "")
    );
  } catch {
    return false;
  }
}
let cdpPort = null;
let cdpApp = false;
let cdpNote = "not available";
for (const port of [9229, 9222, 9230]) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) });
    if (r.ok) {
      const v = await r.json();
      cdpPort = port;
      cdpApp = await looksLikeZcodeApp(port);
      cdpNote = cdpApp ? `open on :${port} (ZCode app renderer detected)` : `open on :${port} but no ZCode renderer page — likely another browser`;
      break;
    }
  } catch {}
}
add("cdp", cdpApp, cdpApp ? cdpNote : cdpPort ? `${cdpNote}; pill needs the ZCode app started with --remote-debugging-port=9229` : `${cdpNote} — composer pill needs the app started once with --remote-debugging-port=9229; fallback channel stays active`);

// 5b. composer pill attach state (written by the injector on every sweep)
let pill = false;
let pillNote = "never attached";
try {
  const st = JSON.parse(fs.readFileSync(path.join(RUN_DIR, "pill.json"), "utf8"));
  const fresh = Number.isFinite(st.ts) && Date.now() - st.ts <= 90_000;
  pill = !!(st.attached && fresh);
  pillNote = st.attached
    ? fresh
      ? `attached to app on :${st.port}`
      : `stale (last attach ${Math.round((Date.now() - st.ts) / 1000)}s ago — injector not sweeping?)`
    : `detached (${st.reason || "unknown"})`;
} catch {}
add("pill", pill, pillNote);

// 6. config sanity
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch {}
const cfgIssues = [];
if (cfg.mode && !["auto", "skill", "sidecar"].includes(cfg.mode)) cfgIssues.push(`unknown mode ${cfg.mode}`);
if (cfg.position && !["left", "right"].includes(cfg.position)) cfgIssues.push(`unknown position ${cfg.position}`);
if (cfg.window && (Number(cfg.window) < 1 || Number(cfg.window) > 100)) cfgIssues.push("window must be 1..100");
add("config", cfgIssues.length === 0, Object.keys(cfg).length ? JSON.stringify(cfg) : "defaults (no config file)");

const OPTIONAL = ["sidecar", "cdp", "pill", "platform"];
const failed = results.filter((r) => !r.ok);
const degraded = results.filter((r) => !r.ok && OPTIONAL.includes(r.name));

if (wantJson) {
  console.log(JSON.stringify({ ok: failed.length === 0, results }, null, 2));
} else {
  console.log("stats-composer doctor");
  console.log("=".repeat(50));
  for (const r of results) {
    console.log(`${r.ok ? "✓" : "✗"} ${r.name.padEnd(12)} ${r.detail}`);
  }
  console.log("=".repeat(50));
  const required = failed.filter((r) => !OPTIONAL.includes(r.name));
  if (required.length) {
    console.log(`BROKEN: ${required.map((r) => r.name).join(", ")}`);
    process.exitCode = 2;
  } else if (degraded.length) {
    console.log(`DEGRADED (optional channels): ${degraded.map((r) => r.name).join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log("HEALTHY");
  }
}