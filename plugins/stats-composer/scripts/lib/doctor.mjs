// The doctor's checks, separated from the CLI that prints them.
//
// Every check is read-only and returns one or more { name, ok, detail } rows;
// the entrypoint decides the exit code from those rows, so the health policy
// lives in one readable place.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as m from "./metrics.mjs";
import { spawnNodePiped } from "./runtime.mjs";
import { appRootFromEnv, appBinaryFor, candidateAppBinaries } from "./launcher.mjs";

const PLUGIN_ROOT = path.resolve(import.meta.dirname, "..", "..");
const RUN_DIR = path.join(os.homedir(), ".zcode", "stats-composer");
const CONFIG_FILE = path.join(RUN_DIR, "config.json");

function nodeCheck() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const ok = major > 22 || (major === 22 && minor >= 5);
  // When ZCode runs us, "node" may be its embedded Node; that is expected.
  const embedded = process.env.ELECTRON_RUN_AS_NODE === "1" || process.versions.electron != null;
  return {
    name: "node",
    ok,
    detail: `${process.versions.node}${embedded ? " (embedded in ZCode)" : ""} — node:sqlite needs >=22.5`,
  };
}

function platformCheck() {
  const root = appRootFromEnv();
  const bin = appBinaryFor(root);
  const found = bin && fs.existsSync(bin)
    ? bin
    : candidateAppBinaries().find((c) => fs.existsSync(c)) || null;
  return {
    name: "platform",
    ok: true,
    detail: `${process.platform}/${process.arch}${found ? ` · app at ${found}` : " · app binary not found (set ZCODE_APP_BINARY for the launcher)"}`,
  };
}

function usageDbChecks() {
  if (!m.dbExists()) {
    return [
      { name: "usage-db", ok: false, detail: m.DB_PATH },
      { name: "usage-schema", ok: false, detail: "db missing" },
    ];
  }
  const rows = [{ name: "usage-db", ok: true, detail: m.DB_PATH }];
  try {
    const db = m.openDb();
    const cols = db.prepare("SELECT name FROM pragma_table_info('model_usage')").all().map((c) => c.name);
    const need = [
      "session_id", "turn_id", "provider_id", "model_id", "status",
      "time_to_first_token_ms", "output_tokens", "reasoning_tokens",
      "started_at", "first_token_at", "completed_at", "query_source",
    ];
    const missing = need.filter((c) => !cols.includes(c));
    rows.push({ name: "usage-schema", ok: missing.length === 0, detail: missing.length ? `missing: ${missing.join(",")}` : "model_usage columns ok" });
    const count = db.prepare("SELECT COUNT(*) c FROM model_usage").get();
    const withTtft = db.prepare("SELECT COUNT(*) c FROM model_usage WHERE time_to_first_token_ms IS NOT NULL").get();
    rows.push({ name: "usage-data", ok: count.c > 0, detail: `${count.c} rows, ${withTtft.c} with TTFT` });
    try { db.close(); } catch { /* read-only handle: close is cleanup */ }
  } catch (e) {
    rows.push({ name: "usage-schema", ok: false, detail: String(e?.message || e) });
  }
  return rows;
}

function stateCheck() {
  let st = null;
  try { st = JSON.parse(fs.readFileSync(m.stateFile(), "utf8")); } catch { /* absent or malformed: report it */ }
  return {
    name: "state-file",
    ok: !!st,
    detail: st ? `${st.sessionId} @ ${new Date(st.ts).toISOString()} (${st.source})` : "missing — send a message in ZCode first",
  };
}

async function sidecarCheck() {
  let port = null;
  try { port = Number(fs.readFileSync(path.join(RUN_DIR, "port"), "utf8").trim()); } catch { /* no port file: not running */ }
  let sidecar = false;
  if (port) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) });
      sidecar = r.ok;
    } catch { /* an absent sidecar is an optional-channel failure */ }
  }
  return {
    name: "sidecar",
    ok: !!port && sidecar,
    detail: port && sidecar
      ? `http://127.0.0.1:${port} (dashboard /dashboard)`
      : port ? `stale port file :${port}` : "not running (started automatically when needed)",
  };
}

// ZCode's stdio client reads newline-delimited JSON, so the probe speaks the
// same framing the app does: one JSON line in, one parseable line out.
async function mcpCheck() {
  const serverPath = path.join(PLUGIN_ROOT, "mcp", "stats-server.mjs");
  if (!fs.existsSync(serverPath)) return { name: "mcp", ok: false, detail: "mcp/stats-server.mjs missing" };
  const result = await new Promise((resolve) => {
    const child = spawnNodePiped(serverPath, [], { ZCODE_PLUGIN_ROOT: PLUGIN_ROOT });
    if (!child) return resolve({ ok: false, detail: "could not start the MCP server process" });
    let out = "";
    const done = (r) => { try { child.kill(); } catch { /* cleanup */ } resolve(r); };
    const timer = setTimeout(() => done({ ok: false, detail: "no reply to initialize within 5s — framing or startup problem" }), 5000);
    child.stdout.on("data", (c) => {
      out += c.toString();
      const nl = out.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(timer);
      const line = out.slice(0, nl).replace(/\r$/, "");
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
  return { name: "mcp", ...result };
}

// Electron's /json/version reports a bare Chromium identity, so recognize the
// app by its renderer page shape, same as the injector.
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

async function cdpCheck() {
  let cdpPort = null;
  let cdpApp = false;
  let cdpNote = "not available";
  for (const port of [9229, 9222, 9230]) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) });
      if (!r.ok) continue;
      await r.json();
      cdpPort = port;
      cdpApp = await looksLikeZcodeApp(port);
      cdpNote = cdpApp ? `open on :${port} (ZCode app renderer detected)` : `open on :${port} but no ZCode renderer page — likely another browser`;
      break;
    } catch { /* try the next conventional port */ }
  }
  return {
    name: "cdp",
    ok: cdpApp,
    detail: cdpApp
      ? cdpNote
      : cdpPort
        ? `${cdpNote}; pill needs the ZCode app started with --remote-debugging-port=9229`
        : `${cdpNote} — composer pill needs the app started once with --remote-debugging-port=9229; fallback channel stays active`,
  };
}

function pillCheck() {
  let pill = false;
  let note = "never attached";
  try {
    const st = JSON.parse(fs.readFileSync(path.join(RUN_DIR, "pill.json"), "utf8"));
    const fresh = Number.isFinite(st.ts) && Date.now() - st.ts <= 90_000;
    pill = !!(st.attached && fresh);
    note = st.attached
      ? fresh
        ? `attached to app on :${st.port}`
        : `stale (last attach ${Math.round((Date.now() - st.ts) / 1000)}s ago — injector not sweeping?)`
      : `detached (${st.reason || "unknown"})`;
  } catch { /* an absent attach file means never attached */ }
  return { name: "pill", ok: pill, detail: note };
}

function configCheck() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch { /* no config: defaults */ }
  const issues = [];
  if (cfg.mode && !["auto", "skill", "sidecar"].includes(cfg.mode)) issues.push(`unknown mode ${cfg.mode}`);
  if (cfg.position && !["left", "right"].includes(cfg.position)) issues.push(`unknown position ${cfg.position}`);
  if (cfg.window && (Number(cfg.window) < 1 || Number(cfg.window) > 100)) issues.push("window must be 1..100");
  return {
    name: "config",
    ok: issues.length === 0,
    detail: Object.keys(cfg).length ? JSON.stringify(cfg) : "defaults (no config file)",
  };
}

export async function runDoctor() {
  return [
    nodeCheck(),
    platformCheck(),
    ...usageDbChecks(),
    stateCheck(),
    await sidecarCheck(),
    await mcpCheck(),
    await cdpCheck(),
    pillCheck(),
    configCheck(),
  ];
}
