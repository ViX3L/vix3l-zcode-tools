// Snapshot store: builds the in-memory stats snapshot on a background cadence
// and serves it from memory, so client count never multiplies DB cost.
//
// node:sqlite is synchronous; computing a snapshot inside a request handler
// blocked the event loop for ~120ms. One scan per interval, no matter how many
// readers, is the design.
import fs from "node:fs";
import { readOptions } from "../../scripts/lib/options.mjs";
import { statsComposerPortFile } from "../../scripts/lib/paths.mjs";
import {
  DASHBOARD_EXTRAS_IDLE_MS,
  DASHBOARD_EXTRAS_TTL_MS,
  SIDECAR_IDLE_MS,
} from "../../scripts/lib/constants.mjs";
import * as metrics from "../../scripts/lib/metrics.mjs";

const REQ_SORTS = {
  completedAt: (row) => row.completedAt ?? -Infinity,
  model: (row) => row.model ?? "",
  tokPerSec: (row) => row.tokPerSec ?? -Infinity,
  ttftMs: (row) => row.ttftMs ?? -Infinity,
  out: (row) => (row.outputTokens || 0) + (row.reasoningTokens || 0),
  cacheRead: (row) => row.cacheRead ?? -Infinity,
  status: (row) => row.status ?? "",
};

const SID_RE = /^sess_[A-Za-z0-9_-]+$/;

class SnapshotStore {
  constructor({ port, pluginVersion, onPortChanged }) {
    this.port = port;
    this.pluginVersion = pluginVersion;
    this.onPortChanged = onPortChanged;
    this.snapshot = null;
    this.snapshotError = null;
    this.fullExtras = null;
    this.fullExtrasAt = 0;
    this.fullExtrasDbv = null;
    this.extrasDemand = 0;
    this.allRequests = null;
    this.allRequestsSid = null;
    this.allRequestsDbv = null;
    this.requestedSid = null;
    this.lastDbVersion = null;
    this.lastOptionsKey = null;
    this.refreshes = 0;
    this.skips = 0;
    this.refreshLastMs = 0;
    this.refreshAvgMs = 0;
    this.lastDemand = 0;
    this.refresher = null;
    this.ticking = false;
    this.snapCache = {};
  }

  // Cheap change signal: the DB file's mtime/size plus its WAL. When neither
  // has moved, the previous snapshot is still correct and the scans are skipped.
  dbVersion() {
    try {
      const stat = fs.statSync(metrics.DB_PATH);
      let wal = 0;
      let walMtime = 0;
      try {
        const w = fs.statSync(`${metrics.DB_PATH}-wal`);
        wal = w.size;
        walMtime = w.mtimeMs;
      } catch { /* no WAL is a normal state, not an error */ }
      return `${stat.size}:${stat.mtimeMs}:${wal}:${walMtime}`;
    } catch {
      return "none";
    }
  }

  refreshFullExtras(db, snap, dbv) {
    if (!db || !snap || snap.error) return;
    try {
      const lastTurn = metrics.lastTurnStats(db, snap.sessionId);
      this.fullExtras = lastTurn ? { lastTurn } : {};
      this.fullExtrasAt = Date.now();
      this.fullExtrasDbv = dbv;
    } catch {
      // keep the last good extras rather than blanking the dashboard
    }
  }

  allRequestsForCurrentSession() {
    const sid = (this.snapshot && this.snapshot.sessionId) || null;
    const dbv = this.dbVersion();
    if (!sid) return [];
    if (this.allRequests && this.allRequestsSid === sid && this.allRequestsDbv === dbv) return this.allRequests;
    let db = null;
    try {
      db = metrics.openDb();
      this.allRequests = metrics.sessionRequests(db, sid);
      this.allRequestsSid = sid;
      this.allRequestsDbv = dbv;
    } catch {
      // keep the previous list rather than blanking the table
    } finally {
      try { db && db.close(); } catch { /* read-only handle: close is cleanup */ }
    }
    return this.allRequests || [];
  }

  // One page of the per-request table, sorted server-side over the FULL session
  // and then sliced, so "page 7 of 240" is real history.
  requestsPage(offset, limit, sortKey, desc) {
    const rows = this.allRequestsForCurrentSession();
    const key = REQ_SORTS[sortKey] ? sortKey : "completedAt";
    const pick = REQ_SORTS[key];
    const dir = desc ? -1 : 1;
    const sorted = rows.slice().sort((a, b) => {
      const av = pick(a);
      const bv = pick(b);
      const cmp = typeof av === "string" ? String(av).localeCompare(String(bv)) : av - bv;
      return cmp * dir;
    });
    const off = Math.max(0, Math.min(offset | 0, Math.max(0, sorted.length - 1)));
    const lim = Math.max(1, Math.min(limit | 0 || 10, 500));
    const pageRows = sorted
      .slice(off, off + lim)
      .map((row) => ({ ...row, out: (row.outputTokens || 0) + (row.reasoningTokens || 0) }));
    return {
      rows: pageRows,
      total: sorted.length,
      offset: off,
      limit: lim,
      sortKey: key,
      sortDesc: !!desc,
    };
  }

  requestSession(sid) {
    if (typeof sid !== "string" || !SID_RE.test(sid) || sid === this.requestedSid) return false;
    this.requestedSid = sid;
    return true; // caller forces a refresh so the switch is immediate
  }

  refresh(force) {
    const opts = readOptions();
    const optionsKey = `${opts.window}:${opts.live ? 1 : 0}`;
    if (optionsKey !== this.lastOptionsKey) {
      this.lastOptionsKey = optionsKey;
      force = true; // a changed setting must not wait for a DB write
    }
    if (!process.env.STATS_SIDECAR_PORT && opts.port !== this.port) {
      // A changed port cannot be applied to a listening server. Stand down and
      // remove the port file so the next hook starts the correct instance.
      try { fs.unlinkSync(statsComposerPortFile()); } catch { /* best effort */ }
      this.onPortChanged?.();
      return;
    }
    const scanVersion = this.dbVersion();
    if (!force && scanVersion !== "none" && scanVersion === this.lastDbVersion) {
      this.skips++;
      return;
    }
    // Record the version BEFORE the scan: a write during the scan then differs
    // on the next tick and triggers another refresh instead of being lost.
    this.lastDbVersion = scanVersion;
    this.refreshes++;
    const startedNs = process.hrtime.bigint();
    let db = null;
    try {
      db = metrics.openDb();
      const snap = metrics.sessionSnapshot(db, this.requestedSid, {
        window: opts.window,
        live: opts.live,
        cache: this.snapCache,
      });
      try {
        snap.turns = metrics.turnTotals(db, snap.sessionId);
      } catch {
        // older DB without turn_usage: leave it absent
      }
      snap.plugin = { name: "stats-composer", version: this.pluginVersion() };
      this.snapshot = snap;
      this.snapshotError = null;
      if (
        this.extrasDemand &&
        Date.now() - this.extrasDemand < DASHBOARD_EXTRAS_IDLE_MS &&
        this.fullExtrasAt &&
        Date.now() - this.fullExtrasAt > DASHBOARD_EXTRAS_TTL_MS
      ) {
        this.refreshFullExtras(db, snap, this.lastDbVersion);
      }
    } catch (error) {
      this.snapshotError = String((error && error.message) || error);
    } finally {
      try { db && db.close(); } catch { /* read-only handle: close is cleanup */ }
      this.refreshLastMs = Number(process.hrtime.bigint() - startedNs) / 1e6;
      this.refreshAvgMs = this.refreshAvgMs
        ? this.refreshAvgMs * 0.8 + this.refreshLastMs * 0.2
        : this.refreshLastMs;
    }
  }

  dashboardExtras() {
    this.extrasDemand = Date.now();
    if (this.fullExtras && Date.now() - this.fullExtrasAt < DASHBOARD_EXTRAS_TTL_MS) return this.fullExtras;
    if (!this.snapshot || this.snapshot.error) return this.fullExtras || {};
    let db = null;
    try {
      db = metrics.openDb();
      this.refreshFullExtras(db, this.snapshot, this.dbVersion());
    } catch {
      // keep the last good extras
    } finally {
      try { db && db.close(); } catch { /* read-only handle: close is cleanup */ }
    }
    return this.fullExtras || {};
  }

  snapshotJson() {
    if (!this.snapshot) this.refresh(true);
    if (this.snapshot) return this.snapshot;
    return { error: this.snapshotError || "no data", dbInfo: metrics.dbInfo() };
  }

  noteDemand() {
    this.lastDemand = Date.now();
  }

  // Refresh cadence follows demand: keep scanning while someone is reading,
  // and go quiet when nothing has asked for a while.
  start() {
    if (this.refresher) return;
    this.refresher = setInterval(() => {
      if (this.ticking) return;
      if (Date.now() - this.lastDemand > SIDECAR_IDLE_MS) return;
      this.ticking = true;
      try { this.refresh(false); } finally { this.ticking = false; }
    }, readOptions().refreshMs);
    this.refresher.unref?.();
  }

  stop() {
    if (this.refresher) clearInterval(this.refresher);
    this.refresher = null;
  }

  stats() {
    return {
      refreshes: this.refreshes,
      skips: this.skips,
      refreshLastMs: this.refreshLastMs,
      refreshAvgMs: this.refreshAvgMs,
      demandAge: Date.now() - this.lastDemand,
      extrasDbv: this.fullExtrasDbv,
    };
  }

  currentSessionId() {
    return this.requestedSid || (this.snapshot && this.snapshot.sessionId) || null;
  }
}

export function createSnapshotStore(options) {
  const store = new SnapshotStore(options);
  return {
    refresh: (force) => store.refresh(force),
    snapshotJson: () => store.snapshotJson(),
    dashboardExtras: () => store.dashboardExtras(),
    requestsPage: (...args) => store.requestsPage(...args),
    requestSession: (sid) => store.requestSession(sid),
    noteDemand: () => store.noteDemand(),
    prometheus: (snap) => prometheus(snap),
    currentSessionId: () => store.currentSessionId(),
    stats: () => store.stats(),
    start: () => store.start(),
    stop: () => store.stop(),
  };
}

function prometheus(snap) {
  const lines = [];
  const push = (name, help, value, labels = "") => {
    if (value == null || Number.isNaN(value)) return;
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name}${labels} ${value}`);
  };
  push("zcode_tps_last", "Last completed model request output tokens/sec", snap.last?.tokPerSec);
  push("zcode_ttft_last_ms", "Last completed request time-to-first-token (ms)", snap.last?.ttftMs);
  push(
    "zcode_tps_window_avg",
    `Average tok/s over last ${snap.window?.window ?? "?"} requests`,
    snap.window?.avgTps
  );
  push("zcode_tps_window_peak", "Peak tok/s in the recent window", snap.window?.peakTps);
  push("zcode_ttft_window_avg_ms", "Average TTFT over the recent window (ms)", snap.window?.avgTtftMs);
  push(
    "zcode_output_tokens_session_total",
    "Total output tokens this session",
    snap.session
      ? (snap.session.outputTokens || 0) + (snap.session.reasoningTokens || 0)
      : null
  );
  if (snap.live?.streaming) {
    push(
      "zcode_live_est_tps",
      "Estimated live tok/s (interpolated from last completed request)",
      snap.live.estTps
    );
    lines.push("# TYPE zcode_live_streaming gauge", "zcode_live_streaming 1");
  }
  return lines.join("\n") + "\n";
}
