// Hooks are the plugin's entry point into the app, and their contract is
// strict: ZCode parses stdout as JSON, so ONE stray byte (a Node warning, a
// half-flushed write) breaks the hook. These tests run the real hook scripts
// with a real stdin payload and a sandboxed HOME, and assert the exact protocol
// — including the two failure modes the source comments call out (a warning on
// stderr, and a truncated write).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { STATS, USAGE } from "../lib/paths.mjs";
import { closedPort } from "../lib/mock-sidecar.mjs";

// Run a hook the way the app does: argv mode, JSON on stdin, read stdout.
function runHook(script, { env = {}, stdin = "", timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c.toString()));
    child.stderr.on("data", (c) => (err += c.toString()));
    const t = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(t);
      resolve({ code, stdout: out, stderr: err });
    });
    child.stdin.end(stdin);
  });
}

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zstats-hook-"));
  fs.mkdirSync(path.join(dir, ".zcode", "stats-composer"), { recursive: true });
  return dir;
}

function writeConfig(home, cfg) {
  fs.writeFileSync(path.join(home, ".zcode", "stats-composer", "config.json"), JSON.stringify(cfg));
}

function baseEnv(home) {
  return {
    HOME: home,
    USERPROFILE: home,
    TPS_MONITOR_STATE_FILE: path.join(home, "tps-monitor.last-session.json"),
    // No DB is needed by these hooks; point it somewhere empty so nothing can
    // accidentally read the developer's real usage DB.
    ZCODE_USAGE_DB: path.join(home, "absent.sqlite"),
    NODE_NO_WARNINGS: "",
  };
}

// Reap the injector the usage-context hook starts, and return its pid (0 when
// the hook started none). Running that hook with a REACHABLE sidecar makes it
// spawn a real, detached injector — that IS the behaviour under test — and
// `detached` means the process outlives the hook and the test. Unreaped, it
// sweeps the developer's live app every 10 s forever: five runs of this file
// left ten orphaned injectors here, and because a generation is identified
// partly by its sidecar port, they traded the page with the real injector and
// blanked the user's chips on every trade. The injector records its own pid in
// the lock it writes under the HOME it was given, which is this sandbox.
async function reapInjector(home) {
  const lock = path.join(home, ".zcode", "usage-context", "injector.lock");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    let pid = 0;
    try { pid = JSON.parse(fs.readFileSync(lock, "utf8")).pid || 0; } catch {}
    if (pid) {
      try { process.kill(pid, "SIGKILL"); } catch {}
      try { fs.rmSync(lock, { force: true }); } catch {}
      return pid;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return 0;
}

test("both plugins' SessionStart hooks also run on resume and compact", () => {
  // A restored chat reports SessionStart source "resume"; /compact reports
  // "compact". A matcher of "startup|clear" therefore skips both, which is how
  // the sidecar and injectors failed to start after reopening the app.
  for (const [dir, name] of [[STATS, "stats-composer"], [USAGE, "usage-context"]]) {
    const m = JSON.parse(fs.readFileSync(path.join(dir, "hooks", "hooks.json"), "utf8"));
    const groups = m.hooks.SessionStart;
    assert.ok(Array.isArray(groups) && groups.length, `${name}: no SessionStart hook`);
    const matcher = groups.map((g) => g.matcher).find(Boolean);
    assert.ok(matcher, `${name}: SessionStart needs a matcher`);
    const re = new RegExp(matcher);
    for (const source of ["startup", "resume", "clear", "compact"]) {
      assert.ok(re.test(source), `${name}: matcher "${matcher}" misses ${source}`);
    }
  }
});

test("stats session-start emits valid JSON and records the session", async () => {
  const home = sandbox();
  writeConfig(home, { mode: "skill" }); // skill mode: no sidecar spawn
  const r = await runHook(path.join(STATS, "hooks", "session-start.mjs"), {
    env: baseEnv(home),
    stdin: JSON.stringify({ session_id: "sess_hook_1", hook_event_name: "SessionStart" }),
  });
  assert.equal(r.code, 0);
  // stdout must be exactly one JSON object — the app parses the whole stream.
  const msg = JSON.parse(r.stdout);
  assert.equal(msg.hookSpecificOutput.hookEventName, "SessionStart");
  assert.equal(typeof msg.hookSpecificOutput.additionalContext, "string");
  // stderr must be empty: Node's experimental-sqlite warning would land here
  // and, while the app ignores stderr for JSON parsing, a warning is a sign the
  // module imports something it should not.
  assert.equal(r.stderr.trim(), "", "hook wrote to stderr: " + r.stderr);
  // The state file is what every passive reader follows.
  const st = JSON.parse(fs.readFileSync(path.join(home, "tps-monitor.last-session.json"), "utf8"));
  assert.equal(st.sessionId, "sess_hook_1");
  assert.equal(st.source, "session-start");
  assert.ok(Number.isFinite(st.ts));
});

test("stats prompt-submit emits a JSON envelope with the stats instruction in skill mode", async () => {
  const home = sandbox();
  writeConfig(home, { mode: "skill" });
  const r = await runHook(path.join(STATS, "hooks", "prompt-submit.mjs"), {
    env: baseEnv(home),
    stdin: JSON.stringify({ session_id: "sess_hook_2", hook_event_name: "UserPromptSubmit" }),
  });
  assert.equal(r.code, 0);
  assert.equal(r.stderr.trim(), "");
  const msg = JSON.parse(r.stdout);
  assert.equal(msg.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  const ctx = msg.hookSpecificOutput.additionalContext;
  // The fallback channel is a precise instruction; assert it is present and
  // names the real CLI, rather than matching the whole paragraph.
  assert.match(ctx, /stats\.mjs/);
  assert.match(ctx, /--turn --current/);
  // The state file is refreshed on every prompt so the session follows the user.
  const st = JSON.parse(fs.readFileSync(path.join(home, "tps-monitor.last-session.json"), "utf8"));
  assert.equal(st.sessionId, "sess_hook_2");
  assert.equal(st.source, "prompt-submit");
});

test("stats prompt-submit keeps model context clean when a sidecar is alive but no pill is attached", async () => {
  // mode auto + a reachable sidecar + no pill.json => the sidecar serves the
  // dashboard, so the per-message line stays. This is the branch that decides
  // whether the model sees the instruction at all; getting it backwards either
  // spams the model or hides the stats.
  const home = sandbox();
  writeConfig(home, { mode: "auto" });
  // A minimal /health responder standing in for the sidecar.
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    res.writeHead(req.url === "/health" ? 200 : 404, { "Content-Type": "application/json" });
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  fs.writeFileSync(path.join(home, ".zcode", "stats-composer", "port"), String(port));
  const r = await runHook(path.join(STATS, "hooks", "prompt-submit.mjs"), {
    env: baseEnv(home),
    stdin: JSON.stringify({ session_id: "sess_hook_3" }),
  });
  await new Promise((r2) => server.close(r2));
  const msg = JSON.parse(r.stdout);
  assert.match(msg.hookSpecificOutput.additionalContext, /stats\.mjs/,
    "with no pill attached the per-message line must remain the visible channel");
});

test("stats prompt-submit is silent when a fresh pill attach is recorded", async () => {
  // pill.json fresh + attached => the pill IS the visible channel, so the hook
  // must contribute nothing to the model's context ("zero-context-pollution").
  const home = sandbox();
  writeConfig(home, { mode: "auto" });
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}"); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const runDir = path.join(home, ".zcode", "stats-composer");
  fs.writeFileSync(path.join(runDir, "port"), String(port));
  fs.writeFileSync(path.join(runDir, "pill.json"), JSON.stringify({ attached: true, ts: Date.now(), port: 9229 }));
  const r = await runHook(path.join(STATS, "hooks", "prompt-submit.mjs"), {
    env: baseEnv(home),
    stdin: JSON.stringify({ session_id: "sess_hook_4" }),
  });
  await new Promise((r2) => server.close(r2));
  const msg = JSON.parse(r.stdout);
  assert.equal(msg.hookSpecificOutput.additionalContext, "");
});

test("stats prompt-submit honours attachStatsLine:false", async () => {
  const home = sandbox();
  writeConfig(home, { mode: "skill", attachStatsLine: false });
  const r = await runHook(path.join(STATS, "hooks", "prompt-submit.mjs"), {
    env: baseEnv(home),
    stdin: JSON.stringify({ session_id: "sess_hook_5" }),
  });
  const msg = JSON.parse(r.stdout);
  assert.equal(msg.hookSpecificOutput.additionalContext, "");
});

test("usage-context session-start says so (in the envelope) when the sidecar is absent", async () => {
  // Without stats-composer there is nothing to show; the hook must not start a
  // doomed injector and must explain itself through additionalContext.
  //
  // The port must be pointed at somewhere NOTHING listens: the plugin's default
  // is 7427, and a developer running the real sidecar would make this hook
  // (correctly) find it alive. Isolation is the test's job, not the hook's.
  const home = sandbox();
  writeConfig(home, { sidecarPort: await closedPort() });
  const r = await runHook(path.join(USAGE, "hooks", "session-start.mjs"), {
    env: baseEnv(home),
    stdin: JSON.stringify({ session_id: "sess_hook_6" }),
  });
  assert.equal(r.code, 0);
  assert.equal(r.stderr.trim(), "");
  const msg = JSON.parse(r.stdout);
  assert.equal(msg.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(msg.hookSpecificOutput.additionalContext, /sidecar is not reachable/);
  // It still recorded the session, so a later run can correlate.
  const st = JSON.parse(fs.readFileSync(path.join(home, ".zcode", "usage-context", "last-session.json"), "utf8"));
  assert.equal(st.sessionId, "sess_hook_6");
});

test("usage-context session-start reports success (empty context) when the sidecar answers", async () => {
  const home = sandbox();
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}"); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  writeConfig(home, { sidecarPort: port });
  const r = await runHook(path.join(USAGE, "hooks", "session-start.mjs"), {
    env: baseEnv(home),
    stdin: JSON.stringify({ session_id: "sess_hook_6b" }),
  });
  assert.equal(r.code, 0);
  const msg = JSON.parse(r.stdout);
  assert.equal(msg.hookSpecificOutput.additionalContext, "");
  // A reachable sidecar is what makes the hook start this plugin's injector —
  // the point of the success branch — so nothing may be asserted about it
  // without reaping the process that assertion implies. The server stays up
  // until the reaper has it, so the injector cannot stand itself down first.
  const pid = await reapInjector(home);
  await new Promise((r2) => server.close(r2));
  assert.ok(pid > 0, "a reachable sidecar must make the hook start an injector");
});

test("usage-context session-start waits for a sidecar that starts just after the hook", async () => {
  // stats-composer starts the sidecar without waiting, so on startup/resume the
  // two hooks race. This hook used to probe once and give up for the session.
  const home = sandbox();
  const { createServer } = await import("node:http");
  // Reserve a free port, then release it so the delayed server can take it.
  const probeServer = createServer();
  await new Promise((r) => probeServer.listen(0, "127.0.0.1", r));
  const port = probeServer.address().port;
  await new Promise((r) => probeServer.close(r));
  writeConfig(home, { sidecarPort: port });

  let server;
  let serverError;
  let r;
  let pid;
  const delayed = setTimeout(() => {
    server = createServer((req, res) => {
      res.writeHead(req.url === "/health" ? 200 : 404, { "Content-Type": "application/json" });
      res.end("{}");
    });
    // Record a listen failure instead of swallowing it: a port collision must
    // fail the assertion below, not masquerade as "sidecar absent".
    server.on("error", (e) => { serverError = e; });
    server.listen(port, "127.0.0.1");
  }, 600);

  try {
    r = await runHook(path.join(USAGE, "hooks", "session-start.mjs"), {
      env: baseEnv(home),
      stdin: JSON.stringify({ session_id: "sess_hook_wait" }),
    });
    // The reachable sidecar makes the hook spawn a real injector; reap it before
    // closing the server so it cannot attach to anything else.
    pid = await reapInjector(home);
  } finally {
    clearTimeout(delayed);
    if (server) await new Promise((r2) => server.close(r2));
  }
  assert.equal(serverError, undefined, "the delayed sidecar failed to start");
  assert.equal(r.code, 0);
  const msg = JSON.parse(r.stdout);
  assert.equal(msg.hookSpecificOutput.additionalContext, "",
    "the hook must wait for the sidecar instead of reporting it absent");
  assert.ok(pid > 0, "once the sidecar answers, the injector must be started");
});

test("both session-start hooks survive malformed stdin", async () => {
  // The app always sends JSON, but a hook that throws on anything else would
  // fail the whole session start. Assert graceful degradation, exact JSON out.
  //
  // The sidecar port is pinned to a CLOSED one: the usage-context hook's default
  // is 7427, and on a developer machine that is where the real sidecar lives — so
  // without this the hook would answer "reachable" and start an injector against
  // whatever the developer happens to be running. A test must not depend on, or
  // disturb, the machine it runs on.
  const home = sandbox();
  writeConfig(home, { mode: "skill", sidecarPort: await closedPort() });
  for (const script of [
    path.join(STATS, "hooks", "session-start.mjs"),
    path.join(USAGE, "hooks", "session-start.mjs"),
  ]) {
    const r = await runHook(script, { env: baseEnv(home), stdin: "not json at all" });
    assert.equal(r.code, 0, `${script} exited ${r.code}`);
    const msg = JSON.parse(r.stdout); // must still be valid JSON
    assert.ok(msg.hookSpecificOutput);
  }
});

test("hooks fall back to ZCODE_SESSION_ID when the payload omits one", async () => {
  const home = sandbox();
  writeConfig(home, { mode: "skill" });
  const r = await runHook(path.join(STATS, "hooks", "session-start.mjs"), {
    env: { ...baseEnv(home), ZCODE_SESSION_ID: "sess_from_env" },
    stdin: "{}",
  });
  assert.equal(r.code, 0);
  const st = JSON.parse(fs.readFileSync(path.join(home, "tps-monitor.last-session.json"), "utf8"));
  assert.equal(st.sessionId, "sess_from_env");
});

test("hooks emit valid JSON when their stdout is read slowly (drain, not truncate)", async () => {
  // writeAndExit waits for the write to drain before exit(0). Read slowly so the
  // write cannot complete in one go: a bare process.exit(0) would truncate the
  // JSON and the app would reject the hook.
  const home = sandbox();
  writeConfig(home, { mode: "skill" });
  const script = path.join(STATS, "hooks", "prompt-submit.mjs");
  const child = spawn(process.execPath, [script], {
    env: { ...baseEnv(home) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (c) => (out += c.toString()));
  // Attach the exit listener BEFORE anything else can finish, so a fast child
  // cannot slip past it (the earlier version awaited close() after a sleep,
  // which hung forever when the child had already exited).
  const closed = new Promise((r) => child.on("close", r));
  child.stdout.pause();
  setTimeout(() => child.stdout.resume(), 300);
  child.stdin.end(JSON.stringify({ session_id: "sess_slow_read" }));
  const code = await Promise.race([
    closed,
    new Promise((r) => setTimeout(() => r("timeout"), 8000)),
  ]);
  assert.notEqual(code, "timeout", "hook did not exit");
  assert.doesNotThrow(() => JSON.parse(out), "stdout was truncated: " + JSON.stringify(out.slice(0, 80)));
  const msg = JSON.parse(out);
  assert.equal(msg.hookSpecificOutput.hookEventName, "UserPromptSubmit");
});
