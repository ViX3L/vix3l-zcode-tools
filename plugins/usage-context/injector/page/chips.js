(function () {
  // VERSION is bumped when this script changes materially. The display options
  // are part of it: flipping showChips/showRanFor must supersede the running
  // generation, not be dismissed as 'already'. The prefix-compatibility fix
  // changed the resolver, so it must also supersede a page still running 11.
  var VERSION = '12-__SHOW_CHIPS__-__SHOW_RANFOR__';
  var SHOW_CHIPS = __SHOW_CHIPS__;
  var SHOW_RANFOR = __SHOW_RANFOR__;
  var EPOCH = Math.random().toString(36).slice(2, 10);
  var SIDECAR = 'http://127.0.0.1:__SIDECAR_PORT__';
  var PORT = SIDECAR.slice(SIDECAR.lastIndexOf(':') + 1);
  var S = (window.__usageContext = window.__usageContext || {
    version: null, epoch: null, port: null, timer: null, handlers: null, hovering: null, cleanup: null,
  });
  var aliveHere = S.version === VERSION && S.port === PORT && S.epoch !== null && S.dead !== true;
  if (aliveHere) return 'already';

  // A superseded generation must release its listeners and timers. Without
  // this, every update added another pointerover/pointerout/resize listener
  // and another watchdog interval to a page that lives for days.
  if (typeof S.cleanup === 'function') {
    try { S.cleanup(); } catch (e) {}
  }
  S.dead = true;
  S.version = VERSION;
  S.port = PORT;
  S.epoch = EPOCH;
  S.hovering = null;
  S.dead = false;

  // A config change that turns the chips off must also remove the chips that
  // are already on the page.
  if (!SHOW_CHIPS) {
    var stale = document.querySelectorAll('.uc-wrap, .uc-card-host');
    for (var si = 0; si < stale.length; si++) { try { stale[si].remove(); } catch (e) {} }
    return 'disabled';
  }

  var state = { byMsg: null, sessionId: null, fetchedAt: 0, lastErr: null };
  var chips = new Map();
  var cardEl = null, cardHost = null, pollTimer = null, watchdogTimer = null;
  var owner = function () { return S.epoch === EPOCH && S.version === VERSION; };

  // Take over the previous generation's nodes by ADOPTING them, not deleting
  // them, so a plugin update does not blank the chips while the new generation
  // fetches. A wrap from an incompatible build is removed instead.
  (function () {
    var old = document.querySelectorAll('.uc-wrap');
    for (var i = 0; i < old.length; i++) {
      var w = old[i];
      var key = w.getAttribute('data-uc-for');
      var uval = w.querySelector('.uc-usage-val'), tval = w.querySelector('.uc-time-val');
      var uchip = w.querySelector('.uc-usage'), tchip = w.querySelector('.uc-time');
      if (key && uval && uchip && (!SHOW_RANFOR || (tval && tchip))) {
        if (!SHOW_RANFOR && tchip) tchip.remove();
        chips.set(key, {
          wrap: w,
          usageVal: uval,
          timeVal: tval,
          chipUsage: uchip,
          chipTime: tchip,
          data: null,
          painted: true,
        });
      } else {
        try { w.remove(); } catch (e) {}
      }
    }
    var hosts = document.querySelectorAll('.uc-card-host');
    for (var j = 0; j < hosts.length; j++) { try { hosts[j].remove(); } catch (e) {} }
  })();

  // ---- formatting (mirrors the app's own usage panel wording) ----
  function fmtTok(v) {
    if (v == null) return '—';
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M tok';
    if (v >= 1e3) return Math.round(v / 1e3) + 'K tok';
    return v + ' tok';
  }
  function fmtTokExact(v) { return v == null ? '—' : Math.round(v).toLocaleString('en-US') + ' tok'; }
  function fmtDur(ms) {
    if (ms == null) return '—';
    if (ms >= 3600000) { var h = Math.floor(ms / 3600000), m = Math.round((ms % 3600000) / 60000); return h + 'h ' + m + 'm'; }
    if (ms >= 60000) { var mm = Math.floor(ms / 60000), s = Math.round((ms % 60000) / 1000); return mm + 'm ' + s + 's'; }
    if (ms >= 1000) return Math.round(ms / 1000) + 's';
    return Math.round(ms) + 'ms';
  }
  // The model string comes from user config and provider names, so it is
  // untrusted markup: escape it before it reaches innerHTML.
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---- find the active session + turn footers ----
  // ZCode 3.16.2 uses `session_*` ids; older builds and subagent sessions use
  // `sess_*`. Both are real conversations, and only `draft` means "no data yet".
  function currentSession() {
    try {
      var n = document.querySelector('[data-session-id]');
      var v = n && n.getAttribute('data-session-id');
      if (!v || v === 'draft' || !/^(?:sess_|session_)/.test(v)) return null;
      return v;
    } catch (e) { return null; }
  }

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

  // Both the app's 12-hour clock and a 24-hour clock, with or without seconds.
  function isTimeText(t) {
    var s = (t || '').trim();
    if (/^\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)$/i.test(s)) return true;
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(s)) {
      var h = Number(s.split(':')[0]);
      return h >= 0 && h <= 23;
    }
    return false;
  }

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
    if (rec && rec.wrap && rec.wrap.isConnected && rec.wrap.parentElement === row) return rec;
    var wrap = document.createElement('span');
    wrap.className = 'uc-wrap';
    wrap.setAttribute('data-uc-for', key);
    wrap.innerHTML =
      '<span class="uc-div" aria-hidden="true"></span>' +
      '<span class="uc-chip uc-usage" tabindex="0">' +
        '<span class="uc-ico">\u{1F5C4}</span><span class="uc-lbl">Usage</span> <span class="uc-val uc-usage-val">—</span>' +
      '</span>' +
      (SHOW_RANFOR
        ? '<span class="uc-chip uc-time" tabindex="0">' +
            '<span class="uc-ico">\u{23F1}</span><span class="uc-lbl">Ran for</span> <span class="uc-val uc-time-val">—</span>' +
          '</span>'
        : '');
    row.appendChild(wrap);
    rec = {
      wrap: wrap,
      usageVal: wrap.querySelector('.uc-usage-val'),
      timeVal: wrap.querySelector('.uc-time-val'),
      chipUsage: wrap.querySelector('.uc-usage'),
      chipTime: wrap.querySelector('.uc-time'),
      data: null,
      painted: false,
    };
    chips.set(key, rec);
    return rec;
  }

  function paint(entry) {
    var rec = ensureChips(entry);
    var t = state.byMsg ? state.byMsg[entry.turnId] : null;
    rec.data = t || null;
    if (!state.byMsg && rec.painted) return;
    var uv = t ? fmtTok(t.totalTokens) : '—';
    var tv = t ? fmtDur(t.durationMs) : '—';
    if (rec.usageVal && rec.usageVal.textContent !== uv) rec.usageVal.textContent = uv;
    if (rec.timeVal && rec.timeVal.textContent !== tv) rec.timeVal.textContent = tv;
    rec.wrap.classList.toggle('uc-unknown', !t);
    rec.painted = true;
  }

  function renderAll() {
    if (!owner()) return;
    var footers = turnFooters();
    var seen = {};
    for (var i = 0; i < footers.length; i++) {
      seen[footers[i].turnId] = 1;
      paint(footers[i]);
    }
    chips.forEach(function (rec, key) {
      if (seen[key] || !rec.wrap || !rec.wrap.isConnected) return;
      if (!document.querySelector('[data-turn-id="' + key + '"]')) rec.wrap.remove();
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
    cardEl = c;
    cardHost = host;
    return c;
  }

  function fillCard(c, key, whichChip) {
    var t = state.byMsg && state.byMsg[key];
    var which = whichChip === 'time' && SHOW_RANFOR ? 'time' : 'usage';
    if (!t) {
      c.innerHTML = header(which, which === 'time' ? null : '—');
      return;
    }
    var model = t.model || '—';
    if (which === 'time') {
      c.innerHTML =
        header(which, null) +
        '<div class="uc-sep"></div>' +
        row('Total run time', fmtDur(t.durationMs));
      return;
    }
    c.innerHTML =
      header(which, fmtTokExact(t.totalTokens)) +
      '<div class="uc-sep"></div>' +
      row('Provider / model', model) +
      row('Uncached input', fmtTokExact(t.uncachedTokens)) +
      row('Output', fmtTokExact(t.outputTokens));
  }

  function header(which, value) {
    var icon = which === 'time' ? '\u{23F1}' : '\u{1F5C4}';
    var title = which === 'time' ? 'Turn time and speed' : 'Turn usage';
    return '<div class="uc-ch"><span class="uc-ct"><span class="uc-cico">' + icon + '</span> ' + title + '</span>' +
      (value == null ? '' : '<span class="uc-cv">' + esc(value) + '</span>') + '</div>';
  }

  function row(k, v) {
    return '<div class="uc-cr"><span class="uc-cd"></span><span class="uc-cl">' + esc(k) +
      '</span><span class="uc-cvv">' + esc(v) + '</span></div>';
  }

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
    var place = function (left, top) {
      cardHost.style.left = Math.round(left) + 'px';
      cardHost.style.top = Math.round(top) + 'px';
    };
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
    if (!state.byMsg || !state.byMsg[key]) return;
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

  function chipFromEvent(e) {
    var path = (e.composedPath && e.composedPath()) || [];
    for (var i = 0; i < path.length; i++) {
      var n = path[i];
      if (n && n.classList && n.classList.contains('uc-chip')) {
        var wrap = n.closest ? n.closest('.uc-wrap') : null;
        if (wrap) {
          return {
            key: wrap.getAttribute('data-uc-for'),
            which: n.classList.contains('uc-time') ? 'time' : 'usage',
            chip: n,
          };
        }
      }
    }
    return null;
  }

  function onPointerOver(e) {
    if (!owner()) return;
    var hit = chipFromEvent(e);
    if (hit) showCard(hit.key, hit.which, hit.chip);
    else if (S.hovering) hideCard();
  }

  function onPointerOut(e) {
    if (!owner()) return;
    var hit = chipFromEvent(e);
    var to = e.relatedTarget;
    var intoCard = !!(to && cardHost && cardHost.contains && cardHost.contains(to));
    if (!hit && !intoCard && S.hovering) hideCard();
  }

  function onResize() {
    if (S.hovering) { var c = ensureCard(); positionCard(c); }
  }

  document.addEventListener('pointerover', onPointerOver, true);
  document.addEventListener('pointerout', onPointerOut, true);
  window.addEventListener('resize', onResize, { passive: true });
  S.listenerEpoch = EPOCH;

  // ---- data ----
  function load() {
    var sid = currentSession();
    if (!sid) { state.byMsg = null; state.sessionId = null; renderAll(); return; }
    fetch(SIDECAR + '/turn?session=' + encodeURIComponent(sid), { signal: AbortSignal.timeout(8000) })
      .then(function (r) {
        if (!r.ok) throw new Error('turn -> ' + r.status);
        return r.json();
      })
      .then(function (j) {
        if (!j || !j.turns) { state.byMsg = null; state.lastErr = 'no turns'; return renderAll(); }
        var map = {};
        for (var i = 0; i < j.turns.length; i++) {
          var t = j.turns[i];
          if (t.userMessageId) map[t.userMessageId] = t;
        }
        state.byMsg = map;
        state.sessionId = j.sessionId;
        state.fetchedAt = Date.now();
        state.lastErr = null;
        renderAll();
      })
      .catch(function (e) { state.lastErr = String((e && e.message) || e); renderAll(); });
  }

  var POLL_MS = 2000;
  var running = false;
  function schedule(delay) {
    if (running) return;
    running = true;
    pollTimer = setTimeout(function () {
      pollTimer = null;
      try { if (owner()) load(); }
      finally { running = false; if (owner() && pollTimer === null) schedule(POLL_MS); }
    }, delay || POLL_MS);
  }

  S.cleanup = function () {
    document.removeEventListener('pointerover', onPointerOver, true);
    document.removeEventListener('pointerout', onPointerOut, true);
    window.removeEventListener('resize', onResize);
    if (pollTimer != null) clearTimeout(pollTimer);
    if (watchdogTimer != null) clearInterval(watchdogTimer);
    pollTimer = null;
    watchdogTimer = null;
    if (cardHost) { try { cardHost.remove(); } catch (e) {} }
    cardHost = null;
    cardEl = null;
  };

  schedule(0);
  watchdogTimer = setInterval(function () {
    if (owner() && !running && !pollTimer) schedule(POLL_MS);
  }, 5000);
})();
