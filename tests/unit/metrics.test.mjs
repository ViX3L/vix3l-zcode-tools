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
// Subagent activity — the conversation's own tree.
//
// A subagent's requests are written to its OWN session, never the parent's, and
// the link back is `session.parent_id`: the child names the session that spawned
// it. That makes the surface SESSION-SCOPED — "what the subagents of THIS
// conversation did" — which is a different statement from the time window these
// tests used to pin ("what any subagent on the machine did in the last 15 min").
//
// Three properties matter to a human reading the card, and each has a test here:
//
//   1. it counts this conversation's children and nobody else's;
//   2. the count is MONOTONIC — requests complete, so the number only grows.
//      The old window made it fall (91 → 89) as rows aged out, which is the
//      reversal the card used to show;
//   3. the children's tokens are part of the session's totals, with the split
//      carried in `tokens.subagents` / `tokens.subagentSharePct`, so the card's
//      cache-hit % describes the whole tree instead of only the conversation.
//
// The fixture below is built with exact numbers so every assertion is a value
// this file states rather than one it hopes for.

// A parent conversation with two spawned children, plus a second conversation
// with a child of its own (which must never be counted).
//
//   parent  sess_tree         1 main_turn request
//   child   sess_tree_c1      spawned by sess_tree
//   child   sess_tree_c2      spawned by sess_tree
//   other   sess_other        a different conversation, child sess_other_c
//
// Child requests (all completed; `agent` names the spawning agent):
//   c1  zcode-Explore           600 gen / 1000 ms = 600.0 tok/s
//   c2  zcode-Explore           300 gen / 1000 ms = 300.0 tok/s
//   c3  zcode-general-purpose   200 gen / 1000 ms = 200.0 tok/s
//   c4  (compact, the child's own) 100 gen / 1000 ms = 100.0 tok/s
//   c5  zcode-Explore, second child  50 gen / 1000 ms =  50.0 tok/s
function treeFixture(label) {
  const m = makeMachine(label);
  const db = createDb(m);
  addSession(db, "sess_tree", "Parent conversation");
  addSession(db, "sess_tree_c1", "Explore child", { parentId: "sess_tree" });
  addSession(db, "sess_tree_c2", "Explore child 2", { parentId: "sess_tree" });
  addSession(db, "sess_other", "Another conversation");
  addSession(db, "sess_other_c", "Someone else's child", { parentId: "sess_other" });

  // The parent's own traffic: 200 generated over 1000 ms → 200.0 tok/s.
  addRequest(db, {
    sessionId: "sess_tree", id: "p1", genMs: 1000, ttftMs: 100, outputTokens: 200,
    reasoningTokens: 0, inputTokens: 10_000, cacheRead: 4_000,
  });

  const sub = (sessionId, id, agent, o) =>
    addRequest(db, {
      sessionId, id, querySource: "subagent", agent, genMs: 1000, ttftMs: 100,
      reasoningTokens: 0, inputTokens: 2_000, cacheRead: 0, ...o,
    });
  sub("sess_tree_c1", "c1", "zcode-Explore", { outputTokens: 500, reasoningTokens: 100, inputTokens: 8_000, cacheRead: 7_000 });
  sub("sess_tree_c1", "c2", "zcode-Explore", { outputTokens: 300, inputTokens: 4_000 });
  sub("sess_tree_c1", "c3", "zcode-general-purpose", { outputTokens: 200, inputTokens: 2_000, cacheRead: 1_000, ttftMs: 500 });
  // The child's OWN compaction request: not `subagent`, but it ran inside a
  // session this conversation spawned, so it is this conversation's usage.
  addRequest(db, {
    sessionId: "sess_tree_c1", id: "c4", querySource: "compact", genMs: 1000, ttftMs: 100,
    outputTokens: 100, reasoningTokens: 0, inputTokens: 1_000, cacheRead: 0,
  });
  sub("sess_tree_c2", "c5", "zcode-Explore", { outputTokens: 50, inputTokens: 1_000, cacheRead: 500 });
  // Another conversation's subagent: same shape, must never appear here.
  sub("sess_other_c", "o1", "zcode-Explore", { outputTokens: 9_999, inputTokens: 9_999, cacheRead: 0 });
  db.close();
  return { m, path: m.dbPath };
}

test("subagent activity is attributed by the child session's parent link", () => {
  const f = treeFixture("subagent-tree");
  const dbh = openAt(f.path);
  const sa = M.subagentActivity(dbh, "sess_tree");
  // c1..c5 — and NOT o1, which is another conversation's child.
  assert.equal(sa.requests, 5, "every request in the spawned sessions, and only those");
  assert.equal(sa.sessions, 2, "both children of this session are counted");
  assert.equal(sa.sessionId, "sess_tree");
  // Rates: (600 + 300 + 200 + 100 + 50) / 5 samples = 250.0, peak 600.
  assert.equal(sa.avgTps, 250);
  assert.equal(sa.peakTps, 600);
  // TTFT over the same rated samples: (100+100+500+100+100)/5 = 180.
  assert.equal(sa.avgTtftMs, 180);
  assert.equal(sa.generated, 1250, "500+100 + 300 + 200 + 100 + 50");
  assert.equal(sa.running, 0);
  assert.equal(sa.active, false, "nothing ran in the last minute");
  dbh.close();
  cleanup({ ...f.m, db: null });
});

test("the count is monotonic — it never falls as rows age out", () => {
  // THE REVERSAL REGRESSION TEST. The surface used to report a machine-wide
  // 15-minute window, so a card could read "91 reqs" and then "89 reqs" with no
  // work undone (rows aged out), and after an idle stretch the first refresh
  // dropped every expired row at once. These fixture rows completed in 1970 —
  // decades outside any window a sane implementation would keep — and they are
  // still counted, because the scope is the conversation's tree, not a clock.
  const f = treeFixture("subagent-monotonic");
  const before = (() => {
    const dbh = openAt(f.path);
    const sa = M.subagentActivity(dbh, "sess_tree", {});
    dbh.close();
    return sa;
  })();
  assert.equal(before.requests, 5, "old rows stay counted");
  assert.equal(before.lastAt != null, true);
  // A new child request completes: the count grows...
  const wdb = new DatabaseSync(f.path);
  addRequest(wdb, {
    sessionId: "sess_tree_c1", id: "c6", querySource: "subagent", agent: "zcode-Explore",
    genMs: 1000, ttftMs: 100, outputTokens: 10, reasoningTokens: 0, inputTokens: 100, cacheRead: 0,
  });
  wdb.close();
  const dbh = openAt(f.path);
  const after = M.subagentActivity(dbh, "sess_tree", {});
  assert.equal(after.requests, 6);
  assert.ok(after.requests >= before.requests, "the count only ever grows");
  assert.notEqual(after.sig, before.sig, "the change signature moves when work lands");
  dbh.close();
  cleanup({ ...f.m, db: null });
});

test("the children's tokens fold into the session tree totals, with the split kept", () => {
  const f = treeFixture("subagent-tokens");
  const dbh = openAt(f.path);
  const snap = M.sessionSnapshot(dbh, "sess_tree", { window: 10 });
  const t = snap.session.tokens;
  // Conversation only: cached 4000, uncached 10000-4000, output 200.
  assert.equal(t.main.cached, 4_000);
  assert.equal(t.main.uncached, 6_000);
  assert.equal(t.main.output, 200);
  assert.equal(t.main.total, 10_200);
  assert.equal(t.main.cacheHitPct, 40);
  // Children: input 8000+4000+2000+1000+1000 = 16000, cache_read 7000+0+1000+0+500
  // = 8500, generated 1250 → total 17250, hit 8500/16000 = 53.1.
  assert.equal(t.subagents.cached, 8_500);
  assert.equal(t.subagents.uncached, 7_500);
  assert.equal(t.subagents.output, 1_250);
  assert.equal(t.subagents.total, 17_250);
  assert.equal(t.subagents.cacheHitPct, 53.1);
  // The tree is the sum of the two, and the share is measured on it.
  assert.equal(t.total, 10_200 + 17_250);
  assert.equal(t.cached, 12_500);
  assert.equal(t.uncached, 13_500);
  assert.equal(t.output, 1_450);
  // Tree-wide cache hit: 12500 / 26000 = 48.076… → 48.1, against the
  // conversation-only 40.0 the old build reported.
  assert.equal(t.cacheHitPct, 48.1);
  // 17250 / 27450 = 62.841… → 62.8
  assert.equal(t.subagentSharePct, 62.8);
  // The aggregate's own token sums are TREE-wide too, so the CLI, the MCP tool
  // and the dashboard card cannot disagree with the card's panel above them.
  // `outputTokens` is the raw output column and `reasoningTokens` its sibling,
  // exactly as they read for a conversation-only session: 1150 + 200 and 100.
  assert.equal(snap.session.outputTokens, 1_350);
  assert.equal(snap.session.reasoningTokens, 100);
  assert.equal(snap.session.outputTokens + snap.session.reasoningTokens, t.output);
  assert.equal(snap.session.inputTokens, 26_000);
  assert.equal(snap.session.cacheRead, 12_500);
  dbh.close();
  cleanup({ ...f.m, db: null });
});

test("the conversation's own rates stay free of the children's streams", () => {
  // The split above is additive, never a merge: the human-facing rate figures
  // describe the conversation's own requests only, so parallel subagent streams
  // cannot make the session average jump around.
  const f = treeFixture("subagent-rates");
  const dbh = openAt(f.path);
  const snap = M.sessionSnapshot(dbh, "sess_tree", { window: 10 });
  assert.equal(snap.session.samples, 1, "one composer request, five children");
  assert.equal(snap.session.requests, 1);
  assert.equal(snap.session.avgTps, 200, "the parent's own rate, untouched by the children");
  assert.equal(snap.last.id, "p1");
  assert.equal(snap.window.samples, 1);
  // The block itself is a top-level surface, not a copy inside `session`.
  assert.ok(snap.subagents, "the card's last band reads this");
  assert.equal(snap.subagents.sessionId, "sess_tree");
  dbh.close();
  cleanup({ ...f.m, db: null });
});

test("the model mix covers the tree and says how much came from subagents", () => {
  const f = treeFixture("subagent-models");
  const dbh = openAt(f.path);
  const snap = M.sessionSnapshot(dbh, "sess_tree", { window: 10 });
  const models = snap.session.models;
  assert.equal(models.length, 1, "one model across parent and children");
  assert.equal(models[0].requests, 6, "1 conversation + 5 tree");
  assert.equal(models[0].subagentRequests, 5);
  // Generated: parent 200 + children 1250 (the donut's slices must sum to the
  // token total the card shows above them).
  assert.equal(models[0].generated, 1_450);
  assert.equal(models[0].share, 100);
  // The rate is weighted over the tree's rated samples, not averaged per group:
  // (200 + 600+300+200+100+50) / 6 = 241.666… → 241.7
  assert.equal(models[0].avgTps, 241.7);
  dbh.close();
  cleanup({ ...f.m, db: null });
});

test("agents and models of the tree are grouped and ranked", () => {
  const f = treeFixture("subagent-agents");
  const dbh = openAt(f.path);
  const sa = M.subagentActivity(dbh, "sess_tree");
  assert.equal(sa.agents.length, 3, "two named agents plus the child's own compact request");
  // Ranked by request count, then by name.
  assert.deepEqual(sa.agents, [
    { agent: "zcode-Explore", requests: 3, generated: 950 },
    { agent: "subagent", requests: 1, generated: 100 },
    { agent: "zcode-general-purpose", requests: 1, generated: 200 },
  ]);
  assert.equal(sa.models.length, 1);
  assert.equal(sa.models[0].model, "deepseek-v4.1-flash:cloud");
  assert.equal(sa.models[0].requests, 5);
  // The child's own compact request carries output tokens too, and it is part of
  // this conversation's tree usage: 500 + 300 + 200 + 100 + 50.
  assert.equal(sa.models[0].outputTokens, 1_150);
  assert.equal(sa.models[0].reasoningTokens, 100);
  // The per-model rate sum and its sample count travel with the group so the
  // merged mix can weight them exactly instead of averaging averages.
  assert.equal(sa.models[0].rateSum, 1_250);
  assert.equal(sa.models[0].rated, 5);
  dbh.close();
  cleanup({ ...f.m, db: null });
});

test("a subagent that is running right now is attributable too", () => {
  // The child session exists from the moment it is spawned, so a live subagent
  // needs no completed row to be named.
  const f = treeFixture("subagent-running");
  const wdb = new DatabaseSync(f.path);
  addRunningRequest(wdb, { sessionId: "sess_tree_c1", id: "run_sub", querySource: "subagent", agent: "zcode-Explore" });
  wdb.close();
  const dbh = openAt(f.path);
  const sa = M.subagentActivity(dbh, "sess_tree");
  assert.equal(sa.running, 1, "the in-flight child request is counted");
  assert.equal(sa.active, true, "a running subagent makes the surface active");
  assert.deepEqual(sa.runningAgents, ["zcode-Explore"]);
  assert.equal(sa.requests, 5, "and it is not counted as completed work");
  dbh.close();
  cleanup({ ...f.m, db: null });
});

test("the subagent aggregate is cached on its own change signature", () => {
  const f = treeFixture("subagent-cache");
  const dbh = openAt(f.path);
  const cache = {};
  const first = M.subagentActivity(dbh, "sess_tree", cache);
  const again = M.subagentActivity(dbh, "sess_tree", cache);
  assert.equal(again, first, "an unchanged tree reuses the previous aggregate object");
  // A completed child request moves the signature, so the group-bys re-run.
  const wdb = new DatabaseSync(f.path);
  addRequest(wdb, {
    sessionId: "sess_tree_c2", id: "c7", querySource: "subagent", agent: "zcode-Explore",
    genMs: 1000, ttftMs: 100, outputTokens: 5, reasoningTokens: 0, inputTokens: 10, cacheRead: 0,
  });
  wdb.close();
  const moved = M.subagentActivity(dbh, "sess_tree", cache);
  assert.notEqual(moved, first);
  assert.equal(moved.requests, 6);
  dbh.close();
  cleanup({ ...f.m, db: null });
});

test("a session with no spawned children reports nothing, not an error", () => {
  const dbh = open();
  const sa = M.subagentActivity(dbh, "sess_m");
  assert.equal(sa.requests, 0);
  assert.equal(sa.sessions, 0);
  assert.equal(sa.tokens.total, 0);
  assert.equal(sa.tokens.cacheHitPct, null);
  assert.equal(sa.avgTps, null);
  assert.equal(sa.active, false);
  assert.deepEqual(sa.agents, []);
  dbh.close();
});

test("an older database without a session table yields no subagent activity", () => {
  // The parent link lives in the `session` table; a DB predating it must not
  // throw into the snapshot path, it must simply report no children.
  const m4 = makeMachine("subagent-old");
  const db4 = new DatabaseSync(m4.dbPath);
  db4.exec(
    "CREATE TABLE model_usage (id text primary key, session_id text, turn_id text, query_source text," +
    " provider_id text, model_id text, agent text, status text, started_at integer, first_token_at integer," +
    " completed_at integer, duration_ms integer, time_to_first_token_ms integer, input_tokens integer," +
    " output_tokens integer, reasoning_tokens integer, cache_read_input_tokens integer," +
    " cache_creation_input_tokens integer, finish_reason text, error_type text);" +
    // The index the session-scoped queries pin, so the snapshot path itself runs.
    " CREATE INDEX model_usage_session_turn_idx on model_usage(session_id, turn_id)"
  );
  db4.close();
  const dbh = openAt(m4.dbPath);
  const sa = M.subagentActivity(dbh, "sess_tree");
  assert.equal(sa.requests, 0);
  assert.equal(sa.sessions, 0);
  assert.equal(sa.tokens.total, 0);
  const snap = M.sessionSnapshot(dbh, "sess_tree", { window: 10 });
  assert.equal(snap.subagents.requests, 0, "the snapshot survives too");
  dbh.close();
  cleanup({ ...m4, db: null });
});

test("a global (session-less) aggregate has no tree to fold in", () => {
  const dbh = open();
  const rows = M.sessionRequests(dbh, null);
  const agg = M.sessionAggregateFrom(rows, { usage: rows, subagents: null });
  assert.equal(agg.tokens.subagents.total, 0);
  assert.equal(agg.tokens.subagentSharePct, null);
  assert.equal(agg.tokens.total, agg.tokens.main.total);
  dbh.close();
});
