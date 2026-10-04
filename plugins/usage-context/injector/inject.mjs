#!/usr/bin/env node
// usage-context injector — attaches to the running ZCode desktop app over its
// local CDP port and adds per-turn usage chips to each assistant turn's footer,
// to the right of the timestamp:
//
//     04:46 AM   |   [ 🗄 Usage 729K tok ]  [ ⏱ Ran for 43s ]
//                ^ transparent divider, then the chips
//
// Hovering either chip opens a panel with the turn's full token accounting,
// read from ZCode's own `turn_usage` table.
//
// WHY THIS SHARES stats-composer's SERVER
// -------------------------------------------------------------------------
// Per the "one server per plugin, and reuse beats duplication" rule: this
// plugin does NOT open the usage DB and does NOT bind a port. It reads
// per-turn usage over HTTP from the stats-composer sidecar's /turn endpoint
// (default 127.0.0.1:7427), which already opens the DB read-only with its
// background refresher, DB-change gate and idle cutoff. So enabling this
// plugin adds NO second server process and NO second DB reader — only a
// second *injector* (a small CDP client), which is cheap and, unlike a port
// bind, cannot collide. If stats-composer is not installed/running, this
// plugin simply renders nothing (and says so via /health-free logging).
//
// Run:  node injector/inject.mjs [--port 9229] [--sidecar-port 7427] [--once]

process.removeAllListeners("warning");
process.on("warning", () => {});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN_DIR = path.join(os.homedir(), ".zcode", "usage-context");
const CONFIG_FILE = path.join(os.homedir(), ".zcode", "stats-composer", "config.json");
const SC_PORT_FILE = path.join(os.homedir(), ".zcode", "stats-composer", "port");
const LOCK_FILE = path.join(RUN_DIR, "injector.lock");
const DEFAULT_SIDECAR = 7427;

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : dflt;
};
const CDP_PORT = argOf("--port", 9229);
const SIDECAR_PORT = argOf("--sidecar-port", sidecarPort());
const ONCE = args.includes("--once");

// Prefer the sidecar's own port file (it is the authoritative record of where
// the running sidecar actually listens), then the configured default. This is
// what lets the plugin track a user who changed stats-composer's port.
function sidecarPort() {
  try {
    const p = Number(fs.readFileSync(SC_PORT_FILE, "utf8").trim());
    if (p) return p;
  } catch {}
  return Number(readConfig().sidecarPort) || DEFAULT_SIDECAR;
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}
const log = (...a) => console.log("[usage-context-injector]", ...a);

// --- minimal CDP client (browser-level + Target.attachToTarget, flatten) ----
//
// Same approach as stats-composer's injector, and deliberately so: a page's own
// webSocketDebuggerUrl admits ONE debugger client, so two plugins talking to
// page sockets would block each other. The BROWSER endpoint multiplexes many
// flattened sessions over one connection — verified live that three concurrent
// browser-level attaches all evaluate successfully while stats-composer's own
// injector is attached. That is what lets these two plugins coexist.

let WS_IMPL;
async function wsClient(url) {
  if (!WS_IMPL) {
    try { WS_IMPL = (await import("ws")).WebSocket; }
    catch { WS_IMPL = globalThis.WebSocket; }
  }
  if (!WS_IMPL) throw new Error("no WebSocket implementation available");
  const ws = new WS_IMPL(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ws open timeout")), 4000);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("ws error")); }, { once: true });
  });
  return ws;
}

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
  if (!r.ok) throw new Error(url + " -> " + r.status);
  return r.json();
}

function wsSend(ws, method, params, msgId, sessionId) {
  return new Promise((resolve, reject) => {
    const onMsg = (raw) => {
      let m;
      try { m = JSON.parse(raw.data); } catch { return; }
      if (m.id === msgId) {
        ws.removeEventListener("message", onMsg);
        if (m.error) reject(new Error(JSON.stringify(m.error)));
        else resolve(m.result);
      }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify(sessionId ? { id: msgId, method, params, sessionId } : { id: msgId, method, params }));
  });
}

// The renderer is the app page that carries the zcode preload bridge. Guarding
// on this keeps the injector off foreign pages (devtools, embedded browsers).
const APP_TARGET_RE = (u) =>
  /^file:\/\/.*app\.asar.*renderer\/index\.html/.test(u) || /^file:\/\/.*index\.html/.test(u);

function appContextProbeJs() {
  return `(() => { try { return JSON.stringify({ bridge: typeof window.zcode === 'object' && window.zcode !== null }); } catch (e) { return JSON.stringify({ bridge: false }); } })()`;
}

// ---------------------------------------------------------------------------
// The page script
// ---------------------------------------------------------------------------

const PAGE_JS = `
(function () {
  // S.version is bumped when PAGE_JS changes materially; the document singleton
  // makes a re-injection REPLACE the running generation instead of orphaning it.
  // 8: the Turn time panel's header no longer repeats its only row's figure.
  // 9: the sidecar port is part of the generation identity, so a generation
  //    left polling a stale port is superseded instead of answering 'already'.
  var VERSION = '9';
  var EPOCH = Math.random().toString(36).slice(2, 10);
  var SIDECAR = 'http://127.0.0.1:__SIDECAR_PORT__';
  // The sidecar port is part of the generation identity (see aliveHere). Baked
  // in at launch, so it also identifies which sidecar this generation talks to.
  var PORT = SIDECAR.slice(SIDECAR.lastIndexOf(':') + 1);
  var S = (window.__usageContext = window.__usageContext || { version: null, epoch: null, port: null, timer: null, handlers: null, hovering: null });

  // A generation is only "alive" if it is this build AND pointed at the same
  // sidecar port. Port is part of the identity so a generation left running
  // against a stale/absent port (e.g. a manual or test injector started with a
  // different --sidecar-port) can be superseded by a correct one — otherwise the
  // guard answers 'already', the broken generation keeps polling a dead port,
  // and the chips stay at "—" until the page is reloaded. A build from before
  // this field existed has S.port undefined, so it re-injects once to upgrade.
  var aliveHere = S.version === VERSION && S.port === PORT && S.epoch !== null && S.dead !== true;
  if (aliveHere) return 'already';
  S.dead = true;
  S.version = VERSION;
  S.port = PORT;
  S.epoch = EPOCH;
  S.hovering = null;
  S.dead = false;

  // A previous generation's nodes are invisible to this generation's chip map
  // (that map is closure-local), so a re-injection would otherwise append a
  // second wrap to every footer. Sweep the DOM clean first — the nodes are
  // tagged, so this is unambiguous and idempotent.
  (function () {
    var old = document.querySelectorAll('.uc-wrap, .uc-card-host');
    for (var i = 0; i < old.length; i++) { try { old[i].remove(); } catch (e) {} }
  })();

  var state = { byMsg: null, sessionId: null, fetchedAt: 0, lastErr: null };
  // Chips we have created, keyed by the turn's data-turn-id. Kept so a re-render
  // patches text in place (never replaces nodes under the cursor).
  var chips = new Map();
  var cardEl = null, cardHost = null;
  var owner = function () { return S.epoch === EPOCH && S.version === VERSION; };

  // ---- formatting (mirrors the app's own usage panel wording) ----
  // The chip is a glance ("729K tok"); the hover card is where the exact figure
  // belongs ("728,661 tok") — the app's own panels show full precision, so the
  // two formatters are deliberately different.
  function fmtTok(v) {
    if (v == null) return '—';
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M tok';
    if (v >= 1e3) return Math.round(v / 1e3) + 'K tok';
    return v + ' tok';
  }
  function fmtTokExact(v) { return v == null ? '—' : Math.round(v).toLocaleString('en-US') + ' tok'; }
  function fmtCount(v) { return v == null ? '—' : String(v); }
  function fmtDur(ms) {
    if (ms == null) return '—';
    if (ms >= 3600000) { var h = Math.floor(ms / 3600000), m = Math.round((ms % 3600000) / 60000); return h + 'h ' + m + 'm'; }
    if (ms >= 60000) { var mm = Math.floor(ms / 60000), s = Math.round((ms % 60000) / 1000); return mm + 'm ' + s + 's'; }
    if (ms >= 1000) return Math.round(ms / 1000) + 's';
    return Math.round(ms) + 'ms';
  }

  // ---- find the active session + turn footers ----
  // The composer pane carries data-session-id (a real sess_… id, or "draft" for
  // an unsent chat). Each assistant turn carries data-turn-id, whose value is
  // turn_usage.user_message_id — that is the join key.
  function currentSession() {
    try {
      var n = document.querySelector('[data-session-id]');
      var v = n && n.getAttribute('data-session-id');
      if (!v || v === 'draft' || !/^sess_/.test(v)) return null;
      return v;
    } catch (e) { return null; }
  }

  // Every element carrying data-turn-id that ALSO has a timestamp row: that is
  // the assistant-turn footer (the app renders several wrappers with the same
  // id; only the footer has the time span we anchor to).
  function turnFooters() {
    var out = [];
    var nodes = document.querySelectorAll('[data-turn-id]');
    for (var i = 0; i < nodes.length; i++) {
      var turnId = nodes[i].getAttribute('data-turn-id');
      if (!turnId || !/^msg_/.test(turnId)) continue;
      var row = timeRow(nodes[i]);
      if (row) out.push({ turnId: turnId, row: row, node: nodes[i] });
    }
    return out;
  }

  function isTimeText(t) { return /^\\d{1,2}:\\d{2}\\s?(AM|PM)$/.test((t || '').trim()); }

  // The footer row = the nearest ancestor row containing a bare timestamp span.
  function timeRow(scope) {
    var spans = scope.querySelectorAll('span');
    for (var i = 0; i < spans.length; i++) {
      if (isTimeText(spans[i].textContent) && spans[i].children.length === 0) {
        var r = spans[i].parentElement;
        if (r && r.children.length >= 2) return r;
      }
    }
    return null;
  }

  // ---- chips ----
  function ensureChips(entry) {
    var row = entry.row;
    var key = entry.turnId;
    var rec = chips.get(key);
    // A footer can be re-created by the app's reconciliation; if our node left
    // the document, rebuild it (a detached chip's text is invisible).
    if (rec && rec.wrap && rec.wrap.isConnected && rec.wrap.parentElement === row) return rec;
    var wrap = document.createElement('span');
    wrap.className = 'uc-wrap';
    wrap.setAttribute('data-uc-for', key);
    wrap.innerHTML =
      '<span class="uc-div" aria-hidden="true"></span>' +
      '<span class="uc-chip uc-usage" tabindex="0">' +
        '<span class="uc-ico">\\u{1F5C4}</span><span class="uc-lbl">Usage</span> <span class="uc-val uc-usage-val">—</span>' +
      '</span>' +
      '<span class="uc-chip uc-time" tabindex="0">' +
        '<span class="uc-ico">\\u{23F1}</span><span class="uc-lbl">Ran for</span> <span class="uc-val uc-time-val">—</span>' +
      '</span>';
    // Place to the RIGHT of the timestamp span, which is the row's last child.
    row.appendChild(wrap);
    rec = { wrap: wrap, usageVal: wrap.querySelector('.uc-usage-val'), timeVal: wrap.querySelector('.uc-time-val'), chipUsage: wrap.querySelector('.uc-usage'), chipTime: wrap.querySelector('.uc-time'), data: null };
    chips.set(key, rec);
    return rec;
  }

  function paint(entry) {
    var rec = ensureChips(entry);
    var t = state.byMsg && state.byMsg[entry.turnId];
    rec.data = t || null;
    var uv = t ? fmtTok(t.totalTokens) : '—';
    var tv = t ? fmtDur(t.durationMs) : '—';
    if (rec.usageVal.textContent !== uv) rec.usageVal.textContent = uv;
    if (rec.timeVal.textContent !== tv) rec.timeVal.textContent = tv;
    rec.wrap.classList.toggle('uc-unknown', !t);
  }

  function renderAll() {
    if (!owner()) return;
    var footers = turnFooters();
    var seen = {};
    for (var i = 0; i < footers.length; i++) {
      seen[footers[i].turnId] = 1;
      paint(footers[i]);
    }
    // Drop chips whose turn scrolled out of the DOM.
    chips.forEach(function (rec, key) {
      if (!seen[key] && rec.wrap && rec.wrap.isConnected) rec.wrap.remove();
    });
    if (cardEl && S.hovering && state.byMsg) fillCard(cardEl, S.hovering, S.hoveringChip || 'usage');
  }

  // ---- hover card ----
  function ensureCard() {
    if (cardEl && cardEl.isConnected) return cardEl;
    var host = document.createElement('div');
    host.className = 'uc-card-host';
    host.style.cssText = 'position:fixed;z-index:2147483000;left:0;top:0;width:0;height:0;';
    document.body.appendChild(host);
    var c = document.createElement('div');
    c.className = 'uc-card';
    c.style.display = 'none';
    host.appendChild(c);
    cardEl = c; cardHost = host;
    return c;
  }

  function fillCard(c, key, whichChip) {
    var t = state.byMsg && state.byMsg[key];
    // Which chip is hovered decides the panel: the app shows a "Turn usage"
    // card for the token chip and a separate "Turn time and speed" card for the
    // clock chip (images 2 and 3), so the two are distinct panels, not one.
    var which = whichChip;
    if (!t) {
      // Empty state: the usage card can show its "—" total in the header (that
      // is the only place the total ever appears), but the time card's header
      // carries no value — see below.
      c.innerHTML = header(which, which === 'time' ? null : '—');
      return;
    }
    var model = t.model || '—';
    if (which === 'time') {
      // The time card holds ONE figure, "Total run time", so the header shows
      // only the title. Printing the duration in the header too would state the
      // same number twice in a two-line card, which reads as a mistake.
      c.innerHTML =
        header(which, null) +
        '<div class="uc-sep"></div>' +
        row('Total run time', fmtDur(t.durationMs));
      return;
    }
    // Turn usage (image 2): header total — the only place the total is shown —
    // then the same rows the app shows.
    c.innerHTML =
      header(which, fmtTokExact(t.totalTokens)) +
      '<div class="uc-sep"></div>' +
      row('Provider / model', model) +
      row('Uncached input', fmtTokExact(t.uncachedTokens)) +
      row('Output', fmtTokExact(t.outputTokens));
  }
  // Card header. The value is optional: pass null to render the title alone
  // (the time card), or a string to render the title with its right figure.
  function header(which, value) {
    var icon = which === 'time' ? '\\u{23F1}' : '\\u{1F5C4}';
    var title = which === 'time' ? 'Turn time and speed' : 'Turn usage';
    return '<div class="uc-ch"><span class="uc-ct"><span class="uc-cico">' + icon + '</span> ' + title + '</span>' +
      (value == null ? '' : '<span class="uc-cv">' + value + '</span>') + '</div>';
  }
  function row(k, v) {
    return '<div class="uc-cr"><span class="uc-cd"></span><span class="uc-cl">' + k + '</span><span class="uc-cvv">' + v + '</span></div>';
  }

  // Anchor on the chip that was actually hovered (passed in), so the panel
  // centres over THAT chip rather than the whole wrap. On a repaint the anchor
  // is re-derived from the live :hover state.
  function positionCard(c, anchor) {
    if (!cardHost || !cardHost.isConnected) return;
    var chip = anchor && anchor.isConnected ? anchor : null;
    if (!chip) chip = document.querySelector('.uc-chip:hover');
    if (!chip) {
      chips.forEach(function (rec, key) {
        if (!chip && key === S.hovering && rec.wrap) chip = rec.wrap.querySelector('.uc-chip') || rec.wrap;
      });
    }
    var target = chip || cardHost;
    var r = target.getBoundingClientRect();
    c.style.visibility = 'hidden';
    c.style.display = 'block';
    var w = c.offsetWidth, h = c.offsetHeight;
    var place = function (left, top) { cardHost.style.left = Math.round(left) + 'px'; cardHost.style.top = Math.round(top) + 'px'; };
    var centered = r.left + r.width / 2 - w / 2;
    var x = Math.min(Math.max(8, centered), Math.max(8, window.innerWidth - w - 8));
    var y = r.top - h - 2;
    if (y < 8) y = Math.min(r.bottom + 2, window.innerHeight - h - 8);
    place(x, Math.max(8, y));
    var got = c.getBoundingClientRect();
    var dx = x - got.left, dy = Math.max(8, y) - got.top;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
      place(parseFloat(cardHost.style.left) + dx, parseFloat(cardHost.style.top) + dy);
    }
    c.style.visibility = 'visible';
  }

  function showCard(key, which, anchor) {
    if (!state.byMsg || !state.byMsg[key]) return;   // never present a card of dashes
    var c = ensureCard();
    S.hovering = key;
    S.hoveringChip = which || 'usage';
    fillCard(c, key, which || 'usage');
    positionCard(c, anchor);
    c.style.display = 'block';
  }
  function hideCard() {
    if (cardEl) cardEl.style.display = 'none';
    S.hovering = null;
  }
  S.handlers = { show: showCard, hide: hideCard };

  // Returns { key, which, chip } for the chip under the pointer, or null. The
  // which field is 'time' for the Ran-for chip and 'usage' otherwise, so the
  // hover panel can be the app's own "Turn time and speed" vs "Turn usage" card.
  function chipFromEvent(e) {
    var p = (e.composedPath && e.composedPath()) || [];
    for (var i = 0; i < p.length; i++) {
      var n = p[i];
      if (n && n.classList && n.classList.contains('uc-chip')) {
        var wrap = n.closest ? n.closest('.uc-wrap') : null;
        if (wrap) return { key: wrap.getAttribute('data-uc-for'), which: n.classList.contains('uc-time') ? 'time' : 'usage', chip: n };
      }
    }
    return null;
  }
  document.addEventListener('pointerover', function (e) {
    if (!owner()) return;
    var hit = chipFromEvent(e);
    if (hit) showCard(hit.key, hit.which, hit.chip);
    else if (S.hovering) hideCard();
  }, true);
  document.addEventListener('pointerout', function (e) {
    if (!owner()) return;
    var hit = chipFromEvent(e);
    var to = e.relatedTarget;
    var intoCard = false;
    if (to) { var p = cardHost && cardHost.contains ? cardHost.contains(to) : false; intoCard = !!p; }
    if (!hit && !intoCard && S.hovering) hideCard();
  }, true);

  // ---- data ----
  function load() {
    var sid = currentSession();
    if (!sid) { state.byMsg = null; state.sessionId = null; renderAll(); return; }
    fetch(SIDECAR + '/turn?session=' + encodeURIComponent(sid), { signal: AbortSignal.timeout(8000) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.turns) { state.byMsg = null; state.lastErr = 'no turns'; return renderAll(); }
        var map = {};
        for (var i = 0; i < j.turns.length; i++) {
          var t = j.turns[i];
          if (t.userMessageId) map[t.userMessageId] = t;
        }
        state.byMsg = map; state.sessionId = j.sessionId; state.fetchedAt = Date.now(); state.lastErr = null;
        renderAll();
      })
      .catch(function (e) { state.lastErr = String((e && e.message) || e); renderAll(); });
  }

  // Poll: chips are cheap to repaint, and the underlying table only changes when
  // a turn completes, so a 2 s cadence keeps them current without churn.
  var POLL_MS = 2000;
  var running = false;
  function schedule(d) {
    if (running) return;
    running = true;
    S.timer = setTimeout(function () {
      S.timer = null;
      try { if (owner()) load(); }
      finally { running = false; if (owner() && S.timer === null) schedule(POLL_MS); }
    }, d || POLL_MS);
  }
  schedule(0);
  setInterval(function () { if (owner() && !running && !S.timer) schedule(POLL_MS); }, 5000);
  window.addEventListener('resize', function () { if (S.hovering) { var c = ensureCard(); positionCard(c); } }, { passive: true });
})();
`.replace(/__SIDECAR_PORT__/g, String(SIDECAR_PORT));

const CSS = `
.uc-wrap { display: inline-flex; align-items: center; gap: 2px; margin-left: 2px; }
.uc-div { width: 1px; align-self: stretch; margin: 2px 6px 2px 4px; background: transparent; border-left: 1px solid rgba(255,255,255,.14); display: inline-block; }
.uc-chip { display: inline-flex; align-items: center; gap: 5px; padding: 1px 7px; border-radius: 7px;
  font-size: var(--ui-font-size, 14px); line-height: 1.5; color: rgb(148 163 184);
  border: 1px solid rgb(255 255 255 / .10); background: rgb(255 255 255 / .03);
  font-variant-numeric: tabular-nums; cursor: default; user-select: none; white-space: nowrap; }
.uc-chip:hover { color: rgb(226 232 240); background: rgb(255 255 255 / .07); }
.uc-chip .uc-ico { opacity: .8; font-size: .92em; }
.uc-chip .uc-val { color: rgb(226 232 240); }
.uc-wrap.uc-unknown .uc-chip { opacity: .5; }
/* Hover card. Theme copied from the app's own usage panels (images 1-3):
   neutral #2b2b2b surface, 12px radius, 1px hairline, rows on a 6px rhythm,
   mono values, 60%-white labels. The host is a 0x0 fixed anchor at the chip, so
   the card must be position:absolute to escape that zero box and size to its
   content. */
.uc-card-host { position: fixed; z-index: 2147483000; }
/* The card sizes to its CONTENT, not a fixed width: a short turn gets a compact
   card, and a long provider/model string makes the card wider so the whole value
   is shown. width: max-content is what does the growing; the max-width is
   only a viewport guard for pathologically long text, and past that point the
   value WRAPS (below) instead of painting outside the surface. A fixed
   max-width with a nowrap value was the original defect: the box clamped to 30em
   while the glyphs kept going, so "Ollama Cloud/deepseek-v4.1-flash:cloud" ran
   out of the card. */
.uc-card { position: absolute; left: 0; top: 0; width: max-content;
  min-width: 17em; max-width: min(92vw, 46em);
  background: #2b2b2b; border: 1px solid rgba(255,255,255,.1); border-radius: 12px;
  padding: 12px; box-shadow: 0 8px 28px rgba(0,0,0,.45); color: #f8f8f8;
  font-family: var(--font-sans, system-ui, sans-serif); font-size: var(--ui-font-size, 14px);
  line-height: 1.6; }
.uc-ch { display: flex; justify-content: space-between; align-items: center; gap: 16px;
  margin-bottom: 10px; }
.uc-ct { font-weight: var(--font-weight-medium, 500); color: #f8f8f8; white-space: nowrap; }
.uc-cico { margin-right: 5px; }
.uc-ch .uc-cv { font-family: var(--font-mono, ui-monospace, monospace); color: rgba(248,248,248,.85);
  font-variant-numeric: tabular-nums; white-space: nowrap; flex: none; }
.uc-sep { height: 1px; background: rgba(255,255,255,.1); margin: 0 0 10px 0; }
.uc-cr { display: flex; align-items: baseline; gap: 10px; min-height: 1.6em; }
.uc-cd { width: .6em; height: .6em; border-radius: .3em; background: rgba(255,255,255,.28);
  flex: none; align-self: center; }
/* The label keeps its own width and never breaks ("Provider / model" stays on
   one line). The value fills the rest and is right-aligned so the values form a
   column; it wraps only when the card has hit its max-width, which is what keeps
   the text inside the surface in every case. white-space: normal is set
   explicitly because the value would otherwise inherit nowrap from the app. */
.uc-cl { flex: none; white-space: nowrap; color: rgba(248,248,248,.6); }
.uc-cvv { flex: 1 1 auto; min-width: 0; text-align: right; color: #f8f8f8;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-variant-numeric: tabular-nums; white-space: normal; overflow-wrap: anywhere; }
`;

// ---------------------------------------------------------------------------
// Injector loop
// ---------------------------------------------------------------------------

async function injectIntoTarget(ws, target, timed) {
  const attach = await timed("Target.attachToTarget", { targetId: target.id, flatten: true }, null, 8000);
  const sessionId = attach?.sessionId;
  if (!sessionId) throw new Error("attach returned no sessionId");
  try {
    const probe = await timed("Runtime.evaluate", { expression: appContextProbeJs(), returnByValue: true }, sessionId, 15000);
    let ctx = {};
    try { ctx = JSON.parse(probe?.result?.value ?? probe?.value ?? "{}"); } catch {}
    if (!ctx.bridge) return false;
    // The page script IS the expression (a self-contained IIFE), exactly as
    // stats-composer does it. Do NOT wrap it in "return <script>" — PAGE_JS
    // starts with a newline, so automatic semicolon insertion would turn
    // "return" into "return;" and the IIFE would never run (observed: styles
    // landed from the separate statement but window.__usageContext stayed
    // undefined and no chips appeared). The style element is injected as a
    // preceding statement instead.
    const js =
      "var __ucStyle=document.createElement('style');" +
      "__ucStyle.textContent=" + JSON.stringify(CSS) + ";" +
      "(document.head||document.documentElement).appendChild(__ucStyle);" +
      PAGE_JS;
    const res = await timed("Runtime.evaluate", { expression: js, returnByValue: true, awaitPromise: true }, sessionId, 20000);
    if (res?.exceptionDetails) {
      throw new Error(res.exceptionDetails.text || res.exceptionDetails.exception?.description || "evaluate failed");
    }
    return true;
  } finally {
    try { await timed("Target.detachFromTarget", { sessionId }, null, 2000); } catch {}
  }
}

function pidAlive(pid) {
  if (!pid || pid === process.pid) return pid === process.pid;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}
function readLock() {
  try {
    const l = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
    return { ...l, fresh: Date.now() - (l.ts || 0) < 45_000 };
  } catch { return null; }
}
function touchLock() {
  try {
    fs.mkdirSync(RUN_DIR, { recursive: true });
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, ts: Date.now() }));
  } catch {}
}
function claimLock() {
  const l = readLock();
  if (l && l.fresh && l.pid !== process.pid && pidAlive(l.pid)) return false;
  touchLock();
  return true;
}

async function main() {
  const ver = await getJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
  const browserWsUrl = ver?.webSocketDebuggerUrl;
  if (!browserWsUrl) throw new Error("no browser websocket url");
  const list = await getJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
  const targets = (Array.isArray(list) ? list : []).filter(
    (t) => t.type === "page" && APP_TARGET_RE(t.url || "")
  );
  if (!targets.length) return "no app targets";
  const ws = await wsClient(browserWsUrl);
  let id = 0;
  // Each CDP command is time-boxed so a half-closed socket cannot hang the
  // sweep. The timer is cleared as soon as the call settles: a leaked timer
  // would hold the event loop open for the whole budget, so a one-shot sweep
  // that finished in 200 ms would linger until its longest timeout expired
  // before the process could exit.
  const timed = (method, params, sessionId, budgetMs = 4000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("cdp timeout: " + method)), budgetMs);
      wsSend(ws, method, params, ++id, sessionId).then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); }
      );
    });
  let mounted = 0;
  try {
    for (const t of targets) {
      try { if (await injectIntoTarget(ws, t, timed)) mounted++; }
      catch (e) { log("target failed:", String(e.message || e)); }
    }
  } finally {
    try { ws.close(); } catch {}
  }
  return mounted ? `mounted on ${mounted} target(s)` : "no matching target";
}

let sweeping = false;
async function sweepOnce() {
  if (sweeping) return;
  if (!claimLock()) { log("another injector holds the lock — standing down"); process.exit(3); }
  sweeping = true;
  try { log(await main()); }
  catch (e) { log("sweep error:", String(e.message || e)); }
  finally { sweeping = false; }
}

const lockHeldFreshByOther = () => {
  const l = readLock();
  return !!l && l.fresh && l.pid !== process.pid && pidAlive(l.pid);
};

await (async () => {
  if (lockHeldFreshByOther()) { log("another injector holds the lock — standing down"); process.exit(3); }
  await sweepOnce();
})();

if (!ONCE) {
  setInterval(() => { sweepOnce().catch(() => {}); }, 10_000);
  setInterval(() => touchLock(), 15_000).unref();
  process.on("exit", () => { try { fs.unlinkSync(LOCK_FILE); } catch {} });
}
