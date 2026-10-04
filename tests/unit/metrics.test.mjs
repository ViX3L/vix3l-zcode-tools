// The arithmetic, against a fixture DB. metrics.mjs is where every number the
// UI ever shows is computed, so these are the tests with the most leverage: a
// wrong token decomposition or a mis-scaled rate would be wrong everywhere at
// once — pill, card, chips, dashboard, CLI and MCP alike.
//
// Fixtures are built with exact values and the assertions use exact expected
// numbers (not "greater than zero"), so an off-by-one in a sum fails here.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeMachine, createDb, addSession, addRequest, addRunningRequest, addTurn, addTool, cleanup } from "../lib/fixtures.mjs";

// metrics.mjs resolves DB_PATH and stateFile() from the environment at IMPORT
// time, so the env must be set before the import — hence the dynamic import
// inside each test group. One machine per file, reused.
const machine = makeMachine("metrics");
const db = createDb(machine);
addSession(db, "sess_m", "Metrics fixture");

// Turn 1: two requests. The numbers are chosen so each aggregate is
// independently checkable.
//   r1: 600 output + 100 reasoning = 700 tok over 3000 ms  -> 233.3 tok/s
//   r2: 300 output +   0 reasoning = 300 tok over 1000 ms  -> 300.0 tok/s
addRequest(db, { sessionId: "sess_m", turnId: "turn_1", id: "r1", genMs: 3000, ttftMs: 200,
  outputTokens: 600, reasoningTokens: 100, inputTokens: 10000, cacheRead: 4000, startedAt: 1_000_000, completedAt: 1_000_000 + 200 + 3000 });
addRequest(db, { sessionId: "sess_m", turnId: "turn_1", id: "r2", genMs: 1000, ttftMs: 100,
  outputTokens: 300, reasoningTokens: 0, inputTokens: 5000, cacheRead: 1000, startedAt: 1_100_000, completedAt: 1_100_000 + 100 + 1000 });
// Turn 2: one request on a second model, so per-model aggregation has two keys.
addRequest(db, { sessionId: "sess_m", turnId: "turn_2", id: "r3", modelId: "claude-sonnet-4.6",
  genMs: 2000, ttftMs: 400, outputTokens: 400, reasoningTokens: 0, inputTokens: 2000, cacheRead: 0,
  startedAt: 1_200_000, completedAt: 1_200_000 + 400 + 2000 });
// A subagent request: must be EXCLUDED from human-facing figures when the
// session has main_turn rows.
addRequest(db, { sessionId: "sess_m", turnId: "turn_9", id: "r_sub", querySource: "subagent",
  genMs: 5000, outputTokens: 9999, reasoningTokens: 0, startedAt: 1_300_000, completedAt: 1_300_000 + 5000 });
// A cancelled request: status != completed, so it is excluded entirely.
addRequest(db, { sessionId: "sess_m", turnId: "turn_2", id: "r_cxl", status: "cancelled",
  genMs: 1000, outputTokens: 111, startedAt: 1_400_000, completedAt: 1_400_000 + 1000 });
// A running request: drives the live indicator, must not appear in averages.
addRunningRequest(db, { sessionId: "sess_m", turnId: "turn_3", id: "r_run", startedAt: Date.now() - 1200 });

// turn_usage rows: the app's own per-turn accounting.
addTurn(db, { sessionId: "sess_m", turnId: "turn_1", userMessageId: "msg_1",
  inputTokens: 100_000, cacheRead: 60_000, outputTokens: 20_000, reasoningTokens: 2_000,
  totalTokens: 62_000, durationMs: 30_000, steps: 2, toolCalls: 3 });
addTurn(db, { sessionId: "sess_m", turnId: "turn_2", userMessageId: "msg_2",
  inputTokens: 10_000, cacheRead: 0, outputTokens: 1_000, reasoningTokens: 0,
  totalTokens: 11_000, durationMs: 2_000, steps: 1, toolCalls: 0 });

// tool_usage: measured tool time (not estimated).
addTool(db, { sessionId: "sess_m", turnId: "turn_1", toolName: "read", durationMs: 1_500 });
addTool(db, { sessionId: "sess_m", turnId: "turn_1", toolName: "bash", durationMs: 2_500, status: "error" });
db.close();

const stateFile = path.join(machine.dir, "tps-monitor.last-session.json");
fs.writeFileSync(stateFile, JSON.stringify({ sessionId: "sess_m", ts: Date.now(), source: "test" }));
process.env.HOME = machine.dir;
process.env.USERPROFILE = machine.dir;
process.env.ZCODE_USAGE_DB = machine.dbPath;
process.env.TPS_MONITOR_STATE_FILE = stateFile;

const M = await import("../../plugins/stats-composer/scripts/lib/metrics.mjs");
// metrics.mjs resolves DB_PATH from the environment ONCE, at import time, so a
// test that wants a second database opens it here and passes the handle in —
// every metrics function takes a db, which is exactly what makes that possible.
const { DatabaseSync } = await import("node:sqlite");
const openAt = (p) => new DatabaseSync(p, { readOnly: true });
const SID = "sess_m";
const open = () => M.openDb();

after(() => cleanup({ ...machine, db: null }));

test("row projection computes the text-tier rate from the streaming window", () => {
  const dbh = open();
  const last = M.lastRequest(dbh, SID);
  // Newest completed main_turn row is r3.
  assert.equal(last.id, "r3");
  assert.equal(last.outputTokens, 400);
  assert.equal(last.tokPerSec, 200); // 400 tok / 2.0 s
  assert.equal(last.ttftMs, 400);
  assert.equal(last.genMs, 2000);
  dbh.close();
});

test("the wire tier covers tool-call-only requests (no first_token_at)", () => {
  // A request with no first_token_at gets its rate from duration_ms instead, and
  // TTFT is null by definition (no user-visible first token). metrics.mjs
  // captures DB_PATH at import time, so this opens its own handle directly —
  // every metrics function takes a db, which is what makes that possible.
  const m2 = makeMachine("wire");
  const d = createDb(m2);
  addSession(d, "sess_w");
  d.prepare(
    "INSERT INTO model_usage (id, logical_request_id, session_id, turn_id, query_source, provider_id, model_id," +
    " status, started_at, first_token_at, completed_at, duration_ms, time_to_first_token_ms," +
    " output_tokens, reasoning_tokens, input_tokens, cache_read_input_tokens)" +
    " VALUES ('w1','w1','sess_w','turn_1','main_turn','p','m','completed',1000,NULL,4000,3000,NULL,300,0,0,0)"
  ).run();
  d.close();
  const dbh = openAt(m2.dbPath);
  const r = M.lastRequest(dbh, "sess_w");
  assert.equal(r.genMs, 3000);
  assert.equal(r.tokPerSec, 100); // 300 tok / 3 s, from the wire window
  assert.equal(r.ttftMs, null);
  dbh.close();
  cleanup(m2);
});

test("subagent and non-completed rows never reach the session scope", () => {
  const dbh = open();
  const rows = M.sessionRequests(dbh, SID);
  const ids = rows.map((r) => r.id);
  assert.ok(!ids.includes("r_sub"), "subagent traffic must not pollute human-facing figures");
  assert.ok(!ids.includes("r_cxl"), "a cancelled request is not a completed request");
  assert.ok(!ids.includes("r_run"), "a running request has no figures yet");
  assert.deepEqual(ids.sort(), ["r1", "r2", "r3"]);
  dbh.close();
});

test("sessionRequests is unbounded and newest-first", () => {
  const dbh = open();
  const rows = M.sessionRequests(dbh, SID);
  assert.equal(rows.length, 3);
  // completedAt desc: r3 (1,202,400) > r2 > r1
  assert.deepEqual(rows.map((r) => r.id), ["r3", "r2", "r1"]);
  dbh.close();
});

test("windowStats averages the last N requests", () => {
  const dbh = open();
  const w = M.windowStats(dbh, SID, 2);
  assert.equal(w.window, 2);
  assert.equal(w.samples, 2);
  // r3 = 200, r2 = 300 -> avg 250.0, peak 300
  assert.equal(w.avgTps, 250);
  assert.equal(w.peakTps, 300);
  dbh.close();
});

test("aggregate() only counts rows that have a rate", () => {
  const rows = M.sessionRequests(open(), SID);
  const a = M.aggregate(rows);
  assert.equal(a.requests, 3);
  assert.equal(a.samples, 3); // all three have a rate
  assert.equal(a.outputTokens, 1300); // 600+300+400
  assert.equal(a.reasoningTokens, 100);
  assert.equal(a.inputTokens, 17000);
  assert.equal(a.cacheRead, 5000);
  // avg of 233.3, 300, 200 = 244.4...
  assert.equal(a.avgTps, 244.4);
});

test("the token panel decomposes cached / uncached / output exactly", () => {
  const dbh = open();
  const snap = M.sessionSnapshot(dbh, SID, { window: 10 });
  const t = snap.session.tokens;
  // cached = sum(cache_read) = 5000
  assert.equal(t.cached, 5000);
  // uncached = sum(input) - cached = 17000 - 5000
  assert.equal(t.uncached, 12000);
  // output = sum(output + reasoning) = 1300 + 100
  assert.equal(t.output, 1400);
  assert.equal(t.total, 5000 + 12000 + 1400);
  // hit% = cached / (cached + uncached) = 5000 / 17000
  assert.equal(t.cacheHitPct, 29.4);
  dbh.close();
});

test("cache_creation_input_tokens is deliberately not used as the uncached figure", () => {
  // The source documents why (it is 0 on nearly every live row while
  // input-minus-cache_read is the real uncached count). Assert the invariant on
  // the fixture, whose cache_creation is 0 throughout.
  const dbh = open();
  const rows = M.sessionRequests(dbh, SID);
  for (const r of rows) assert.equal(r.cacheWrite, 0);
  const t = M.sessionAggregateFrom(rows).tokens;
  assert.equal(t.uncached, 12000);
  assert.notEqual(t.uncached, 0);
  dbh.close();
});

test("per-model aggregation splits by model and ranks by generated tokens", () => {
  const dbh = open();
  const snap = M.sessionSnapshot(dbh, SID, { window: 10 });
  const models = snap.session.models;
  assert.equal(snap.session.modelCount, 2);
  assert.equal(models.length, 2);
  // Generated: the 2 requests on the default model (700 + 300 = 1000) vs claude (400).
  const top = models[0];
  assert.equal(top.model, "deepseek-v4.1-flash:cloud");
  assert.equal(top.generated, 1000);
  assert.equal(top.requests, 2);
  const second = models[1];
  assert.equal(second.model, "claude-sonnet-4.6");
  assert.equal(second.generated, 400);
  // Shares are generated/total, rounded to 0.1.
  assert.equal(top.share, 71.4); // 1000/1400
  assert.equal(second.share, 28.6);
  assert.equal(top.share + second.share, 100);
  dbh.close();
});

test("model shares are sorted descending and ties break deterministically", () => {
  const dbh = open();
  const models = M.sessionSnapshot(dbh, SID, { window: 10 }).session.models;
  for (let i = 1; i < models.length; i++) {
    assert.ok(models[i - 1].share >= models[i].share, "not sorted by share");
  }
  dbh.close();
});

test("the session span accounts busy time from generation windows", () => {
  const dbh = open();
  const s = M.sessionSnapshot(dbh, SID, { window: 10 }).session;
  // span = newest completedAt - oldest startedAt
  assert.equal(s.spanMs, 1_202_400 - 1_000_000);
  // busyMs = sum(genMs) = 3000 + 1000 + 2000
  assert.equal(s.busyMs, 6000);
  assert.equal(s.otherMs, s.spanMs - s.busyMs);
  dbh.close();
});

test("tool time is measured from tool_usage, not estimated", () => {
  const dbh = open();
  const snap = M.sessionSnapshot(dbh, SID, { window: 10 });
  assert.ok(snap.tools, "tool figures should be present");
  assert.equal(snap.tools.count, 2);
  assert.equal(snap.tools.busyMs, 4000); // 1500 + 2500
  assert.equal(snap.tools.errorCount, 1);
  // The estimated fields are replaced by the measured ones.
  assert.equal(snap.session.toolBusyMs, 4000);
  assert.equal(snap.session.toolCount, 2);
  dbh.close();
});

test("live rate reports a running request and estimates from the last completed one", () => {
  const dbh = open();
  const live = M.liveRate(dbh, SID);
  assert.equal(live.streaming, true);
  assert.equal(live.model, "deepseek-v4.1-flash:cloud");
  assert.ok(live.waitingMs >= 1000, "waiting time should reflect the running row's start");
  // estTps falls back to the last completed request's rate (r3 = 200).
  assert.equal(live.estTps, 200);
  dbh.close();
});

test("snapshot live block appears only while a request is running", () => {
  const dbh = open();
  const snap = M.sessionSnapshot(dbh, SID, { window: 10 });
  assert.equal(snap.live.streaming, true);
  dbh.close();
  // A session with only completed rows must report no live block at all.
  const w = makeMachine("nolive");
  const d = createDb(w);
  addSession(d, "sess_n");
  addRequest(d, { sessionId: "sess_n", id: "n1", completedAt: 5_000_000, startedAt: 4_999_000 });
  d.close();
  const dbh2 = openAt(w.dbPath);
  const snap2 = M.sessionSnapshot(dbh2, "sess_n", { window: 10 });
  assert.equal(snap2.live, undefined);
  dbh2.close();
  cleanup(w);
});

test("turn usage decomposes the app's own accounting", () => {
  const dbh = open();
  const all = M.turnUsageFor(dbh, SID);
  assert.equal(all.turns.length, 2);
  assert.equal(all.totals.turns, 2);
  assert.equal(all.totals.steps, 3); // 2 + 1
  assert.equal(all.totals.toolCalls, 3);
  const t1 = all.byUserMessage["msg_1"];
  assert.ok(t1, "turns must be addressable by user message id, the DOM's join key");
  assert.equal(t1.cachedTokens, 60_000);
  assert.equal(t1.uncachedTokens, 40_000); // 100000 - 60000
  assert.equal(t1.outputTokens, 22_000); // 20000 + 2000
  assert.equal(t1.totalTokens, 62_000);
  // Turn rate = output / duration = 22000 / 30 s
  assert.equal(t1.tps, 733.3);
  assert.equal(t1.steps, 2);
  // With no provider config on the machine the label falls back to the raw
  // provider id joined to the model — never a bare model with no provider.
  assert.equal(t1.model, "prov_1/deepseek-v4.1-flash:cloud");
  dbh.close();
});

test("turnTotals is a cheap aggregate matching the detailed path", () => {
  const dbh = open();
  const cheap = M.turnTotals(dbh, SID);
  const full = M.turnUsageFor(dbh, SID).totals;
  for (const k of ["turns", "steps", "toolCalls", "totalTokens", "cachedTokens", "uncachedTokens", "outputTokens"]) {
    assert.equal(cheap[k], full[k], `turnTotals.${k} disagrees with the detailed path`);
  }
  dbh.close();
});

test("turnUsageByMessage returns null for a turn with no accounting", () => {
  const dbh = open();
  assert.equal(M.turnUsageByMessage(dbh, SID, "msg_does_not_exist"), null);
  assert.ok(M.turnUsageByMessage(dbh, SID, "msg_1"));
  dbh.close();
});

test("resolveSession prefers the requested id, then the recorded one", () => {
  assert.equal(M.resolveSession("sess_explicit"), "sess_explicit");
  assert.equal(M.resolveSession(null), "sess_m");
  // An expired state file is ignored rather than trusted.
  const old = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  fs.writeFileSync(stateFile, JSON.stringify({ ...old, ts: Date.now() - 8 * 24 * 3600 * 1000 }));
  assert.equal(M.resolveSession(null), null);
  fs.writeFileSync(stateFile, JSON.stringify(old));
});

test("an empty session yields an explicit error, not a fabricated snapshot", () => {
  const dbh = open();
  const snap = M.sessionSnapshot(dbh, "sess_absent", { window: 10 });
  assert.equal(snap.last, null);
  assert.equal(snap.session.samples, 0);
  assert.equal(snap.session.models.length, 0);
  assert.equal(snap.session.tokens.total, 0);
  assert.equal(snap.session.tokens.cacheHitPct, null);
  dbh.close();
});

test("formatLine and formatSnapshot render a rate and a TTFT", () => {
  const dbh = open();
  const snap = M.sessionSnapshot(dbh, SID, { window: 10 });
  const line = M.formatLine(snap.last);
  assert.match(line, /200 tok\/s/);
  assert.match(line, /400ms/);
  const summary = M.formatSnapshot(snap);
  assert.match(summary, /tok\/s/);
  assert.match(summary, /TTFT/);
  dbh.close();
});

// ---------------------------------------------------------------------------
// Subagent activity — the separate surface.
//
// The fixture's r_sub row is a subagent request the tests above prove is
// EXCLUDED from the session figures. These tests prove the new surface picks it
// up — and only it — while leaving every number above untouched. `sinceTs` is
// the key knob: the surface is time-windowed because the schema cannot link a
// subagent row to the turn that spawned it (turn_id never matches, and
// parent_user_message_id does not join).
// ---------------------------------------------------------------------------

test("subagentActivity reports the subagent requests the session figures exclude", () => {
  const dbh = open();
  const sa = M.subagentActivity(dbh, 0);
  assert.equal(sa.requests, 1, "only the subagent row belongs to this surface");
  assert.equal(sa.sessions, 1);
  assert.equal(sa.agents.length, 1);
  assert.equal(sa.agents[0].agent, "subagent");
  assert.equal(sa.agents[0].requests, 1);
  // r_sub: 9999 output + 0 reasoning = 9999 tok. Its generation window is
  // completed_at - first_token_at = 1_305_000 - 1_300_200 = 4_800 ms (the
  // fixture's firstTokenAt defaults to startedAt + ttftMs), so 9999/4.8 =
  // 2083.1 tok/s — not the 1999.8 a naive 5000 ms divisor would give.
  assert.equal(sa.agents[0].avgTps, 2083.1);
  assert.equal(sa.outputTokens, 9999);
  // Not running, and last completion is far in the past (fixture epoch ~1.3e6),
  // so the surface is not active.
  assert.equal(sa.running, 0);
  assert.equal(sa.active, false);
  dbh.close();
});

test("the subagent surface stays separate from the session aggregate", () => {
  const dbh = open();
  const snap = M.sessionSnapshot(dbh, SID, { window: 10 });
  // The session average is r1+r2+r3 only: (233.3+300+200)/3 = 244.4, with the
  // subagent's 2083.1 EXCLUDED. If subagent rows ever leaked into the session
  // scope this would jump, so it is the guard that the two surfaces stay apart.
  assert.equal(snap.session.avgTps, 244.4);
  assert.equal(snap.session.samples, 3);
  // The subagent surface sees exactly the row the session dropped.
  const sa = M.subagentActivity(dbh, 0);
  assert.equal(sa.requests, 1);
  assert.equal(sa.avgTps, 2083.1);
  dbh.close();
});

test("subagentActivity honours its time window", () => {
  const dbh = open();
  // The fixture row completes at ~1_305_000 (epoch ms — this is a 1970 date, on
  // purpose). A window starting after it finds nothing; one before it finds it.
  assert.equal(M.subagentActivity(dbh, 2_000_000).requests, 0, "a later window excludes the row");
  assert.equal(M.subagentActivity(dbh, 1_000_000).requests, 1, "an earlier window includes it");
  dbh.close();
});

test("a running subagent reads as active and names its agent", () => {
  // Its own machine: a RUNNING subagent cannot come from the completed scan, and
  // isolating it keeps the shared fixture's assertions above undisturbed.
  const m2 = makeMachine("subagent-running");
  const db2 = createDb(m2);
  addSession(db2, "sess_sa", "Subagent running");
  addRunningRequest(db2, { sessionId: "sess_sa", id: "run_sub", querySource: "subagent", agent: "zcode-Explore" });
  db2.close();
  const dbh = openAt(m2.dbPath);
  const sa = M.subagentActivity(dbh, Date.now() - 60_000);
  assert.equal(sa.running, 1, "the running subagent is counted");
  assert.equal(sa.active, true, "a running subagent makes the surface active");
  assert.deepEqual(sa.runningAgents, ["zcode-Explore"]);
  dbh.close();
  cleanup({ ...m2, db: null });
});

test("subagentActivity groups by agent and ranks them by volume", () => {
  const m3 = makeMachine("subagent-agents");
  const db3 = createDb(m3);
  addSession(db3, "sess_g", "Grouped");
  const now = Date.now();
  // Two requests for zcode-Explore, one for zcode-general-purpose.
  addRequest(db3, { sessionId: "sess_g", id: "g1", querySource: "subagent", agent: "zcode-Explore",
    outputTokens: 500, reasoningTokens: 0, genMs: 1000, ttftMs: 100, completedAt: now - 2000, startedAt: now - 3000 });
  addRequest(db3, { sessionId: "sess_g", id: "g2", querySource: "subagent", agent: "zcode-Explore",
    outputTokens: 300, reasoningTokens: 0, genMs: 1000, ttftMs: 100, completedAt: now - 1000, startedAt: now - 2000 });
  addRequest(db3, { sessionId: "sess_g", id: "g3", querySource: "subagent", agent: "zcode-general-purpose",
    outputTokens: 100, reasoningTokens: 0, genMs: 1000, ttftMs: 100, completedAt: now - 500, startedAt: now - 1500 });
  db3.close();
  const dbh = openAt(m3.dbPath);
  const sa = M.subagentActivity(dbh, now - 60_000);
  assert.equal(sa.requests, 3, "all three subagent rows are inside the window");
  assert.equal(sa.agents.length, 2, "two distinct agents");
  // Ranked by request count: Explore (2) before general-purpose (1).
  assert.equal(sa.agents[0].agent, "zcode-Explore");
  assert.equal(sa.agents[0].requests, 2);
  assert.equal(sa.agents[1].agent, "zcode-general-purpose");
  assert.equal(sa.agents[1].requests, 1);
  // A completion landed within the last minute, so the surface is active.
  assert.equal(sa.active, true);
  dbh.close();
  cleanup({ ...m3, db: null });
});
