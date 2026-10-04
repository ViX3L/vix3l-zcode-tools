#!/usr/bin/env node
// stats-composer injector — attaches to the running ZCode desktop app over
// its local remote-debugging (CDP) port and appends a lightweight stats pill
// to the composer toolbar, at the position the user marked: right after the
// leading cluster that contains the "+" button, i.e. the empty area between
// "+" and the model selector.
//
// Opt-in ("integration mode"): injection happens only when the app exposes a
// CDP port. On developer installs (non-packaged) the app enables port 9229
// automatically (env ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT=1 disables); on
// normal packaged installs the port is NOT open by default — launch the app
// once as  zcode --remote-debugging-port=9229  to use the composer pill.
// Without CDP the plugin stays in its zero-risk fallback (assistant-attached
// line / sidecar + dashboard), which is the default "auto" behavior.
//
// Run:  node injector/inject.mjs [--port 9229] [--sidecar-port 7427] [--once]
// Idempotent: the injected script exits early when its marker is present;
// the injector re-sweeps periodically so reloads / session switches re-attach.

process.removeAllListeners("warning");
process.on("warning", () => {});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const RUN_DIR = path.join(os.homedir(), ".zcode", "stats-composer");
const CONFIG_FILE = path.join(RUN_DIR, "config.json");
const DEFAULT_SIDECAR = 7427;

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : dflt;
};
const CDP_PORT = argOf("--port", 9229);
const SIDECAR_PORT = argOf("--sidecar-port", Number(readConfig().port) || DEFAULT_SIDECAR);
const ONCE = args.includes("--once");

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

const log = (...a) => console.log("[stats-composer-injector]", ...a);

// Attach-state file lets the hook (and doctor) know whether the pill channel
// is genuinely up, so the visible-stats ladder can fall back correctly when
// it is not. A stale file (older than 90s, i.e. >9 sweeps) counts as detached.
function writeAttachState(attached, reason) {
  try {
    fs.mkdirSync(RUN_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(RUN_DIR, "pill.json"),
      JSON.stringify({ attached: !!attached, reason: reason || "", ts: Date.now(), port: CDP_PORT, sidecar: SIDECAR_PORT })
    );
  } catch {}
}

// --- minimal CDP client over the /json + WebSocket endpoints -------------

let WS_IMPL;
async function wsClient(url) {
  if (!WS_IMPL) {
    try {
      WS_IMPL = (await import("ws")).WebSocket;
    } catch {
      WS_IMPL = globalThis.WebSocket; // Node >=22 ships a stable WebSocket
    }
  }
  if (!WS_IMPL) throw new Error("no WebSocket implementation available");
  const ws = new WS_IMPL(url);
  // CDP refuses frames sent before the handshake completes.
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ws open timeout")), 4000);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("ws error")); }, { once: true });
  });
  return ws;
}

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

// Find the app's page targets (the renderer holding the composer).
async function findTargets(port) {
  const list = await getJson(`http://127.0.0.1:${port}/json/list`);
  return (Array.isArray(list) ? list : []).filter(
    (t) => t.type === "page" && !/devtools|extension/.test(t.url || "")
  );
}

// Injection script. Runs inside the page; polls the sidecar over localhost
// and renders into a closed-off shadow root so app styles never bleed in.
//SIDECAR_PLACEHOLDER is replaced with the numeric sidecar port at launch.
const PILL_JS = `
(function () {
  // VERSION is bumped when PILL_JS changes materially; EPOCH is unique per
  // run of this script. The app's React reconciliation copies DOM nodes
  // without their JS expandos, so an expando is NOT a reliable ownership mark
  // (observed: the live node lost __owner while keeping our shadow root, which
  // made every poller treat it as foreign and rebuild it). Ownership is
  // therefore the document singleton, and the EPOCH is the generation id.
  var VERSION = '36';
  var EPOCH = Math.random().toString(36).slice(2, 10);
  // Document singleton: exactly one poller and one generation identity exist
  // per page, so a re-injection REPLACES the running generation instead of
  // leaving an orphan behind (the bug class that produced live-but-empty pills
  // and a sidecar hammered by dead generations).
  var S = (window.__tpsStats = window.__tpsStats || { version: null, epoch: null, timer: null, handlers: null, hovering: false });
  var aliveHere = S.version === VERSION && S.epoch !== null && S.dead !== true;
  if (aliveHere) return 'already';
  // Supersede: mark the old generation dead, then claim the singleton.
  S.dead = true;
  S.version = VERSION;
  S.epoch = EPOCH;
  S.hovering = false;
  S.timer = null;
  S.dead = false;
  var oldMarker = document.querySelector('.zcode-stats-pill-marker');
  if (oldMarker) oldMarker.remove();
  // Older builds used an id'd host, and the app strips such nodes anyway, so
  // make sure none survives a version upgrade.
  document.querySelectorAll('#zcode-stats-pill').forEach((n) => n.remove());
  // The marker lives in <body> and is class-based for the same reason the host
  // is: an id'd node can be reclaimed by the app's reconciliation.
  const marker = document.createElement('div');
  marker.className = 'zcode-stats-pill-marker';
  marker.setAttribute('data-v', VERSION);
  marker.style.display = 'none';
  (document.body || document.documentElement).appendChild(marker);

  const SIDECAR = 'http://127.0.0.1:__SIDECAR_PORT__';
  const state = { tps: null, ttft: null, winAvg: null, streaming: false, model: '', snap: null, dead: false };
  let shadowHost = null;
  // Our host, found by class (never by id — see buildHost).
  function pillHost() {
    const nodes = document.querySelectorAll('.zcode-stats-pill-host');
    for (const n of nodes) if (n.style.display !== 'none') return n;
    return nodes[0] || null;
  }

  function fmtMs(v) { return v == null ? '—' : (v >= 10000 ? (v/1000).toFixed(1)+'s' : Math.round(v)+'ms'); }
  function fmtDur(v) { return v == null ? '—' : (v >= 60000 ? (v/60000).toFixed(1)+'m' : (v >= 10000 ? (v/1000).toFixed(1)+'s' : Math.round(v)+'ms')); }
  // Exact figures for the token panel, thousands-separated — the hover card is
  // where full precision belongs ("3,093,207 tok"), unlike the pill's rounding.
  function fmtTok(v) { return v == null ? '—' : Math.round(v).toLocaleString('en-US') + ' tok'; }

  // Static skeletons: only text nodes change afterwards, so hover tracking
  // survives streaming updates and React churn.
  const PILL_SKELETON =
    '<span class="bolt" aria-hidden="true">⚡</span>' +
    '<span class="dot" style="display:none"></span>' +
    '<span class="b">—</span><span class="u">tok/s</span>' +
    '<span class="sep" style="display:none">·</span><span class="t"></span>';
  // Visual theme copied from the app's own "Context windows" hover panel:
  // header title (14px) + mono value, a 6px-gap row grid with 8px rounded-square
  // blue bullets, and a top-bordered footer row for the summary figure.
  //
  // Rows are grouped so the two rate figures can never be confused: the pill's
  // big number is ONE request, while a card row is an AVERAGE. Each label says
  // which window it covers.
  //
  // Layout: the four rate rows span the FULL card width (label left, value flush
  // to the card's right edge), so the rates read as one clean list rather than a
  // squeezed column. Below them a horizontal rule, then a two-column block joined
  // by a SIDEWAYS rule (a 1px transparent hairline, never a filled block): the
  // time figures left, the turn/step context right. The token block and the
  // footer below are full width again.
  const CARD_SKELETON =
    '<div class="ch"><span class="ct"><span class="cico">⟳</span> Session statistics</span><span class="cv c-req">—</span></div>' +
    // Full-width rate rows.
    '<div class="crows">' +
      '<div class="cr g1"><span class="cd"></span><span class="cl">Latest request · TPS</span><span class="cv v-lasttps">—</span></div>' +
      '<div class="cr g1"><span class="cd"></span><span class="cl">Latest request · TTFT</span><span class="cv v-lastttft">—</span></div>' +
      '<div class="cr g2"><span class="cd"></span><span class="cl">Last <span class="cwin">10</span> · TPS</span><span class="cv v-tps">—</span></div>' +
      '<div class="cr g2"><span class="cd"></span><span class="cl">Last <span class="cwin2">10</span> · TTFT</span><span class="cv v-ttft">—</span></div>' +
    '</div>' +
    '<div class="cdiv"></div>' +
    // Two columns side by side, split by a vertical rule: time figures | turn context.
    '<div class="cmain">' +
      '<div class="ccol">' +
        '<div class="crows">' +
          '<div class="cr"><span class="cd"></span><span class="cl">LLM time</span><span class="cv v-llm">—</span></div>' +
          '<div class="cr"><span class="cd"></span><span class="cl">Tool time</span><span class="cv v-toolt">—</span></div>' +
        '</div>' +
      '</div>' +
      '<div class="cdivv" aria-hidden="true"></div>' +
      '<div class="ccol">' +
        '<div class="crows">' +
          '<div class="cr"><span class="cd"></span><span class="cl">Turns</span><span class="cv v-turns">—</span></div>' +
          '<div class="cr"><span class="cd"></span><span class="cl">Steps</span><span class="cv v-steps">—</span></div>' +
          '<div class="cr"><span class="cd"></span><span class="cl">Tool calls</span><span class="cv v-toolcalls">—</span></div>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div class="cdiv"></div>' +
    // Session token panel, the same figures as the app's own "Token usage"
    // card (image 1). The divider above is the one that "already exists".
    '<div class="crows">' +
      '<div class="cr"><span class="cd"></span><span class="cl">Token usage</span><span class="cv v-toktotal">—</span></div>' +
      '<div class="cr"><span class="cd"></span><span class="cl">Cache hit</span><span class="cv v-cachehit">—</span></div>' +
      '<div class="cr"><span class="cd"></span><span class="cl">Uncached input</span><span class="cv v-uncached">—</span></div>' +
      '<div class="cr"><span class="cd"></span><span class="cl">Cached input</span><span class="cv v-cached">—</span></div>' +
      '<div class="cr"><span class="cd"></span><span class="cl">Output</span><span class="cv v-output">—</span></div>' +
    '</div>' +
    '<div class="cfoot"><span class="cl">Average session rate</span><span class="cv c-avg">—</span></div>';

  function findToolbar() {
    return document.querySelector('[data-composer-leading-content], [data-composer-leading-actions]');
  }

  // The app's React reconciliation removes any node it did not create from the
  // composer area (observed: our host is detached within ~1s, repeatedly). So
  // we own exactly ONE host node for the life of the page and simply re-append
  // it whenever the app drops it. Re-appending the same object preserves its
  // shadow root, its listeners, and its last rendered text — recreating a node
  // instead (the earlier approach) is what left the pill showing dashes, since
  // every fresh copy started as an empty skeleton.
  let persistentHost = null;
  let observer = null;

  function ensurePill() {
    if (!owner()) { return false; } // superseded: this generation must stand down
    if (!persistentHost) persistentHost = buildHost();
    if (!persistentHost) return false;
    // Dispose of any other host: ours is the only one that may live. A host
    // stamped with a different epoch belongs to a generation that has already
    // stood down (its injector process exits, and its observer disconnects on
    // the ownership re-check), so removing it is safe and prevents hidden
    // fossils from accumulating across re-injections. An unstamped host is a
    // build we cannot attribute — hide it rather than detach it, because
    // detaching would provoke its own observer into an endless re-append fight.
    for (const node of document.querySelectorAll('.zcode-stats-pill-host, #zcode-stats-pill')) {
      if (node === persistentHost) { node.style.display = ''; continue; }
      if (node.getAttribute('data-epoch') && node.getAttribute('data-epoch') !== EPOCH) {
        try { node.remove(); } catch {}
      } else {
        node.style.display = 'none';
      }
    }
    if (!persistentHost.isConnected) {
      const toolbar = findToolbar();
      if (!toolbar) return false;
      toolbar.appendChild(persistentHost);
      applyCached();
    }
    shadowHost = persistentHost;
    return true;
  }

  // Ownership: the singleton names the generation currently allowed to drive
  // the pill. Every generation checks it before touching the DOM.
  function owner() { return S.epoch === EPOCH && S.version === VERSION; }

  // Watch for the app detaching our host and put it straight back, without
  // waiting for the next poll — a pill that vanishes for a second reads as a
  // bug even though the data is correct. Ownership is re-checked on every
  // callback: a superseded generation's observer must NOT resurrect its orphan
  // host (one observer per generation watches the same subtree — without this
  // check they fight, and the user sees whichever orphan comes first in
  // document order, typically an empty skeleton).
  function watchReattach() {
    if (observer) return;
    observer = new MutationObserver(() => {
      if (!persistentHost || persistentHost.isConnected) return;
      if (!owner()) { observer.disconnect(); observer = null; return; }
      const toolbar = findToolbar();
      if (!toolbar) return;
      toolbar.appendChild(persistentHost);
      applyCached();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // Build the host once: shadow root, style, pill and card skeletons.
  function buildHost() {
    const host = document.createElement('div');
    // NO id: the app's reconciliation discards unknown children of the
    // composer area that carry an id it does not know, but leaves class-only
    // nodes alone (verified live). A class is also unique enough to find
    // ourselves after the app moves the node around.
    host.className = 'zcode-stats-pill-host';
    // Stamp the owning generation so a later generation can tell a dead
    // generation's leftover host (a "fossil") from a build it cannot attribute.
    host.setAttribute('data-v', VERSION);
    host.setAttribute('data-epoch', EPOCH);
    // Participate in the app's own composer auto-collapse layout.
    host.setAttribute('data-composer-collapse-priority', '3');
    try { host.attachShadow({ mode: 'open' }); } catch (e) { return null; }
    const style = document.createElement('style');    style.textContent = [
      // Typography follows ZCode's own settings, not a hardcoded stack. The app
      // writes its base UI size as an inline custom property on :root
      // (--ui-font-size, 14px by default) — the Settings font-size control —
      // and exposes its font stacks and weight tokens the same way. Those
      // custom properties inherit into this shadow root (all: initial does
      // not reset custom properties), so reading them here makes the pill and
      // card track the app exactly, including its own type scale: the app's
      // text-ui-base equals --ui-font-size and its text-ui-sm is that
      // minus 2px (measured live). We mirror that scale so the plugin looks
      // native at any setting and grows/shrinks with the app rather than
      // breaking. Every fallback below is the observed default, so the pill
      // still renders correctly on a page without the app's variables.
      ':host { all: initial; display: inline-flex; align-items: center; position: relative;',
      ' --sc-base: var(--ui-font-size, 14px);',
      ' --sc-sm: calc(var(--sc-base) - 2px);',
      ' --sc-font: var(--font-sans, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif);',
      ' --sc-mono: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); }',
      '.pill { display: inline-flex; align-items: center; gap: 6px;',
      ' font-family: var(--sc-font); font-size: var(--sc-base);',
      ' font-weight: var(--font-weight-medium, 500); line-height: 1.2;',
      ' color: #9aa3b0; padding: 4px 8px; border-radius: 8px;',
      ' border: 1px solid transparent; font-variant-numeric: tabular-nums;',
      ' cursor: default; user-select: none; white-space: nowrap; }',
      '.pill:hover { background: rgba(255,255,255,.06); }',
      // Responsive fallback: when the composer row is too narrow to show the
      // numbers without colliding with the model selector, the pill shrinks to
      // just the ⚡ glyph. The full numbers stay reachable on hover (the card is
      // opened by the same host, so collapsing never hides the data — it only
      // moves it off the inline row).
      '.bolt { display: none; }',
      '.pill.min { gap: 4px; padding: 4px 6px; }',
      '.pill.min .bolt { display: inline; color: #e7ebf0; font-size: var(--sc-base); line-height: 1; }',
      '.pill.min .b, .pill.min .u, .pill.min .sep, .pill.min .t, .pill.min .dot { display: none !important; }',
      '.b { font-weight: var(--font-weight-semibold, 600); color: #e7ebf0; }',
      '.dot { width: 6px; height: 6px; border-radius: 50%; background: #4ade80;',
      ' animation: zc-pulse 1.2s ease-in-out infinite; }',
      '@keyframes zc-pulse { 0%,100% { opacity:.35 } 50% { opacity:1 } }',
      '.idle .dot { display: none; }',
      // Card: fixed-position panel ABOVE the pill. Values below are lifted from
      // the app's own "Context windows" hover card (read live off its computed
      // styles): neutral #2b2b2b surface, 12px radius, 1px rgba(255,255,255,.1)
      // hairline, rows on a 6px rhythm, rounded-square blue bullets, monospace
      // values, and 60%-white labels/subtitles. Text metrics and anything that
      // could clip are expressed in em/relative units so a font-size change
      // rescales the card instead of overflowing it.
      '.cardp { position: fixed; z-index: 2147483000; display: none; min-width: 24em;',
      ' background: #2b2b2b; border: 1px solid rgba(255,255,255,.1); border-radius: 12px;',
      ' padding: 12px; overflow: hidden; box-shadow: 0 8px 28px rgba(0,0,0,.45);',
      ' color: #f8f8f8;',
      ' font-family: var(--sc-font); font-size: var(--sc-sm);',
      ' font-weight: var(--font-weight-normal, 400); line-height: 1.6; }',
      '.cardp .ch { display: flex; justify-content: space-between; align-items: center; gap: 12px;',
      ' margin-bottom: 12px; }',
      '.cardp .ct { font-weight: var(--font-weight-medium, 500); font-size: var(--sc-base);',
      ' line-height: 1.4; color: #f8f8f8; }',
      '.cardp .cico { color: #4099ff; font-weight: var(--font-weight-semibold, 600); margin-right: 4px; }',
      '.cardp .ch .cv { font-family: var(--sc-mono);',
      ' color: rgba(248,248,248,.6); font-weight: var(--font-weight-normal, 400); }',
      '.cardp .cdiv { height: 1px; background: rgba(255,255,255,.1); margin: 10px 0; }',
      // Two columns inside .cmain only (the time figures and the turn context),
      // joined by a SIDEWAYS rule: a 1px element with a transparent background
      // and a left hairline border, so it separates without painting a block and
      // stretches to the taller column. Both columns split the width evenly.
      // The four rate rows are NOT in here — they are full-width rows above.
      '.cardp .cmain { display: flex; align-items: stretch; gap: 0; }',
      '.cardp .ccol { flex: 1 1 0; min-width: 0; }',
      '.cardp .cdivv { flex: none; width: 1px; margin: 0 12px; background: transparent;',
      ' border-left: 1px solid rgba(255,255,255,.1); }',
      '.cardp .cr { display: flex; align-items: center; gap: 8px; min-height: 1.6em; }',
      '.cardp .cd { width: .67em; height: .67em; border-radius: .33em; background: #4099ff; flex: none;',
      ' opacity: .45; }',
      // Graded bullet opacity, as in the app's own panel (measured there between
      // ~0.32 and ~0.79): the headline figures keep the strongest dot, secondary
      // ones fade back.
      '.cardp .cr.g1 .cd { opacity: .8; }',
      '.cardp .cr.g2 .cd { opacity: .45; }',
      // The label keeps its CONTENT width and never wraps ("Tool time" must stay
      // on one line even in the narrower two-column block); the value takes the
      // remaining space and is pushed to the right edge. A label with flex-basis
      // 0 gets an equal share of the column and wraps once the column is narrow —
      // which is what broke "Tool time" when the columns halved.
      '.cardp .cl { flex: none; white-space: nowrap; color: rgba(248,248,248,.6); }',
      '.cardp .cv { flex: 1 1 auto; min-width: 0; text-align: right; color: #f8f8f8;',
      ' font-family: var(--sc-mono); font-variant-numeric: tabular-nums; }',
      '.cardp .crows { display: grid; gap: 6px; }',
      '.cardp .cfoot { display: flex; align-items: center; justify-content: space-between; gap: 12px;',
      ' margin-top: 12px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,.1); }',
      '.cardp .cfoot .cl { flex: 1; min-width: 0; color: rgba(248,248,248,.6); }',
      '.cardp .cfoot .cv { color: #f8f8f8; }',
    ].join('');
    const pill = document.createElement('div');
    pill.className = 'pill idle';
    pill.innerHTML = PILL_SKELETON;
    const cardEl = document.createElement('div');
    cardEl.className = 'cardp';
    cardEl.innerHTML = CARD_SKELETON;
    host.shadowRoot.appendChild(style);
    host.shadowRoot.appendChild(pill);
    host.shadowRoot.appendChild(cardEl);
    return host;
  }

  // Paint the pill (and an open card) from the singleton's last snapshot.
  function applyCached() {
    const sc = S.cache;
    if (!sc) return;
    state.tps = sc.tps; state.ttft = sc.ttft; state.winAvg = sc.winAvg;
    state.streaming = sc.streaming; state.model = sc.model; state.snap = sc.snap;
    render();
  }

  // The app's React reconciliation can move or replace the pill host at any
  // moment, which kills any listener bolted onto it mid-hover and drops the
  // card. So hover is tracked at the document level, where the listeners
  // outlive the node.
  //
  // Listeners cannot be installed only once: the FIRST generation's closures
  // would then handle every later hover, and those closures reference that
  // generation's own DOM lookups (which a redesign may have changed, or which
  // may point at a since-removed node). Each generation installs its own
  // listeners and stamps S.trackingEpoch; an older listener notices the stamp
  // is no longer its own and retires itself on the next event.
  function hoverTracking() {
    S.handlers = { show: showCard, hide: hideCard };
    S.trackingEpoch = EPOCH;
    const myEpoch = EPOCH;
    const active = () => S.trackingEpoch === myEpoch;
    const hostFromEvent = (e) => {
      const path = (e.composedPath && e.composedPath()) || [];
      const host = pillHost();
      if (host && path.indexOf(host) !== -1) return host;
      return null;
    };
    document.addEventListener('pointerover', (e) => {
      if (!active()) return;
      const h = S.handlers;
      if (!h) return;
      if (hostFromEvent(e)) { S.hovering = true; h.show(); }
      else if (S.hovering) { S.hovering = false; h.hide(); }
    }, true);
    document.addEventListener('pointerout', (e) => {
      if (!active()) return;
      const h = S.handlers;
      if (!h) return;
      const host = pillHost();
      const stillInside = (e.composedPath && e.composedPath()).indexOf(host) !== -1 ||
        (e.relatedTarget && host && shadowContains(host, e.relatedTarget));
      // Only retract when the pointer truly left the pill and its card; the
      // card sits ABOVE the pill, so travelling up into it must not close it.
      if (!stillInside && S.hovering) { S.hovering = false; h.hide(); }
    }, true);
  }
  function shadowContains(host, node) {
    // Walk up through shadow roots via hosts to see whether the node
    // belongs to our pill's shadow tree (e.g. the pointer moved onto the card).
    let n = node;
    while (n) {
      if (n === host) return true;
      n = n.parentNode instanceof ShadowRoot ? n.parentNode.host : n.parentNode;
    }
    return false;
  }

  // Hover = presentation only. The card was already filled by the latest
  // tick (same principle as the app's own context panel: data prepared
  // ahead of time; hover never fetches, so it shows instantly).
  function showCard() {
    const c = shadowHost && shadowHost.shadowRoot && shadowHost.shadowRoot.querySelector('.cardp');
    if (!c) return; // host mid-replacement; the next tick re-asserts
    fillCard(c);
    // Never present a card of dashes: if no snapshot has landed yet (the very
    // first second after injection, or a fetch still in flight), keep the card
    // closed and let the next tick open it — a filled card is the promise the
    // hover makes.
    if (!state.snap) return;
    positionCard(c);
    c.style.display = 'block';
  }
  function hideCard() {
    const c = shadowHost && shadowHost.shadowRoot && shadowHost.shadowRoot.querySelector('.cardp');
    if (c) c.style.display = 'none';
  }

  // Position the card ABOVE the pill — matching how the app's context panel
  // pops above its anchor. Falls back below only when there is no room.
  //
  // Horizontal placement is CENTERED on the pill, which is what the app's own
  // "Context windows" panel does: measured live, its panel's center sits exactly
  // on its trigger's center (centerDelta 0, left/right deltas symmetric at ∓146),
  // and it leaves a 2px gap above the trigger. Left-aligning instead (the earlier
  // behaviour) reads as mismatched next to the app's own panel.
  //
  // The card is position:fixed, but the composer sits inside an ancestor with
  // a CSS transform, so for us "fixed" is resolved against that ancestor
  // rather than the viewport (a transform creates a containing block). Writing
  // viewport coordinates directly therefore lands the card in the wrong place
  // (observed: ~570px too low). So: set a first guess, measure where the card
  // actually ended up, and translate by the difference. The relationship is a
  // pure translation, so one correction is exact.
  function positionCard(cardEl) {
    const host = persistentHost || shadowHost;
    if (!host || !host.isConnected) return;
    const r = host.getBoundingClientRect();
    cardEl.style.visibility = 'hidden';
    cardEl.style.display = 'block';
    const w = cardEl.offsetWidth, h = cardEl.offsetHeight;
    const place = (left, top) => {
      cardEl.style.left = Math.round(left) + 'px';
      cardEl.style.top = Math.round(top) + 'px';
    };
    // Center on the pill, then keep the whole card on screen.
    const centered = r.left + r.width / 2 - w / 2;
    let x = Math.min(Math.max(8, centered), Math.max(8, window.innerWidth - w - 8));
    let y = r.top - h - 2; // above, 2px gap as in the app's own panel
    if (y < 8) y = Math.min(r.bottom + 2, window.innerHeight - h - 8); // below fallback
    place(x, Math.max(8, y));
    // Correct for the transformed containing block.
    const got = cardEl.getBoundingClientRect();
    const dx = x - got.left, dy = Math.max(8, y) - got.top;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
      place(parseFloat(cardEl.style.left) + dx, parseFloat(cardEl.style.top) + dy);
    }
    cardEl.style.visibility = 'visible';
  }

  // The session the app is CURRENTLY displaying. ZCode stamps the active
  // conversation pane with data-session-id (verified live); a brand-new chat
  // that has not been sent yet carries the literal "draft" (the app renders
  // t ?? "draft"). Distinguishing the two is what stops a new chat from
  // showing the PREVIOUS chat's numbers:
  //   { sid }        → a real session; scope the fetch to it
  //   { draft:true } → a new, empty chat; show no stats at all
  //   null           → no marker found; fall back to the sidecar's own default
  function currentSession() {
    try {
      const n = document.querySelector('[data-session-id]');
      const v = n && n.getAttribute('data-session-id');
      if (!v) return null;
      if (v === 'draft') return { draft: true };
      return /^sess_/.test(v) ? { sid: v } : { draft: true };
    } catch (e) { return null; }
  }

  async function loadNow() {
    try {
      // Generous timeout: the sidecar answers in ~1ms, but a busy renderer can
      // take a second or more to schedule this task's continuation, so a tight
      // budget (the earlier 1500ms) turned a healthy sidecar into dashes.
      const cur = currentSession();
      if (cur && cur.draft) {
        // New chat with no requests of its own. Clear to the empty state rather
        // than showing the last session's figures; the first message will give
        // this chat a real id and normal polling resumes.
        state.tps = null; state.ttft = null; state.winAvg = null;
        state.streaming = false; state.model = ''; state.snap = null;
        S.cache = null; S.lastErr = null; S.gotAt = Date.now();
        return render();
      }
      const sid = cur && cur.sid;
      const r = await fetch(SIDECAR + '/stats' + (sid ? ('?session=' + encodeURIComponent(sid)) : ''),
        { signal: AbortSignal.timeout(8000) });
      const s = await r.json();
      if (!s || s.error) { S.lastErr = 'sidecar:' + (s && s.error || 'empty'); return render(); }
      const live = s.live;
      const last = s.last;
      state.tps = live && live.streaming ? (live.estTps ?? (last && last.tokPerSec) ?? null) : ((last && last.tokPerSec) || null);
      state.ttft = last ? last.ttftMs : null;
      state.winAvg = s.window ? s.window.avgTps : null;
      state.streaming = !!(live && live.streaming);
      state.model = (last && last.model) || '';
      state.snap = s;
      // Publish to the singleton so a host re-created by the app's layout
      // churn can be painted instantly (see applyCached).
      S.cache = { tps: state.tps, ttft: state.ttft, winAvg: state.winAvg, streaming: state.streaming, model: state.model, snap: s };
      S.lastErr = null;
      S.gotAt = Date.now();
    } catch (e) { S.lastErr = 'fetch:' + String(e && e.message || e); } // keep last-good values
    render();
  }

  const setText = (el, v) => {
    if (!el) return;
    const t = v == null ? '' : String(v);
    if (el.firstChild) {
      if (el.firstChild.nodeValue !== t) el.firstChild.nodeValue = t;
    } else {
      el.appendChild(document.createTextNode(t));
    }
  };

  // Responsive fit. The composer row is: + button, access chip, [pill], then a
  // spacer, then the model selector. Our toolbar (flex min-w-0 flex-1) shrinks
  // as the window narrows, so at some width the full "310.1 tok/s · 1310ms"
  // stops fitting and
  // would collide with the model selector. Measure the free space in our row
  // and collapse the pill to the ⚡ glyph when the full form does not fit. The
  // full numbers stay one hover away (the card belongs to the same host), so
  // collapsing relocates data rather than hiding it.
  //
  // Measuring the full width needs the full form in the DOM, so when currently
  // collapsed we un-collapse, measure, then re-collapse. To keep that from
  // forcing a synchronous layout on every 700 ms tick, only re-evaluate when
  // the inputs actually change: the available width or the rendered text.
  function fitPill(pill) {
    if (!pill || !persistentHost || !persistentHost.isConnected) return;
    const row = persistentHost.parentElement;                       // flex min-w-0 flex-1
    if (!row) return;
    const lead = row.firstElementChild !== persistentHost ? row.firstElementChild : null;
    const leadW = lead ? lead.getBoundingClientRect().width : 0;
    const avail = Math.round(row.getBoundingClientRect().width - leadW - 8); // 8px breathing room
    const sig = avail + '|' + (state.tps != null ? state.tps : '-') + '|' +
      (state.ttft != null ? fmtMs(state.ttft) : '-');
    if (S.fitSig === sig) return; // nothing that affects the fit changed
    S.fitSig = sig;
    const wasMin = pill.classList.contains('min');
    if (wasMin) pill.classList.remove('min');                        // measure the full form
    const fullW = pill.getBoundingClientRect().width;
    const min = avail < fullW;
    pill.classList.toggle('min', min); // always re-assert: we un-collapsed to measure
    S.fit = { avail, fullW: Math.round(fullW), min };
  }

  function render() {
    // Write only into the host THIS generation owns: resolving by id could
    // pick up a look-alike node the app cloned (same id, no shadow root), and
    // a detached node's text is invisible.
    shadowHost = persistentHost;
    const sh = shadowHost && shadowHost.shadowRoot;
    if (!sh || !shadowHost.isConnected) { S.renderSkip = 'no-host'; return; }
    const pill = sh.querySelector('.pill');
    if (!pill) { S.renderSkip = 'no-pill'; return; }
    if (!pill.querySelector('.b')) pill.innerHTML = PILL_SKELETON; // heal
    // Text-only updates — element replace under the cursor breaks hover.
    const dot = sh.querySelector('.pill .dot'), b = sh.querySelector('.pill .b');
    const sep = sh.querySelector('.pill .sep'), t = sh.querySelector('.pill .t');
    if (!dot || !b || !sep || !t) { S.renderSkip = 'no-skeleton'; return; }
    S.renderSkip = null;
    dot.style.display = state.streaming ? '' : 'none';
    setText(b, state.tps != null ? state.tps : '—');
    // Tag every write with the writing generation, for live debugging of
    // multi-generation fights over one DOM node.
    S.lastWriter = EPOCH + ':' + (state.tps != null ? state.tps : 'null') + '@' + Date.now();
    sep.style.display = state.ttft != null ? '' : 'none';
    setText(t, state.ttft != null ? fmtMs(state.ttft) : '');
    pill.classList.toggle('idle', !state.streaming);
    const title = 'Session statistics' + (state.model ? (' · ' + state.model) : '') +
      (state.winAvg != null ? (' · last 10 avg ' + state.winAvg + ' tok/s') : '');
    if (pill.__title !== title) { pill.title = title; pill.__title = title; }
    fitPill(pill);
    // While hovering, keep the card open, current, and positioned — re-assert
    // each tick so host replacement (resets a fresh card to closed) reopens
    // without flicker. Only ever present a card that has data.
    const cardEl = sh.querySelector('.cardp');
    if (cardEl && S.hovering && state.snap) {
      fillCard(cardEl);
      if (cardEl.style.display !== 'block') cardEl.style.display = 'block';
      positionCard(cardEl);
    }
  }

  // Card values. Two families, deliberately labelled apart:
  //   "Latest request"  = the single newest completed request (same numbers the
  //                       pill shows, so pill and card always agree).
  //   "Last N" / session = averages over that many requests.
  // LLM time is the sum of request durations; Tool time is now MEASURED from
  // ZCode's own tool_usage table (sum of tool durations), not the old
  // span-minus-LLM estimate.
  function fillCard(c) {
    if (!c.querySelector('.v-llm')) c.innerHTML = CARD_SKELETON; // heal
    const snap = state.snap || {};
    const ss = snap.session;
    const win = snap.window;
    const v = (sel) => c.querySelector(sel);
    setText(v('.c-req'), ss ? ((ss.samples ?? 0) + ' requests') : '—');
    const w = (win && win.window) || 10;
    setText(v('.cwin'), String(w));
    setText(v('.cwin2'), String(w));
    // Turn/step context (the right column), from the sidecar's turn_usage
    // aggregate — the same figures ZCode's own turn panel shows. Independent of
    // the request-level session block, so it is filled before that guard.
    const tt = snap.turns;
    setText(v('.v-turns'), tt && tt.turns != null ? String(tt.turns) : '—');
    setText(v('.v-steps'), tt && tt.steps != null ? String(tt.steps) : '—');
    setText(v('.v-toolcalls'), tt && tt.toolCalls != null ? String(tt.toolCalls) : '—');
    if (!ss) return;
    // Latest single request — identical to the pill's own figures.
    const lastTps = state.tps != null ? state.tps : (snap.last && snap.last.tokPerSec);
    setText(v('.v-lasttps'), lastTps != null ? lastTps + ' tok/s' : '—');
    setText(v('.v-lastttft'), state.ttft != null ? fmtMs(state.ttft) : '—');
    // Window averages.
    setText(v('.v-tps'), win && win.avgTps != null ? win.avgTps + ' tok/s' : '—');
    setText(v('.v-ttft'), win && win.avgTtftMs != null ? fmtMs(win.avgTtftMs) : '—');
    // Session totals.
    setText(v('.v-llm'), ss.requestBusyMs != null ? fmtDur(ss.requestBusyMs) : '—');
    setText(
      v('.v-toolt'),
      ss.toolBusyMs != null ? fmtDur(ss.toolBusyMs) : (ss.otherMs != null ? fmtDur(ss.otherMs) : '—')
    );
    // Session token panel — the app's own "Token usage" figures.
    const tk = ss.tokens || {};
    setText(v('.v-toktotal'), tk.total != null ? fmtTok(tk.total) : '—');
    setText(v('.v-cachehit'), tk.cacheHitPct != null ? tk.cacheHitPct + '%' : '—');
    setText(v('.v-uncached'), tk.uncached != null ? fmtTok(tk.uncached) : '—');
    setText(v('.v-cached'), tk.cached != null ? fmtTok(tk.cached) : '—');
    setText(v('.v-output'), tk.output != null ? fmtTok(tk.output) : '—');
    setText(v('.c-avg'), ss.avgTps != null ? ss.avgTps + ' tok/s' : '—');
  }

  // Self-scheduling poller: the next poll is booked only after the previous
  // one settles. A congested renderer (this conversation alone keeps the main
  // thread busy for ~1s at a time) would otherwise stack overlapping fetches
  // every second, and each stacked fetch worsens the congestion.
  const POLL_MS = 700;
  let running = false; // guards against the watchdog double-scheduling mid-flight
  function schedule(delay) {
    if (running) return;
    running = true;
    S.timer = setTimeout(async () => {
      S.timer = null;
      try {
        if (!owner()) return; // superseded: stop for good
        await tick();
      } finally {
        running = false;
        if (owner() && S.timer === null) schedule(POLL_MS);
      }
    }, delay || POLL_MS);
  }
  async function tick() {
    if (!ensurePill()) return;
    if (!owner()) { state.dead = true; shadowHost = null; return; }
    await loadNow();
  }
  // Re-fit on window resize: the poll loop re-measures anyway, but a resize is
  // exactly when the composer width changes, so react at once rather than up to
  // 700 ms later. Clear the memo so the (possibly unchanged) numbers still get
  // re-evaluated against the new width.
  window.addEventListener('resize', () => { S.fitSig = null; }, { passive: true });
  state.dead = false;
  hoverTracking();
  watchReattach();
  schedule(0);
  // Watchdog: if the poll loop is ever lost (host churn, page restore) while
  // this generation still owns the singleton, resume it. The running flag
  // prevents stacking a second timer while a poll is still in flight — stacked
  // polls would each worsen the renderer congestion they are waiting on.
  setInterval(() => {
    if (owner() && !state.dead && !running && !S.timer) schedule(POLL_MS);
  }, 3000);
})();
`.replace(/__SIDECAR_PORT__/g, String(SIDECAR_PORT));

// A page target's own webSocketDebuggerUrl admits exactly ONE debugger
// client. The sidecar keeps a long-lived injector attached, so a second
// client (a manual `--once` run, the doctor, a re-sweep after a socket
// half-close) blocks forever on Runtime.enable with no error — the observed
// hang. So we never talk to a page socket: we open the BROWSER-level endpoint
// once and reach each page through Target.attachToTarget {flatten:true},
// which multiplexes many sessions over a single connection.
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

// Every CDP command is time-boxed: a page wedged in a modal state or a
// half-closed socket otherwise hangs the sweep forever, and the 10s
// re-sweep would never recover it.
function makeTimed(ws) {
  let id = 0;
  return (method, params, sessionId, budgetMs = 4000) =>
    Promise.race([
      wsSend(ws, method, params, ++id, sessionId),
      new Promise((_, rej) => setTimeout(() => rej(new Error("cdp timeout: " + method)), budgetMs)),
    ]);
}

async function injectIntoTarget(ws, target, timed) {
  // Attach, evaluate in the page, then detach so the target is left free for
  // other tooling (devtools, the doctor) as soon as this sweep ends.
  const attach = await timed("Target.attachToTarget", { targetId: target.id, flatten: true }, null, 8000);
  const sessionId = attach?.sessionId;
  if (!sessionId) throw new Error("attach returned no sessionId");
  try {
    // No Runtime.enable: on a busy renderer it can take many seconds and its
    // result is not needed — Runtime.evaluate reports exceptionDetails on its
    // own. Skipping it removes an entire class of slow-page hangs.
    // Budgets are generous: the app's main thread can be busy for a second or
    // more rendering a long conversation, so a tight timeout rejects work the
    // page would happily have done (observed: a 4s probe budget on a page
    // whose tasks ran ~8s). A sweep taking ~30s is fine; the sweep interval
    // honors the lock, so it never overlaps itself.
    // Runtime identity check: only mount the pill if this page really is the
    // app's renderer (has the zcode preload bridge). Foreign pages are skipped.
    const probe = await timed(
      "Runtime.evaluate",
      { expression: appContextProbeJs(), returnByValue: true },
      sessionId,
      15000
    );
    // Flattened sessions resolve with the CDP "result" object directly
    // ({type, value} for returnByValue evaluates), so the probe value is
    // probe.value — not probe.result.result.value.
    const ctx = (() => {
      try { return JSON.parse(probe?.result?.value ?? probe?.value ?? "{}"); } catch { return {}; }
    })();
    if (!ctx.bridge) {
      log("skipping target without zcode bridge:", (target.url || "").slice(0, 70));
      return false;
    }
    const res = await timed(
      "Runtime.evaluate",
      { expression: PILL_JS, returnByValue: true, awaitPromise: true },
      sessionId,
      30000
    );
    if (res?.exceptionDetails) {
      throw new Error(res.exceptionDetails.text || res.exceptionDetails.exception?.description || "evaluate failed");
    }
    return true; // "already" still counts: pill present
  } finally {
    try { await timed("Target.detachFromTarget", { sessionId }, null, 2000); } catch {}
  }
}

// Only attach to the ZCode app's own renderer windows. The app loads its UI
// via loadFile(.../out/renderer/<page>.html) when packaged (file:// URL) or
// ELECTRON_RENDERER_URL when run from source (http://127.0.0.1:<dev-port>).
// Never inject into a foreign Chromium that happens to expose a CDP port
// (e.g. a headless test browser) — such a pill would render nowhere useful.
const APP_TARGET_RE = (u) => {
  if (!u) return false;
  if (/^file:/.test(u)) return /\/out\/renderer\/[^/]*\.html(\?|$)/.test(u) || /\.zcode\//.test(u) || /\/ZCode\//.test(u);
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(u)) return /\/(index|login)\.html(\?|$)/.test(u) || u.replace(/^https?:\/\/[^/]+/, "").replace(/\/$/, "") === "";
  return false;
};

// Electron's /json/version reports a plain Chromium identity ("Chrome/146...")
// — same header any browser sends — so the product name cannot be used to
// recognize the app. Instead: the real app always serves its UI from a
// page target under its install dir (out/renderer/*.html via loadFile, or
// ELECTRON_RENDERER_URL in dev). A foreign browser has no such target, and we
// additionally verify the page's execution context really has the app's
// preload globals before rendering anything.
async function isAppCdp(port, targets) {
  if (!targets.length) return false;
  // The strongest signal is the app's own renderer page shape.
  if (targets.some((t) => APP_TARGET_RE(t.url || ""))) return true;
  // Dev-mode renderer URLs: verify one page actually contains the app shell.
  return false;
}

// Runtime proof that a page is the ZCode app renderer: the app's preload
// exposes globals (window.zcode bridge) and the Lexical/i18n shell exists.
function appContextProbeJs() {
  return `(function(){
    try {
      const hasBridge = typeof window.zcode === 'object' && window.zcode !== null;
      const doc = document;
      const app = !!(doc.querySelector('#root, [data-testid="v4-composer"], .chat-composer-region'));
      return JSON.stringify({bridge: hasBridge, shell: app});
    } catch (e) { return JSON.stringify({bridge:false, shell:false, err:String(e)}); }
  })()`;
}

async function main() {
  let targets;
  try {
    const all = await findTargets(CDP_PORT);
    const pages = all.filter((t) => t.type === "page");
    if (!(await isAppCdp(CDP_PORT, pages))) {
      log(`no ZCode app renderer on :${CDP_PORT} — pill channel off (this port belongs to another browser or the app has no debugging port; fallback channels stay active)`);
      process.exitCode = 2;
      writeAttachState(false, "no-app-cdp");
      return;
    }
    targets = pages.filter((t) => APP_TARGET_RE(t.url || ""));
    if (!targets.length) {
      // App CDP is up but no page URL matched the known renderer shapes:
      // fail open for robustness across app updates, but log what was seen.
      log("app CDP up; no page URL matched known renderer shapes — attaching to app pages generically");
      targets = pages;
    }
  } catch (e) {
    log("CDP not reachable on", CDP_PORT, "— composer pill unavailable (fallback channels stay active)");
    process.exitCode = 2;
    writeAttachState(false, "no-app-cdp");
    return;
  }
  if (!targets.length) {
    log("no page targets; is the app running with --remote-debugging-port?");
    process.exitCode = 2;
    writeAttachState(false, "no-app-cdp");
    return;
  }
  // One browser-level connection for the whole sweep (see injectIntoTarget).
  const ver = await getJson(`http://127.0.0.1:${CDP_PORT}/json/version`).catch(() => null);
  const browserWsUrl = ver?.webSocketDebuggerUrl;
  if (!browserWsUrl) {
    log("CDP has no browser endpoint; pill unavailable");
    process.exitCode = 2;
    writeAttachState(false, "no-app-cdp");
    return;
  }
  let ws;
  try {
    ws = await wsClient(browserWsUrl);
  } catch (e) {
    log("could not open browser CDP socket:", String(e.message || e));
    process.exitCode = 2;
    writeAttachState(false, "no-app-cdp");
    return;
  }
  const timed = makeTimed(ws);
  let okCount = 0;
  try {
    for (const t of targets) {
      try {
        if (await injectIntoTarget(ws, t, timed)) okCount++;
      } catch (e) {
        log("inject failed:", t.url?.slice(0, 60), String(e.message || e));
      }
    }
  } finally {
    try { ws.close(); } catch {}
  }
  log(`injected into ${okCount}/${targets.length} target(s)`);
  writeAttachState(okCount > 0, okCount > 0 ? "attached" : "inject-failed");
}

// Singleflight: two injector processes must not fight over the app's devtools
// endpoint, and an orphaned generation must not keep sweeping forever. A lock
// file holding the owner's pid with a fresh mtime marks the active holder;
// a stale lock (older than 45s — a sweep is bounded well under that) or a
// dead pid is taken over.
const LOCK_FILE = path.join(os.homedir(), ".zcode", "stats-composer", "injector.lock");
const LOCK_STALE_MS = 45_000;

function readLock() {
  try {
    const pid = Number(fs.readFileSync(LOCK_FILE, "utf8").trim());
    const st = fs.statSync(LOCK_FILE);
    return { pid: Number.isFinite(pid) ? pid : null, age: Date.now() - st.mtimeMs, fresh: Date.now() - st.mtimeMs < LOCK_STALE_MS };
  } catch {
    return null;
  }
}
function pidAlive(pid) {
  if (!pid || pid === process.pid) return pid === process.pid;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}
function isOurLock() {
  const l = readLock();
  return !!l && l.pid === process.pid;
}
function touchLock() {
  try {
    fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
    fs.writeFileSync(LOCK_FILE, String(process.pid));
    fs.utimesSync(LOCK_FILE, new Date(), new Date());
  } catch {}
}
// Returns true when this process may sweep.
function claimLock() {
  const l = readLock();
  if (l && l.fresh && l.pid !== process.pid && pidAlive(l.pid)) return false;
  touchLock();
  return true;
}

// In-process re-entrancy guard: a slow sweep must not stack with the next
// interval tick (overlapping sweeps would fight over the same session id).
let sweeping = false;
async function sweepOnce() {
  if (sweeping) return;
  if (!claimLock()) {
    // A live peer owns the lock: this process is superseded. Standing down is
    // not enough — the heartbeat and re-sweep intervals below would keep the
    // process (and its listeners) alive forever, so orphaned injectors piled up
    // across sidecar restarts. Exit, and let a stale lock be taken over by
    // whichever injector the sidecar starts next.
    log("another injector holds the lock — standing down");
    process.exit(3);
  }
  sweeping = true;
  try { await main(); } catch (e) { log("sweep error:", String(e.message || e)); } finally { sweeping = false; }
}

await (async () => {
  if (lockHeldFreshByOther()) {
    log("another injector holds the lock — standing down");
    process.exit(3);
  }
  await sweepOnce();
})();
function lockHeldFreshByOther() {
  const l = readLock();
  return !!l && l.fresh && l.pid !== process.pid && pidAlive(l.pid);
}
if (!ONCE) {
  // Periodic re-sweep: navigations and session switches drop the DOM pill;
  // the injected script is idempotent so re-running is safe.
  setInterval(() => { sweepOnce().catch(() => {}); }, 10_000);
  // Heartbeat: keep the lock fresh while this process lives.
  setInterval(() => touchLock(), 15_000).unref();
  process.on("exit", () => { if (isOurLock()) { try { fs.unlinkSync(LOCK_FILE); } catch {} } });
}