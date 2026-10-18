// HTTP routes. Handlers read the in-memory snapshot and never open the DB on
// the hot path.
import * as metrics from "../../scripts/lib/metrics.mjs";
import { allowOriginHeader, corsHeaders, isLocalOrigin } from "./cors.mjs";
import { dashboardHtml } from "./dashboard.mjs";

function healthPayload(store, pluginVersion) {
  const counters = store.stats();
  return {
    ok: true,
    plugin: "stats-composer",
    version: pluginVersion(),
    uptime: process.uptime(),
    refreshes: counters.refreshes,
    skips: counters.skips,
    refreshMsLast: Math.round(counters.refreshLastMs * 100) / 100,
    refreshMsAvg: Math.round(counters.refreshAvgMs * 100) / 100,
    rssKb: Math.round(process.memoryUsage().rss / 1024),
    demandAge: counters.demandAge,
  };
}

function handleStats({ store, url, sendJson }) {
  store.noteDemand();
  // The pill passes the session the app is currently showing, so switching
  // chats re-scopes immediately.
  if (store.requestSession(url.searchParams.get("session"))) store.refresh(true);
  const snap = store.snapshotJson();
  if (url.searchParams.has("full")) return sendJson(200, { ...snap, ...store.dashboardExtras() });
  const { lastTurn: _lastTurn, ...slim } = snap;
  return sendJson(200, slim);
}

function handleRequests({ store, url, sendJson }) {
  store.noteDemand();
  if (store.requestSession(url.searchParams.get("session"))) store.refresh(true);
  const query = url.searchParams;
  const page = store.requestsPage(
    Number(query.get("offset")) || 0,
    Number(query.get("limit")) || 10,
    query.get("sort") || "completedAt",
    query.get("dir") !== "asc"
  );
  // Presentation fields, added here where the row set is already in hand.
  page.rows = page.rows.map((row) => ({
    id: row.id,
    time: row.completedAt ? new Date(row.completedAt).toLocaleTimeString() : "—",
    model: row.model,
    provider: row.providerId,
    tokPerSec: row.tokPerSec,
    ttftMs: row.ttftMs,
    out: row.out,
    cacheRead: row.cacheRead || 0,
    status: row.status,
  }));
  page.sessionId = store.currentSessionId();
  return sendJson(200, page);
}

function handleMetrics({ store, res }) {
  const snap = store.snapshotJson();
  res.writeHead(200, {
    "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
    "Cache-Control": "no-store",
  });
  return res.end(snap.error ? "# no data\n" : store.prometheus(snap));
}

function handleTurn({ store, url, sendJson }) {
  // Per-turn usage for the usage-context plugin. `session` scopes it; `msg`
  // selects one turn by the DOM's data-turn-id.
  store.noteDemand();
  if (store.requestSession(url.searchParams.get("session"))) store.refresh(true);
  const sid = store.currentSessionId() || metrics.lastActiveSessionId();
  const msg = url.searchParams.get("msg");
  let db = null;
  try {
    db = metrics.openDb();
    if (msg) {
      const turn = metrics.turnUsageByMessage(db, sid, msg);
      return sendJson(200, turn ? { turn, sessionId: sid } : { turn: null, sessionId: sid });
    }
    const all = metrics.turnUsageFor(db, sid);
    return sendJson(200, { turns: all.turns, totals: all.totals, sessionId: sid });
  } catch (error) {
    return sendJson(200, { turn: null, turns: [], error: String((error && error.message) || error) });
  } finally {
    try { db && db.close(); } catch { /* read-only handle: close is cleanup */ }
  }
}

export function createHandler({ store, port, pluginVersion }) {
  return async function handle(req, res) {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const origin = req.headers.origin || "";
    const localOrigin = isLocalOrigin(origin);

    if (req.method === "OPTIONS") {
      res.writeHead(204, localOrigin ? {
        "Access-Control-Allow-Origin": allowOriginHeader(origin),
        "Access-Control-Allow-Methods": "GET",
        "Access-Control-Max-Age": "600",
      } : {});
      return res.end();
    }
    if (!localOrigin) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      return res.end("forbidden origin");
    }
    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "text/plain" });
      return res.end("GET only");
    }

    const headers = corsHeaders(origin);
    const sendJson = (code, body) => {
      res.writeHead(code, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        ...headers,
      });
      res.end(JSON.stringify(body));
    };
    const ctx = { store, url, res, sendJson, pluginVersion };

    try {
      if (url.pathname === "/health") return sendJson(200, healthPayload(store, pluginVersion));
      if (url.pathname === "/stats" || url.pathname === "/stats.json") return handleStats(ctx);
      if (url.pathname === "/requests" || url.pathname === "/requests.json") return handleRequests(ctx);
      if (url.pathname === "/metrics") return handleMetrics(ctx);
      if (url.pathname === "/turn" || url.pathname === "/turn.json") return handleTurn(ctx);
      if (url.pathname === "/dashboard") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(dashboardHtml());
      }
      return sendJson(404, { error: "not found" });
    } catch (error) {
      try {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: String((error && error.message) || error) }));
      } catch { /* the socket may already be gone */ }
    }
  };
}
