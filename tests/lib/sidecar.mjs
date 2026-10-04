// Launch the REAL sidecar against a fixture DB and talk to it over HTTP.
//
// The sidecar is the plugin's data plane: the pill, the dashboard and the
// usage-context chips all read it. So its endpoint contract is tested against
// the real process, not a stub — only the UI tests use the mock, and only
// because they are about pixels rather than plumbing.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { STATS_SIDECAR } from "./paths.mjs";

// A free port, obtained by binding and releasing. Good enough for a test run;
// the sidecar also detects EADDRINUSE and exits, so a collision fails loudly.
export async function freePort() {
  const { createServer } = await import("node:net");
  return await new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

// Every child this module starts is tracked, so a test that fails before its own
// stop() cannot leak a process and keep the test runner's event loop alive — the
// failure that made an earlier run hang for the whole timeout.
const LIVE = new Set();
if (!globalThis.__zstatsSidecarCleanup) {
  globalThis.__zstatsSidecarCleanup = true;
  process.on("exit", () => { for (const c of LIVE) { try { c.kill("SIGKILL"); } catch {} } });
}
export function killAllSidecars() {
  for (const c of LIVE) { try { c.kill("SIGKILL"); } catch {} }
  LIVE.clear();
}

// Start the sidecar. `config` is written to <home>/.zcode/stats-composer/
// config.json first, which is exactly how the plugin learns its settings.
export async function startSidecar(machine, { config = { mode: "skill" }, port, env = {}, expectHealthy = false } = {}) {
  const runDir = path.join(machine.dir, ".zcode", "stats-composer");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "config.json"), JSON.stringify(config));
  const p = port || (await freePort());
  const child = spawn(process.execPath, [STATS_SIDECAR], {
    env: {
      ...process.env,
      HOME: machine.dir,
      USERPROFILE: machine.dir,
      ZCODE_USAGE_DB: machine.dbPath,
      STATS_SIDECAR_PORT: String(p),
      // A port collision is detected by the server itself; this only tells it
      // the run is single-instance so it stands down cleanly.
      STATS_SIDECAR_NO_SINGLETON: "1",
      NODE_NO_WARNINGS: "1",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  LIVE.add(child);
  let out = "";
  child.stdout.on("data", (c) => (out += c.toString()));
  child.stderr.on("data", (c) => (out += c.toString()));
  const base = `http://127.0.0.1:${p}`;
  // When the port may already be held (the duplicate-launch test), a healthy
  // /health reply proves nothing about THIS child: it could be the other
  // server answering. Wait for this child to actually own the port by checking
  // it is still alive AND answering; otherwise treat an early exit as the
  // expected stand-down.
  const deadline = Date.now() + 10_000;
  let healthy = false;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      if (expectHealthy) throw new Error(`sidecar exited early (${child.exitCode}): ${out}`);
      return { port: p, base, child, exitedEarly: true, log: () => out, async stop() { LIVE.delete(child); } };
    }
    try {
      const r = await fetch(base + "/health", { signal: AbortSignal.timeout(500) });
      if (r.ok) { healthy = true; break; }
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!healthy && expectHealthy) throw new Error(`sidecar never became healthy: ${out}`);
  const get = async (p2, opts) => {
    const r = await fetch(base + p2, { signal: AbortSignal.timeout(8000), ...opts });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, headers: r.headers, text, json };
  };
  return {
    port: p,
    base,
    child,
    exitedEarly: false,
    log: () => out,
    get,
    async stop() {
      LIVE.delete(child);
      try { child.kill("SIGKILL"); } catch {}
      await new Promise((r) => setTimeout(r, 60));
    },
  };
}

// Poll /stats until a predicate holds. The snapshot is produced by a background
// refresher on its own interval, so the first request after start may briefly
// precede the first completed scan; this removes that race without a sleep.
export async function waitFor(sidecar, fn, { timeout = 8000, label = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await sidecar.get("/stats?full=1");
    if (fn(last.json)) return last.json;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error(`timed out waiting for ${label}; last=${JSON.stringify(last?.json)?.slice(0, 300)}`);
}
