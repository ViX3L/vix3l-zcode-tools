// Snapshot assembly and caches.
import {
  dbInfo,
  indexHint,
  pct,
  providerLabel,
  round1,
  scopeRows,
  tokenDecomp,
  usageRows,
} from "./db.mjs";
import { aggregate, resolveSession, runningRequest } from "./requests.mjs";
import { subagentActivity } from "./subagents.mjs";
import { toolSignature, toolUsageFor } from "./tools.mjs";

// Cheap change probes for the snapshot cache: "has any request completed since
// the last scan?" Both are single index-assisted aggregates (well under a
// millisecond on the live DB) that make a full re-scan unnecessary when the
// answer is no. The session index is pinned for the same reason as elsewhere.
function completedSignature(db, sid) {
  try {
    const r = db
      .prepare(
        "SELECT COUNT(*) n, MAX(completed_at) m FROM model_usage" + indexHint(sid) +
          " WHERE status = 'completed'" +
          (sid ? " AND session_id = ?" : "")
      )
      .get(...(sid ? [sid] : []));
    return `${r.n}:${r.m ?? 0}`;
  } catch {
    return null;
  }
}
// synchronous work per second in the sidecar. One scan plus in-memory
// derivation costs roughly a third of that, which matters because node:sqlite
// blocks the event loop.
function scanRows(db, sid, cache) {
  const sig = cache ? completedSignature(db, sid) : null;
  if (cache && sig != null && cache.rowSid === sid && cache.rowSig === sig && Array.isArray(cache.rows)) {
    return { sig, rows: cache.rows, usage: Array.isArray(cache.usage) ? cache.usage : cache.rows };
  }
  const rows = scopeRows(db, sid);
  const usage = usageRows(db, sid);
  if (cache && sig != null) {
    cache.rowSid = sid;
    cache.rowSig = sig;
    cache.rows = rows;
    cache.usage = usage;
  }
  return { sig, rows, usage };
}

function derivedFigures(rows, usage, sub, win, cache, sid, sig) {
  if (
    cache && sig != null && cache.derivedSid === sid && cache.derivedSig === sig &&
    cache.derivedWin === win && cache.derivedSubSig === (sub ? sub.sig : null) && cache.derived
  ) {
    return cache.derived;
  }
  const derived = {
    window: { window: Math.min(win, rows.length), ...aggregate(rows.slice(0, win).reverse()) },
    session: sessionAggregateFrom(rows, { usage, subagents: sub }),
  };
  if (cache && sig != null) {
    cache.derivedSid = sid;
    cache.derivedSig = sig;
    cache.derivedWin = win;
    cache.derivedSubSig = sub ? sub.sig : null;
    cache.derived = derived;
  }
  return derived;
}

function attachTools(snap, db, sid, cache) {
  const tsig = cache ? toolSignature(db, sid) : null;
  let tools;
  if (cache && tsig != null && cache.toolSid === sid && cache.toolSig === tsig && cache.tools) {
    tools = cache.tools;
  } else {
    tools = toolUsageFor(db, sid);
    if (cache && tsig != null) {
      cache.toolSid = sid;
      cache.toolSig = tsig;
      cache.tools = tools;
    }
  }
  if (!tools.count) return;
  snap.tools = tools;
  // Replace the estimated figures with measured ones where they exist.
  snap.session.toolBusyMs = tools.busyMs;
  snap.session.toolWallMs = tools.wallMs;
  snap.session.toolCount = tools.count;
  snap.session.toolErrorCount = tools.errorCount;
}

function attachLive(snap, db, sid) {
  if (!snap.last) return;
  const running = runningRequest(db, sid);
  if (!running) return;
  snap.live = {
    streaming: true,
    turnId: running.turnId,
    model: running.model,
    startedAt: running.startedAt,
    waitingMs: running.startedAt ? Date.now() - running.startedAt : null,
    estTps: snap.last.tokPerSec != null ? snap.last.tokPerSec : null,
  };
}

export function sessionSnapshot(db, requestedSid, opts = {}) {
  const sid = resolveSession(requestedSid);
  if (!sid) return { error: "no session", dbInfo: dbInfo() };
  const win = Math.max(1, Number(opts.window) || 10);
  const cache = opts.cache || null;
  const sub = opts.subagents === false ? null : subagentActivity(db, sid, cache);
  const { sig, rows, usage } = scanRows(db, sid, cache);
  const derived = derivedFigures(rows, usage, sub, win, cache, sid, sig);

  const snap = {
    sessionId: sid,
    generatedAt: new Date().toISOString(),
    last: rows.length ? rows[0] : null,
    window: derived.window,
    // Copy before mutating: the cached object must not absorb the tool fields.
    session: { ...derived.session },
    dbInfo: dbInfo(),
  };
  if (sub) snap.subagents = sub;
  if (opts.tools !== false) attachTools(snap, db, sid, cache);
  if (opts.live !== false) attachLive(snap, db, sid);
  return snap;
}

function tokenPanel(u, sub) {
  const subTok = sub ? sub.tokens : null;
  const main = tokenDecomp({
    input: u.inputTokens,
    cacheRead: u.cacheRead,
    output: u.outputTokens,
    reasoning: u.reasoningTokens,
  });
  const cached = main.cached + (subTok ? subTok.cached : 0);
  const uncached = main.uncached + (subTok ? subTok.uncached : 0);
  const output = main.output + (subTok ? subTok.output : 0);
  const total = cached + uncached + output;
  return {
    panel: {
      total,
      cached,
      uncached,
      output,
      cacheHitPct: pct(cached, uncached),
      // The split, so "which part came from subagents?" is never guessed.
      main: {
        total: main.total,
        cached: main.cached,
        uncached: main.uncached,
        output: main.output,
        cacheHitPct: pct(main.cached, main.uncached),
      },
      subagents: {
        total: subTok ? subTok.total : 0,
        cached: subTok ? subTok.cached : 0,
        uncached: subTok ? subTok.uncached : 0,
        output: subTok ? subTok.output : 0,
        cacheHitPct: subTok ? subTok.cacheHitPct : null,
      },
      subagentSharePct:
        subTok && subTok.total > 0 && total > 0
          ? round1((subTok.total / total) * 100)
          : null,
    },
    // Tree-wide sums: every surface that shows "the session's tokens" must
    // agree with this panel. tokens.main is the conversation-only figure.
    tree: {
      outputTokens: (u.outputTokens || 0) + (sub ? sub.outputTokens : 0),
      reasoningTokens: (u.reasoningTokens || 0) + (sub ? sub.reasoningTokens : 0),
      inputTokens: (u.inputTokens || 0) + (sub ? sub.inputTokens : 0),
      cacheRead: (u.cacheRead || 0) + (sub ? sub.cacheRead : 0),
    },
  };
}

function timingFields(rateRows) {
  if (!rateRows.length) return {};
  const a = Math.min(...rateRows.map((r) => r.startedAt ?? Infinity));
  const b = Math.max(...rateRows.map((r) => r.completedAt ?? 0));
  if (!(a != null && b != null && b > a)) return {};
  return {
    spanMs: b - a,
    busyMs: rateRows.reduce((sum, r) => sum + (r.genMs ?? r.ttftMs ?? 0), 0),
    otherMs: Math.max(0, b - a - rateRows.reduce((sum, r) => sum + (r.genMs ?? r.ttftMs ?? 0), 0)),
    requestBusyMs: rateRows.reduce(
      (sum, r) => sum + (r.completedAt != null && r.startedAt != null ? r.completedAt - r.startedAt : 0),
      0
    ),
  };
}

function modelBreakdown(usage, sub) {
  const byModel = new Map();
  const entry = (key, provider) => {
    let m = byModel.get(key);
    if (!m) {
      m = { model: key, provider, requests: 0, subagentRequests: 0, outputTokens: 0, reasoningTokens: 0, tokPerSecSum: 0, rated: 0 };
      byModel.set(key, m);
    }
    return m;
  };
  for (const r of usage) {
    const m = entry(r.model || "(unknown)", providerLabel(r.providerId, r.model));
    m.requests += 1;
    m.outputTokens += r.outputTokens || 0;
    m.reasoningTokens += r.reasoningTokens || 0;
    if (r.tokPerSec != null) { m.tokPerSecSum += r.tokPerSec; m.rated += 1; }
  }
  for (const sm of sub ? sub.models || [] : []) {
    const m = entry(sm.model, sm.provider);
    m.requests += sm.requests || 0;
    m.subagentRequests += sm.requests || 0;
    m.outputTokens += sm.outputTokens || 0;
    m.reasoningTokens += sm.reasoningTokens || 0;
    m.tokPerSecSum += sm.rateSum || 0;
    m.rated += sm.rated || 0;
  }
  const models = Array.from(byModel.values()).map((m) => {
    const generated = m.outputTokens + m.reasoningTokens;
    return {
      model: m.model,
      provider: m.provider,
      requests: m.requests,
      subagentRequests: m.subagentRequests,
      outputTokens: m.outputTokens,
      reasoningTokens: m.reasoningTokens,
      generated,
      avgTps: m.rated ? round1(m.tokPerSecSum / m.rated) : null,
    };
  });
  const totalGenerated = models.reduce((sum, m) => sum + m.generated, 0);
  for (const m of models) m.share = totalGenerated > 0 ? round1((m.generated / totalGenerated) * 100) : 0;
  return models.sort((x, y) => y.share - x.share || y.generated - x.generated || String(x.model).localeCompare(String(y.model)));
}

// TWO SCOPES LIVE IN THIS OBJECT, deliberately: the conversation's own rates,
// spans and busy times, and the SESSION TREE's tokens and models. See the
// tokenPanel split for why the panel must reconcile with the app's card.
export function sessionAggregateFrom(rateRows, opts = {}) {
  const agg = aggregate(rateRows);
  // The usage basis is the conversation's own rows (main_turn plus its
  // compaction/title requests). Fall back to the rate rows when absent.
  const usage = Array.isArray(opts.usage) && opts.usage.length ? opts.usage : rateRows;
  const u = aggregate(usage);
  const sub = opts.subagents || null;
  const { panel, tree } = tokenPanel(u, sub);
  agg.tokens = panel;
  Object.assign(agg, tree);
  Object.assign(agg, timingFields(rateRows));
  agg.models = modelBreakdown(usage, sub);
  agg.modelCount = agg.models.length;
  return agg;
}

export function fullSnapshot(db, requestedSid, opts = {}) {
  return sessionSnapshot(db, requestedSid, opts);
}
