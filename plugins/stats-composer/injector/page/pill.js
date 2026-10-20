(function () {
  // VERSION is bumped when the injected script changes materially; EPOCH is
  // unique per run of this script. The app's React reconciliation copies DOM
  // nodes
  // without their JS expandos, so an expando is NOT a reliable ownership mark
  // (observed: the live node lost __owner while keeping our shadow root, which
  // made every poller treat it as foreign and rebuild it). Ownership is
  // therefore the document singleton, and the EPOCH is the generation id.
  //
  // Card density and pill position are part of the version identity: flipping
  // either userConfig option must supersede the running generation so the new
  // look applies live, instead of the idempotence check answering 'already' and
  // leaving the old layout or side on screen until a reload.
  var LAYOUT = '__CARD_LAYOUT__';
  var POSITION = '__PILL_POSITION__';
  // The prefix-compatibility fix changed the session resolver, so the marker
  // must move too; otherwise a page still running 43 answers 'already'.
  var VERSION = '44-' + LAYOUT + '-' + POSITION;
  var EPOCH = Math.random().toString(36).slice(2, 10);
  const SIDECAR = 'http://127.0.0.1:__SIDECAR_PORT__';
  // The sidecar port is part of the generation identity. A generation left
  // polling a stale or absent port (a manual or test injector started with a
  // different --sidecar-port, or a sidecar that moved) must be supersedable by
  // a correct one; otherwise the guard below answers 'already', the pill keeps
  // requesting a dead port, and it stays empty until the page is reloaded.
  const PORT = SIDECAR.slice(SIDECAR.lastIndexOf(':') + 1);
  // Document singleton: exactly one poller and one generation identity exist
  // per page, so a re-injection REPLACES the running generation instead of
  // leaving an orphan behind (the bug class that produced live-but-empty pills
  // and a sidecar hammered by dead generations).
  var S = (window.__tpsStats = window.__tpsStats || { version: null, epoch: null, port: null, timer: null, handlers: null, hovering: false });
  var aliveHere = S.version === VERSION && S.port === PORT && S.epoch !== null && S.dead !== true;
  // The stateless helpers are injected first (page/pill-core.js); without
  // them this generation cannot render and must not claim the singleton.
  const UI = window.__tpsPillUI;
  if (!UI) return 'no-ui';
  if (aliveHere) return 'already';
  // Supersede: release the previous generation's listeners and timers before
  // claiming the singleton. Guarded callbacks alone leave them registered for
  // the life of the page, so every update leaked another set.
  if (typeof S.cleanup === 'function') {
    try { S.cleanup(); } catch (e) {}
  }
  // Supersede: mark the old generation dead, then claim the singleton.
  S.dead = true;
  S.version = VERSION;
  S.port = PORT;
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

  const state = { tps: null, ttft: null, winAvg: null, streaming: false, model: '', snap: null, dead: false };
  let shadowHost = null;
  // Our host, found by class (never by id — see buildHost).
  function pillHost() {
    const nodes = document.querySelectorAll('.zcode-stats-pill-host');
    for (const n of nodes) if (n.style.display !== 'none') return n;
    return nodes[0] || null;
  }

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
    host.className = 'zcode-stats-pill-host' + (POSITION === 'right' ? ' right' : '');
    // Stamp the owning generation so a later generation can tell a dead
    // generation's leftover host (a "fossil") from a build it cannot attribute.
    host.setAttribute('data-v', VERSION);
    host.setAttribute('data-epoch', EPOCH);
    // Participate in the app's own composer auto-collapse layout.
    host.setAttribute('data-composer-collapse-priority', '3');
    try { host.attachShadow({ mode: 'open' }); } catch (e) { return null; }
    const style = document.createElement('style');
    style.textContent = __SC_CSS__;

    const pill = document.createElement('div');
    pill.className = 'pill idle';
    pill.innerHTML = UI.PILL_SKELETON;
    const cardEl = document.createElement('div');
    // Density is a class on the card, so the wide/compact difference is pure
    // CSS: the content, values and behaviour are identical either way.
    cardEl.className = LAYOUT === 'compact' ? 'cardp compact' : 'cardp';
    cardEl.innerHTML = UI.CARD_SKELETON;
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

  // Hover = presentation only. The card was already filled by the latest
  // tick (same principle as the app's own context panel: data prepared
  // ahead of time; hover never fetches, so it shows instantly).
  function showCard() {
    const c = shadowHost && shadowHost.shadowRoot && shadowHost.shadowRoot.querySelector('.cardp');
    if (!c) return; // host mid-replacement; the next tick re-asserts
    UI.fillCard(c, state);
    // Never present a card of dashes: if no snapshot has landed yet (the very
    // first second after injection, or a fetch still in flight), keep the card
    // closed and let the next tick open it — a filled card is the promise the
    // hover makes.
    if (!state.snap) return;
    UI.positionCard(c, persistentHost || shadowHost);
    c.style.display = 'block';
  }
  function hideCard() {
    const c = shadowHost && shadowHost.shadowRoot && shadowHost.shadowRoot.querySelector('.cardp');
    if (c) c.style.display = 'none';
  }

  async function loadNow() {
    try {
      // Generous timeout: the sidecar answers in ~1ms, but a busy renderer can
      // take a second or more to schedule this task's continuation, so a tight
      // budget (the earlier 1500ms) turned a healthy sidecar into dashes.
      const cur = UI.currentSession();
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

  const setText = UI.setText;

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
      (state.ttft != null ? UI.fmtMs(state.ttft) : '-');
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
    if (!pill.querySelector('.b')) pill.innerHTML = UI.PILL_SKELETON; // heal
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
    setText(t, state.ttft != null ? UI.fmtMs(state.ttft) : '');
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
      UI.fillCard(cardEl, state);
      if (cardEl.style.display !== 'block') cardEl.style.display = 'block';
      UI.positionCard(cardEl, persistentHost || shadowHost);
    }
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
  state.dead = false;
  UI.hoverTracking({ S, EPOCH, pillHost, showCard, hideCard });
  watchReattach();
  schedule(0);
  // Watchdog: if the poll loop is ever lost (host churn, page restore) while
  // this generation still owns the singleton, resume it. The running flag
  // prevents stacking a second timer while a poll is still in flight — stacked
  // polls would each worsen the renderer congestion they are waiting on.
  const watchdog = setInterval(() => {
    if (owner() && !state.dead && !running && !S.timer) schedule(POLL_MS);
  }, 3000);
  S.cleanup = function () {
    if (observer) { try { observer.disconnect(); } catch (e) {} observer = null; }
    if (S.timer != null) { clearTimeout(S.timer); S.timer = null; }
    clearInterval(watchdog);
    const h = S.listenerHandlers;
    if (h) {
      document.removeEventListener('pointerover', h.onPointerOver, true);
      document.removeEventListener('pointerout', h.onPointerOut, true);
      window.removeEventListener('resize', h.onResize);
      S.listenerHandlers = null;
    }
  };
})();