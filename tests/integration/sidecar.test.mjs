// The sidecar's HTTP contract, exercised against the REAL process.
//
// This is the data plane every surface reads: the pill, the dashboard and the
// usage-context chips. Tests here are about the endpoint's behaviour — the
// paging that makes the table unbounded, the sort that happens server-side, the
// CORS gate, the method gate — so they assert on a live server with a fixture
// DB rather than on a mock.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeMachine, createDb, addSession, addRequest, addRunningRequest, addTurn, addTool, cleanup } from "../lib/fixtures.mjs";
import { startSidecar, waitFor, killAllSidecars } from "../lib/sidecar.mjs";

const SID = "sess_sidecar_1";
let machine;
let sidecar;

before(async () => {
  machine = makeMachine("sidecar");
  const db = createDb(machine);
  addSession(db, SID, "Sidecar fixture");
  // 25 requests so paging has several real pages, with distinct rates so a sort
  // is observable.
  for (let i = 0; i < 25; i++) {
    addRequest(db, {
      sessionId: SID, id: `s_req_${String(i).padStart(2, "0")}`,
      modelId: i % 2 === 0 ? "model-a" : "model-b",
      genMs: 1000, ttftMs: 100 + i, outputTokens: 100 + i * 10, reasoningTokens: 0,
      inputTokens: 1000, cacheRead: 0,
      startedAt: 2_000_000 + i * 10_000,
      completedAt: 2_000_000 + i * 10_000 + 100 + i + 1000,
    });
  }
  // A turn with accounting, for /turn.
  addTurn(db, { sessionId: SID, turnId: "turn_a", userMessageId: "msg_a",
    inputTokens: 50_000, cacheRead: 30_000, outputTokens: 5_000, reasoningTokens: 500,
    totalTokens: 25_500, durationMs: 10_000, steps: 4, toolCalls: 2 });
  addTool(db, { sessionId: SID, turnId: "turn_a", durationMs: 2_000 });
  addRunningRequest(db, { sessionId: SID, id: "s_live", turnId: "turn_live", startedAt: Date.now() - 900 });
  db.close();
  // The hook-recorded session is how the sidecar resolves a default session.
  // metrics.stateFile() defaults to <HOME>/.zcode/tps-monitor.last-session.json,
  // and startSidecar sets HOME to the fixture dir — so that is where it goes.
  const stateDir = path.join(machine.dir, ".zcode");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "tps-monitor.last-session.json"),
    JSON.stringify({ sessionId: SID, ts: Date.now(), source: "test" }));
  sidecar = await startSidecar(machine, { config: { mode: "skill", window: 10 } });
  // Wait for the first snapshot to be complete (the refresher runs in the
  // background; the first request may precede it).
  await waitFor(sidecar, (j) => j && j.sessionId === SID && j.session && j.session.samples > 0, { label: "first snapshot" });
});

after(async () => {
  await sidecar?.stop();
  killAllSidecars();
  cleanup({ ...machine, db: null });
});

test("/health reports liveness and the plugin identity", async () => {
  const r = await sidecar.get("/health");
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.plugin, "stats-composer");
  assert.match(r.json.version, /^\d+\.\d+\.\d+$/);
  assert.ok(r.json.uptime >= 0);
  // The counters the doctor reads to answer "is this plugin heavy?".
  for (const k of ["refreshes", "skips", "refreshMsLast", "refreshMsAvg", "rssKb", "demandAge"]) {
    assert.equal(typeof r.json[k], "number", `health is missing ${k}`);
  }
});

test("/stats returns the pill's snapshot without the dashboard table", async () => {
  const r = await sidecar.get("/stats");
  assert.equal(r.status, 200);
  const s = r.json;
  assert.equal(s.sessionId, SID);
  assert.ok(s.last, "last request expected");
  assert.ok(s.window && typeof s.window.avgTps === "number");
  assert.ok(s.session && s.session.tokens, "the token panel must be present");
  assert.ok(Array.isArray(s.session.models), "per-model mix must be present");
  assert.ok(s.turns, "turn totals must be present");
  assert.equal(s.plugin.version, (await sidecar.get("/health")).json.version);
  // The pill never needs the table, and shipping it would make every 1 s poll
  // carry the session's whole history.
  assert.equal(s.recent, undefined);
  assert.equal(s.lastTurn, undefined);
});

test("/stats.json is an alias", async () => {
  const a = await sidecar.get("/stats");
  const b = await sidecar.get("/stats.json");
  assert.equal(b.status, 200);
  assert.equal(b.json.sessionId, a.json.sessionId);
});

test("/stats?full=1 adds the dashboard extras", async () => {
  const r = await sidecar.get("/stats?full=1");
  assert.equal(r.status, 200);
  assert.ok(r.json.session, "full snapshot still carries the session block");
  assert.ok(r.json.session.models.length >= 1);
});

test("?session= re-scopes the snapshot and is validated", async () => {
  const ok = await sidecar.get(`/stats?session=${SID}`);
  assert.equal(ok.json.sessionId, SID);
  // A malformed id must be ignored (not accepted as a session), falling back to
  // the recorded one rather than erroring.
  const bad = await sidecar.get("/stats?session=../etc/passwd");
  assert.equal(bad.status, 200);
  assert.equal(bad.json.sessionId, SID);
});

test("/requests pages the table server-side", async () => {
  const r = await sidecar.get("/requests?offset=0&limit=10");
  assert.equal(r.status, 200);
  assert.equal(r.json.total, 25, "total must be the whole session, not the page");
  assert.equal(r.json.rows.length, 10);
  assert.equal(r.json.limit, 10);
  assert.equal(r.json.offset, 0);
  // Rows carry the presentation fields the client needs.
  for (const row of r.json.rows) {
    for (const k of ["id", "time", "model", "tokPerSec", "ttftMs", "out", "cacheRead", "status"]) {
      assert.ok(k in row, `row missing ${k}`);
    }
  }
});

test("/requests reaches the LAST page (unbounded table, not a 500-row window)", async () => {
  // The defect this guards: the table used to be capped at 500 rows, so a long
  // session showed "page 1 of 50 · 500 requests" and the rest was unreachable.
  const last = await sidecar.get("/requests?offset=20&limit=10");
  assert.equal(last.json.rows.length, 5);
  assert.equal(last.json.total, 25);
  const ids = new Set();
  for (let off = 0; off < 25; off += 10) {
    const p = await sidecar.get(`/requests?offset=${off}&limit=10`);
    for (const row of p.json.rows) ids.add(row.id);
  }
  assert.equal(ids.size, 25, "paging must cover every request exactly once");
});

test("/requests offset past the end clamps instead of returning nothing", async () => {
  const r = await sidecar.get("/requests?offset=9999&limit=10");
  assert.equal(r.status, 200);
  assert.ok(r.json.rows.length > 0, "an out-of-range offset should clamp to the last page");
  assert.ok(r.json.offset < 25);
});

test("/requests limit is clamped to a sane maximum", async () => {
  const r = await sidecar.get("/requests?offset=0&limit=100000");
  assert.equal(r.json.limit, 500, "limit must be clamped so one request cannot pull the world");
});

test("/requests sorts by the requested key and direction", async () => {
  const asc = await sidecar.get("/requests?offset=0&limit=25&sort=tokPerSec&dir=asc");
  const desc = await sidecar.get("/requests?offset=0&limit=25&sort=tokPerSec&dir=desc");
  const a = asc.json.rows.map((r) => r.tokPerSec);
  const d = desc.json.rows.map((r) => r.tokPerSec);
  assert.deepEqual(a, [...a].sort((x, y) => x - y), "ascending sort is wrong");
  assert.deepEqual(d, [...d].sort((x, y) => y - x), "descending sort is wrong");
  assert.equal(a[0], d[d.length - 1]);
  assert.equal(asc.json.sortKey, "tokPerSec");
  assert.equal(asc.json.sortDesc, false);
});

test("/requests falls back to a known sort key for an unknown one", async () => {
  const r = await sidecar.get("/requests?sort=;DROP TABLE model_usage;--");
  assert.equal(r.status, 200);
  assert.equal(r.json.sortKey, "completedAt");
});

test("the `out` column is output + reasoning tokens", async () => {
  const r = await sidecar.get("/requests?offset=0&limit=25&sort=out&dir=asc");
  const smallest = r.json.rows[0];
  // The first fixture request has output 100 + reasoning 0.
  assert.equal(smallest.out, 100);
});

test("/metrics serves Prometheus text, not JSON", async () => {
  const r = await sidecar.get("/metrics");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/plain/);
  assert.match(r.text, /# HELP zcode_tps_last/);
  assert.match(r.text, /# TYPE zcode_tps_last gauge/);
  assert.match(r.text, /^zcode_tps_last \d/m);
  assert.match(r.text, /zcode_ttft_last_ms/);
  assert.match(r.text, /zcode_output_tokens_session_total/);
});

test("/turn returns every turn of the session for the chips", async () => {
  const r = await sidecar.get(`/turn?session=${SID}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.sessionId, SID);
  assert.ok(Array.isArray(r.json.turns));
  const t = r.json.turns.find((x) => x.userMessageId === "msg_a");
  assert.ok(t, "the turn must be addressable by the DOM's join key");
  assert.equal(t.cachedTokens, 30_000);
  assert.equal(t.uncachedTokens, 20_000);
  assert.equal(t.outputTokens, 5_500);
  assert.ok(r.json.totals && r.json.totals.turns >= 1);
});

test("/turn?msg= selects a single turn", async () => {
  const r = await sidecar.get(`/turn?session=${SID}&msg=msg_a`);
  assert.equal(r.status, 200);
  assert.ok(r.json.turn);
  assert.equal(r.json.turn.userMessageId, "msg_a");
  // An unknown message is a clean null, not an error: the chip renders "—".
  const missing = await sidecar.get(`/turn?session=${SID}&msg=msg_nope`);
  assert.equal(missing.status, 200);
  assert.equal(missing.json.turn, null);
});

test("the session's live indicator appears while a request runs", async () => {
  const s = await waitFor(sidecar, (j) => j?.live?.streaming, { label: "live indicator" });
  assert.equal(s.live.streaming, true);
  assert.ok(s.live.model);
});

test("a foreign origin is refused and a local one is allowed", async () => {
  // A page on the public internet must not be able to read local usage data.
  const evil = await sidecar.get("/stats", { headers: { Origin: "https://evil.example.com" } });
  assert.equal(evil.status, 403);
  const local = await sidecar.get("/stats", { headers: { Origin: "http://127.0.0.1:3000" } });
  assert.equal(local.status, 200);
  assert.equal(local.headers.get("access-control-allow-origin"), "http://127.0.0.1:3000");
  // The app's renderer sends "null" (an opaque file:// origin).
  const opaque = await sidecar.get("/stats", { headers: { Origin: "null" } });
  assert.equal(opaque.status, 200);
  assert.equal(opaque.headers.get("access-control-allow-origin"), "*");
});

test("a non-GET method is refused outright", async () => {
  const r = await sidecar.get("/stats", { method: "POST" });
  assert.equal(r.status, 405);
});

test("an OPTIONS preflight is answered for local origins", async () => {
  const r = await sidecar.get("/stats", { method: "OPTIONS", headers: { Origin: "http://localhost:1234" } });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get("access-control-allow-methods"), "GET");
});

test("an unknown path is a 404 JSON error", async () => {
  const r = await sidecar.get("/nope");
  assert.equal(r.status, 404);
  assert.equal(r.json.error, "not found");
});

test("the server writes its port file so hooks and the injector can find it", async () => {
  const portFile = path.join(machine.dir, ".zcode", "stats-composer", "port");
  assert.ok(fs.existsSync(portFile), "the port file is how every other component discovers the sidecar");
  assert.equal(Number(fs.readFileSync(portFile, "utf8").trim()), sidecar.port);
});

test("the dashboard is served as HTML with the donut and theme toggle", async () => {
  const r = await sidecar.get("/dashboard");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/html/);
  for (const needle of ['id="donut"', 'id="legend"', 'id="themeToggle"', 'id="tbl"', 'id="pager"',
    'class="donutarea"', 'class="dcenter"', 'prefers-reduced-motion', 'data-theme']) {
    assert.ok(r.text.includes(needle), `dashboard HTML is missing ${needle}`);
  }
});

test("a second sidecar on the same port exits instead of stealing it", async () => {
  // Two servers on one port would split pollers between two snapshots; the
  // design is one server, so the second process must stand down. Its handle is
  // stopped explicitly (and the harness tracks it regardless) so a stand-down
  // path cannot leak a process.
  const dup = await startSidecar(machine, { config: { mode: "skill" }, port: sidecar.port });
  await dup.stop();
  // Either it stood down on its own or it reported healthy-then-exited; the
  // ORIGINAL must still answer either way.
  const r = await sidecar.get("/health");
  assert.equal(r.status, 200, "the original sidecar must survive a duplicate launch attempt");
});

test("sidecar config (window) reaches the snapshot", async () => {
  // window=10 was written in the config; the snapshot's window block must
  // reflect it rather than a hardcoded default.
  const r = await sidecar.get("/stats");
  assert.equal(r.json.window.window, 10);
});
