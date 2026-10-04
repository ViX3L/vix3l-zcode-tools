// A controllable stand-in for the stats sidecar, for the UI tests.
//
// The UI tests are about rendering: given a snapshot, does the pill show it
// correctly? Pointing them at a mock keeps them deterministic (no fixture DB
// needed, no dependency on the real DB's contents) and lets a test express an
// edge case — a session with no completed requests, a live/streaming request,
// a single model, a turn with no accounting yet — by writing the JSON directly.
//
// The real sidecar's own contract is covered separately (tests/integration), so
// nothing here is trusted as a substitute for it.
import { createServer } from "node:http";

// Default snapshot shaped like the real one (see metrics.sessionSnapshot):
// last/window/session/live/turns, and session.models for the dashboard donut.
export function sampleSnapshot(over = {}) {
  const session = {
    samples: 3, requests: 3, avgTps: 240.5, peakTps: 310.1, avgTtftMs: 420,
    outputTokens: 1800, reasoningTokens: 200, inputTokens: 30000, cacheRead: 12000,
    tokens: { total: 20000, cached: 12000, uncached: 18000, output: 2000, cacheHitPct: 40 },
    spanMs: 600000, busyMs: 400000, otherMs: 200000, requestBusyMs: 420000,
    toolBusyMs: 91000, toolCount: 7, toolErrorCount: 1,
    models: [
      { model: "deepseek-v4.1-flash:cloud", provider: "Ollama Cloud/deepseek-v4.1-flash:cloud",
        requests: 2, outputTokens: 1200, reasoningTokens: 200, generated: 1400, avgTps: 250, share: 70 },
      { model: "claude-sonnet-4.6", provider: "Anthropic/claude-sonnet-4.6",
        requests: 1, outputTokens: 600, reasoningTokens: 0, generated: 600, avgTps: 220, share: 30 },
    ],
    modelCount: 2,
    ...(over.session || {}),
  };
  return {
    sessionId: over.sessionId ?? "sess_test_0001",
    generatedAt: new Date().toISOString(),
    last: over.last === undefined
      ? { id: "req_last", model: "deepseek-v4.1-flash:cloud", tokPerSec: 310.1, ttftMs: 420,
          outputTokens: 600, reasoningTokens: 100, inputTokens: 10000, cacheRead: 4000,
          startedAt: 1, completedAt: 2, status: "completed" }
      : over.last,
    window: over.window === undefined ? { window: 3, samples: 3, avgTps: 240.5, peakTps: 310.1, avgTtftMs: 420 } : over.window,
    session,
    turns: over.turns === undefined ? { turns: 2, steps: 5, toolCalls: 7, toolErrors: 1, totalTokens: 20000 } : over.turns,
    live: over.live,
    // Subagent activity is a SEPARATE surface. Absent here by default, matching
    // a machine that has not spawned any — the card must then hide its whole
    // subagent block. A test that wants it passes `subagents`.
    subagents: over.subagents,
    ...(over.top || {}),
  };
}

// A subagent-activity block shaped like metrics.subagentActivity's return.
export function sampleSubagents(over = {}) {
  return {
    sinceTs: Date.now() - 15 * 60 * 1000,
    active: true,
    running: 0,
    runningAgents: [],
    requests: 12,
    sessions: 2,
    avgTps: 88.4,
    peakTps: 210.5,
    avgTtftMs: 1450,
    outputTokens: 9000,
    lastAt: Date.now() - 30_000,
    agents: [
      { agent: "zcode-Explore", requests: 10, sessions: 1, avgTps: 80.1, peakTps: 210.5,
        avgTtftMs: 1500, outputTokens: 8000, lastAt: Date.now() - 30_000 },
      { agent: "zcode-general-purpose", requests: 2, sessions: 1, avgTps: 130.2, peakTps: 150,
        avgTtftMs: 1200, outputTokens: 1000, lastAt: Date.now() - 60_000 },
    ],
    ...over,
  };
}

export function sampleTurns(over = {}) {
  return {
    sessionId: over.sessionId ?? "sess_test_0001",
    totals: over.totals ?? { turns: 2, steps: 5, toolCalls: 7, toolErrors: 1, totalTokens: 20000 },
    turns: over.turns ?? [
      { userMessageId: "msg_1", turnId: "turn_1", totalTokens: 729123, durationMs: 43000,
        outputTokens: 20000, uncachedTokens: 100000, model: "Ollama Cloud/deepseek-v4.1-flash:cloud" },
      { userMessageId: "msg_2", turnId: "turn_2", totalTokens: 1500, durationMs: 1200,
        outputTokens: 300, uncachedTokens: 800, model: "Anthropic/claude-sonnet-4.6" },
    ],
  };
}

// Start the mock. `routes` maps a pathname prefix to a value or a function
// (url) -> value; a function may return a Promise. Defaults mirror the real
// server for /stats, /turn and /health.
export async function startMockSidecar(routes = {}) {
  const requests = [];
  const state = {
    stats: routes.stats ?? sampleSnapshot(),
    turns: routes.turns ?? sampleTurns(),
    requests: routes.requests ?? { rows: [], total: 0, offset: 0, limit: 10, sortKey: "completedAt", sortDesc: true },
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    requests.push(url.pathname + url.search);
    const json = (v) => {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(typeof v === "function" ? v(url) : v));
    };
    if (url.pathname === "/health") return json({ ok: true, version: "test" });
    if (url.pathname === "/stats") return json(typeof state.stats === "function" ? state.stats(url) : state.stats);
    if (url.pathname === "/turn") return json(typeof state.turns === "function" ? state.turns(url) : state.turns);
    if (url.pathname === "/requests") return json(typeof state.requests === "function" ? state.requests(url) : state.requests);
    res.writeHead(404).end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return {
    port,
    requests,
    state,
    set(patch) { Object.assign(state, patch); },
    async close() { await new Promise((r) => server.close(r)); },
  };
}
