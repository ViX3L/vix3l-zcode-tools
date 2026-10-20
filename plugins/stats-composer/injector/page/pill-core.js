// The stateless half of the composer pill: formatting, skeletons and the DOM
// helpers that do not own any state. It is injected before pill.js, which keeps
// the generation/ownership logic and the data loop.
(function () {
  var U = (window.__tpsPillUI = window.__tpsPillUI || {});

  U.fmtMs = function (v) { return v == null ? '—' : (v >= 10000 ? (v / 1000).toFixed(1) + 's' : Math.round(v) + 'ms'); };
  U.fmtDur = function (v) { return v == null ? '—' : (v >= 60000 ? (v / 60000).toFixed(1) + 'm' : (v >= 10000 ? (v / 1000).toFixed(1) + 's' : Math.round(v) + 'ms')); };
  // Exact figures for the token panel, thousands-separated — the hover card is
  // where full precision belongs ("3,093,207 tok"), unlike the pill's rounding.
  U.fmtTok = function (v) { return v == null ? '—' : Math.round(v).toLocaleString('en-US') + ' tok'; };

  U.setText = function (el, v) {
    if (!el) return;
    var t = v == null ? '' : String(v);
    if (el.firstChild) {
      if (el.firstChild.nodeValue !== t) el.firstChild.nodeValue = t;
    } else {
      el.appendChild(document.createTextNode(t));
    }
  };

  // Static skeletons: only text nodes change afterwards, so hover tracking
  // survives streaming updates and React churn.
  U.PILL_SKELETON =
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
  U.CARD_SKELETON =
    '<div class="ch"><span class="ct"><span class="cico">⟳</span> Session statistics</span><span class="cv c-req">—</span></div>' +
    '<div class="crows">' +
      '<div class="cr g1"><span class="cd"></span><span class="cl">Latest request · TPS</span><span class="cv v-lasttps">—</span></div>' +
      '<div class="cr g1"><span class="cd"></span><span class="cl">Latest request · TTFT</span><span class="cv v-lastttft">—</span></div>' +
      '<div class="cr g2"><span class="cd"></span><span class="cl">Last <span class="cwin">10</span> · TPS</span><span class="cv v-tps">—</span></div>' +
      '<div class="cr g2"><span class="cd"></span><span class="cl">Last <span class="cwin2">10</span> · TTFT</span><span class="cv v-ttft">—</span></div>' +
    '</div>' +
    '<div class="cdiv"></div>' +
    '<div class="cmain">' +
      '<div class="ccol">' +
        '<div class="crows">' +
          '<div class="cr g4"><span class="cd"></span><span class="cl">LLM time</span><span class="cv v-llm">—</span></div>' +
          '<div class="cr g4"><span class="cd"></span><span class="cl">Tool time</span><span class="cv v-toolt">—</span></div>' +
        '</div>' +
      '</div>' +
      '<div class="cdivv" aria-hidden="true"></div>' +
      '<div class="ccol">' +
        '<div class="crows">' +
          '<div class="cr g4"><span class="cd"></span><span class="cl">Turns</span><span class="cv v-turns">—</span></div>' +
          '<div class="cr g4"><span class="cd"></span><span class="cl">Steps</span><span class="cv v-steps">—</span></div>' +
          '<div class="cr g4"><span class="cd"></span><span class="cl">Tool calls</span><span class="cv v-toolcalls">—</span></div>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div class="cdiv"></div>' +
    // The whole session tree, including subagent sessions, with the split
    // stated rather than left for the reader to guess.
    '<div class="crows">' +
      '<div class="cr g3"><span class="cd"></span><span class="cl">Token usage</span><span class="cv v-toktotal">—</span></div>' +
      '<div class="cr g3"><span class="cd"></span><span class="cl">Cache hit</span><span class="cv v-cachehit">—</span></div>' +
      '<div class="cr g3"><span class="cd"></span><span class="cl">Uncached input</span><span class="cv v-uncached">—</span></div>' +
      '<div class="cr g3"><span class="cd"></span><span class="cl">Cached input</span><span class="cv v-cached">—</span></div>' +
      '<div class="cr g3"><span class="cd"></span><span class="cl">Output</span><span class="cv v-output">—</span></div>' +
      '<div class="cr g3 v-subsharerow" style="display:none"><span class="cd"></span><span class="cl">Subagent share</span><span class="cv v-subshare">—</span></div>' +
    '</div>' +
    '<div class="cfoot"><span class="cl">Average session rate</span><span class="cv c-avg">—</span></div>' +
    '<div class="csub" style="display:none">' +
      '<div class="cdiv"></div>' +
      '<div class="crows">' +
        '<div class="cr g5"><span class="cd"></span><span class="cl">Subagents · this session</span><span class="cv v-subcount">—</span></div>' +
        '<div class="cr g5"><span class="cd"></span><span class="cl">Subagent tokens</span><span class="cv v-subtokens">—</span></div>' +
        '<div class="cr g5"><span class="cd"></span><span class="cl">Subagent rate</span><span class="cv v-subtps">—</span></div>' +
        '<div class="cr g5"><span class="cd"></span><span class="cl">Subagent TTFT</span><span class="cv v-subttft">—</span></div>' +
      '</div>' +
    '</div>';

  // Walk up through shadow roots via hosts to see whether the node belongs to
  // our pill's shadow tree (e.g. the pointer moved onto the card).
  U.shadowContains = function (host, node) {
    var n = node;
    while (n) {
      if (n === host) return true;
      n = n.parentNode instanceof ShadowRoot ? n.parentNode.host : n.parentNode;
    }
    return false;
  };

  // Position the card ABOVE the pill, centered on it, exactly as the app's own
  // context panel does. The first guess is corrected by measuring the result:
  // the composer sits inside a transformed ancestor, so "fixed" resolves
  // against that ancestor rather than the viewport.
  U.positionCard = function (cardEl, host) {
    if (!host || !host.isConnected) return;
    var r = host.getBoundingClientRect();
    cardEl.style.visibility = 'hidden';
    cardEl.style.display = 'block';
    var w = cardEl.offsetWidth, h = cardEl.offsetHeight;
    var place = function (left, top) {
      cardEl.style.left = Math.round(left) + 'px';
      cardEl.style.top = Math.round(top) + 'px';
    };
    var centered = r.left + r.width / 2 - w / 2;
    var x = Math.min(Math.max(8, centered), Math.max(8, window.innerWidth - w - 8));
    var y = r.top - h - 2;
    if (y < 8) y = Math.min(r.bottom + 2, window.innerHeight - h - 8);
    place(x, Math.max(8, y));
    var got = cardEl.getBoundingClientRect();
    var dx = x - got.left, dy = Math.max(8, y) - got.top;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
      place(parseFloat(cardEl.style.left) + dx, parseFloat(cardEl.style.top) + dy);
    }
    cardEl.style.visibility = 'visible';
  };

  // The session the app is CURRENTLY displaying; "draft" means a new chat that
  // must show no figures rather than the previous chat's. ZCode 3.16.2 uses
  // `session_*` ids; older builds and subagent sessions still use `sess_*`, so
  // both prefixes identify a real conversation.
  U.currentSession = function () {
    try {
      var n = document.querySelector('[data-session-id]');
      var v = n && n.getAttribute('data-session-id');
      if (!v) return null;
      if (v === 'draft') return { draft: true };
      return /^(?:sess_|session_)/.test(v) ? { sid: v } : { draft: true };
    } catch (e) { return null; }
  };

  // Hover is tracked at the document level so it outlives the host node. Each
  // generation installs its own listeners and stamps S.trackingEpoch; an older
  // listener retires itself on the next event.
  U.hoverTracking = function (opts) {
    var S = opts.S, EPOCH = opts.EPOCH;
    S.handlers = { show: opts.showCard, hide: opts.hideCard };
    S.trackingEpoch = EPOCH;
    var myEpoch = EPOCH;
    var active = function () { return S.trackingEpoch === myEpoch; };
    var hostFromEvent = function (e) {
      var path = (e.composedPath && e.composedPath()) || [];
      var host = opts.pillHost();
      if (host && path.indexOf(host) !== -1) return host;
      return null;
    };
    var onPointerOver = function (e) {
      if (!active()) return;
      var h = S.handlers;
      if (!h) return;
      if (hostFromEvent(e)) { S.hovering = true; h.show(); }
      else if (S.hovering) { S.hovering = false; h.hide(); }
    };
    var onPointerOut = function (e) {
      if (!active()) return;
      var h = S.handlers;
      if (!h) return;
      var host = opts.pillHost();
      var stillInside = (e.composedPath && e.composedPath()).indexOf(host) !== -1 ||
        (e.relatedTarget && host && U.shadowContains(host, e.relatedTarget));
      if (!stillInside && S.hovering) { S.hovering = false; h.hide(); }
    };
    var onResize = function () { S.fitSig = null; };
    document.addEventListener('pointerover', onPointerOver, true);
    document.addEventListener('pointerout', onPointerOut, true);
    window.addEventListener('resize', onResize, { passive: true });
    S.listenerHandlers = { onPointerOver, onPointerOut, onResize };
  };

  // Card values. Two families, deliberately labelled apart:
  // "Latest request" is the newest single request (what the pill shows);
  // "Last N" and the session rows are averages over their stated window.
  // Card values. Two families, deliberately labelled apart:
  //   "Latest request"  = the single newest completed request (same numbers the
  //                       pill shows, so pill and card always agree).
  //   "Last N" / session = averages over that many requests.
  // LLM time is the sum of request durations; Tool time is now MEASURED from
  // ZCode's own tool_usage table (sum of tool durations), not the old
  // span-minus-LLM estimate.
  U.fillCard = function (c, state) {
    if (!c.querySelector('.v-llm')) c.innerHTML = U.CARD_SKELETON; // heal
    const snap = state.snap || {};
    const ss = snap.session;
    const win = snap.window;
    const v = (sel) => c.querySelector(sel);
    U.setText(v('.c-req'), ss ? ((ss.samples ?? 0) + ' requests') : '—');
    const w = (win && win.window) || 10;
    U.setText(v('.cwin'), String(w));
    U.setText(v('.cwin2'), String(w));
    // Turn/step context (the right column), from the sidecar's turn_usage
    // aggregate — the same figures ZCode's own turn panel shows. Independent of
    // the request-level session block, so it is filled before that guard.
    const tt = snap.turns;
    U.setText(v('.v-turns'), tt && tt.turns != null ? String(tt.turns) : '—');
    U.setText(v('.v-steps'), tt && tt.steps != null ? String(tt.steps) : '—');
    U.setText(v('.v-toolcalls'), tt && tt.toolCalls != null ? String(tt.toolCalls) : '—');
    // Subagent activity — the sessions THIS conversation spawned. Scoped to the
    // session (via the child sessions' parent_id), so the count only ever
    // grows, it never reports another chat's agents, and its tokens are already
    // inside the token panel above. Filled BEFORE the "no session" guard below
    // because it does not depend on the composer's own figures: a session whose
    // only work so far was delegated has subagent figures and no composer ones.
    // Shown only when the session actually spawned a subagent, so the card is
    // byte-identical for users who never do.
    const sa = snap.subagents;
    const sub = c.querySelector('.csub');
    if (sub) {
      const has = !!(sa && (sa.requests > 0 || sa.running > 0));
      sub.style.display = has ? '' : 'none';
      if (has) {
        const kinds = (sa.agents || []).map((a) => a.agent).filter(Boolean);
        const who = sa.running > 0
          ? 'running now'
          : (kinds.length === 1 ? kinds[0] : (kinds.length > 1 ? kinds.length + ' agents' : 'subagent'));
        U.setText(v('.v-subcount'), (sa.requests || 0) + ' req' + (sa.requests === 1 ? '' : 's') + ' · ' + who);
        U.setText(v('.v-subtokens'), sa.tokens && sa.tokens.total ? U.fmtTok(sa.tokens.total) : '—');
        U.setText(v('.v-subtps'), sa.avgTps != null ? sa.avgTps + ' tok/s' : '—');
        U.setText(v('.v-subttft'), sa.avgTtftMs != null ? U.fmtMs(sa.avgTtftMs) : '—');
      }
    }
    if (!ss) return;
    // Latest single request — identical to the pill's own figures.
    const lastTps = state.tps != null ? state.tps : (snap.last && snap.last.tokPerSec);
    U.setText(v('.v-lasttps'), lastTps != null ? lastTps + ' tok/s' : '—');
    U.setText(v('.v-lastttft'), state.ttft != null ? U.fmtMs(state.ttft) : '—');
    // Window averages.
    U.setText(v('.v-tps'), win && win.avgTps != null ? win.avgTps + ' tok/s' : '—');
    U.setText(v('.v-ttft'), win && win.avgTtftMs != null ? U.fmtMs(win.avgTtftMs) : '—');
    // Session totals.
    U.setText(v('.v-llm'), ss.requestBusyMs != null ? U.fmtDur(ss.requestBusyMs) : '—');
    U.setText(
      v('.v-toolt'),
      ss.toolBusyMs != null ? U.fmtDur(ss.toolBusyMs) : (ss.otherMs != null ? U.fmtDur(ss.otherMs) : '—')
    );
    // Session token panel — the app's own "Token usage" figures, for the whole
    // session: the conversation's requests plus its compact/title requests,
    // plus everything the sessions it spawned ran. When subagents contributed,
    // the share row says how much of the total they are, so the panel is neither
    // silently short (the old main_turn-only scope) nor silently inflated.
    const tk = ss.tokens || {};
    U.setText(v('.v-toktotal'), tk.total != null ? U.fmtTok(tk.total) : '—');
    U.setText(v('.v-cachehit'), tk.cacheHitPct != null ? tk.cacheHitPct + '%' : '—');
    U.setText(v('.v-uncached'), tk.uncached != null ? U.fmtTok(tk.uncached) : '—');
    U.setText(v('.v-cached'), tk.cached != null ? U.fmtTok(tk.cached) : '—');
    U.setText(v('.v-output'), tk.output != null ? U.fmtTok(tk.output) : '—');
    const shareRow = c.querySelector('.v-subsharerow');
    if (shareRow) {
      const shares = tk.subagentSharePct != null && tk.subagentSharePct > 0;
      shareRow.style.display = shares ? '' : 'none';
      if (shares) U.setText(v('.v-subshare'), tk.subagentSharePct + '%');
    }
    U.setText(v('.c-avg'), ss.avgTps != null ? ss.avgTps + ' tok/s' : '—');
  };
})();
