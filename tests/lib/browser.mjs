// A real Chromium, driven through Playwright, running the plugin's REAL page
// script (see extract.mjs). Nothing here simulates the DOM: the assertions are
// made against a live browser with the same rendering and layout engine the
// ZCode renderer uses, which is what makes a claim like "the caption does not
// overlap the ring" a measurement rather than an opinion.
//
// The module also provides the fake composer/turn DOM the scripts expect, so a
// test reads as "given this session and this DOM, the pill shows X".
import path from "node:path";
import { fileURLToPath } from "node:url";

let _pw;
async function playwright() {
  if (!_pw) _pw = await import("playwright");
  return _pw;
}

let _browser;
export async function browser() {
  if (!_browser) {
    const { chromium } = await playwright();
    _browser = await chromium.launch({ args: ["--no-sandbox"] });
  }
  return _browser;
}

export async function closeBrowser() {
  try { _browser && (await _browser.close()); } catch {}
  _browser = null;
}

// ---------------------------------------------------------------------------
// The fake app shell
// ---------------------------------------------------------------------------

// The composer, reduced to exactly what the pill script probes: the two
// attributes it finds the toolbar by, a leading element to subtract from the
// available width, and the session marker. The host node is what the script
// appends itself — we must not pre-create it.
//
// `topSpace` pushes the composer down the page, which is how a test controls
// whether there is room ABOVE the pill (there is not, when the composer sits at
// the very top, so the card must fall below).
export function composerHtml({ sessionId = "sess_test_0001", width = 900, topSpace = 0 } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; font-family: system-ui, sans-serif; background: #1e1e1e; color: #eee;
           --ui-font-size: 14px; }
    .spacer { height: ${topSpace}px; }
    .composer { display: flex; align-items: center; gap: 8px; padding: 10px;
                position: relative; width: ${width}px; }
    .plus { width: 28px; height: 28px; border-radius: 8px; border: 1px solid #444; flex: none; }
    .row { display: flex; align-items: center; gap: 8px; flex: 1 1 auto; min-width: 0;
           border: 1px dashed #3a3a3a; padding: 4px; }
    .lead { flex: none; }
    .model { flex: none; margin-left: auto; padding: 4px 10px; border: 1px solid #444;
             border-radius: 8px; }
  </style></head><body>
    <div class="spacer"></div>
    <div class="composer" data-session-id="${sessionId}">
      <button class="plus">+</button>
      <div class="row" data-composer-leading-content>
        <span class="lead">access</span>
      </div>
      <span class="model">model ▾</span>
    </div>
  </body></html>`;
}

// A conversation with assistant turns. Each turn carries data-turn-id (the
// value the plugin joins on: turn_usage.user_message_id) and a footer row whose
// LAST child is the bare timestamp span the chips anchor to — the chips script
// appends itself right after that span. Two details are deliberate, because
// they are what the real app renders and what the script has to survive:
//
//   * a second wrapper inside the turn carries the SAME data-turn-id but has no
//     timestamp, so a script that keyed off the first match instead of the
//     footer row would chip the wrong node (and duplicate a turn);
//   * `topSpace` pushes the whole conversation down the page, which is how a
//     test controls whether the hover card has room ABOVE the chip (it does
//     not when the turns start at the very top, so the card must fall below).
export function conversationHtml({ sessionId = "sess_test_0001", turnIds = ["msg_1"], width = 900, topSpace = 0 } = {}) {
  const turns = turnIds
    .map(
      (id, i) => `
    <div class="turn" data-turn-id="${id}">
      <div class="meta" data-turn-id="${id}"></div>
      <div class="body">assistant reply ${i + 1}</div>
      <div class="footer">
        <span class="fsp"></span>
        <span class="ts">${String(4 + i).padStart(2, "0")}:46 AM</span>
      </div>
    </div>`
    )
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; font-family: system-ui, sans-serif; background: #1e1e1e; color: #eee;
           --ui-font-size: 14px; }
    .spacer { height: ${topSpace}px; }
    .chat { width: ${width}px; padding: 12px; }
    .turn { padding: 10px 0; border-bottom: 1px solid #2a2a2a; }
    .footer { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #8b949e; }
    .fsp { flex: 1; }
  </style></head><body>
    <div class="spacer"></div>
    <div class="chat" data-session-id="${sessionId}">${turns}</div>
  </body></html>`;
}

// ---------------------------------------------------------------------------
// Page driving
// ---------------------------------------------------------------------------

export async function newPage(html) {
  const b = await browser();
  const page = await b.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message || e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await page.setContent(html, { waitUntil: "load" });
  page.__errors = errors;
  return page;
}

// A page opened at a real URL. The dashboard is served BY the sidecar at
// /dashboard and fetches its data with relative paths, so it has to be loaded
// from that origin rather than through setContent — which is what makes this a
// test of the shipping page, same-origin behaviour included.
export async function newPageAt(url, { viewport = { width: 1200, height: 800 } } = {}) {
  const b = await browser();
  const page = await b.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message || e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  page.__errors = errors;
  await page.goto(url, { waitUntil: "load" });
  return page;
}

// Install the plugin's stylesheet + script, exactly as the injector's own
// Runtime.evaluate call does: the style element is a preceding statement, and
// the page script is the final expression. eval() is used deliberately — CDP's
// Runtime.evaluate also evals the snippet and returns its completion value, so
// eval here reproduces the injector's semantics (including tolerating the
// trailing ";" the template literal ends with, which a `return (...)` wrapper
// would reject). Returns whatever the IIFE returned ('already' on a re-inject).
export async function install(page, { script, css }) {
  const js =
    `var __testStyle = document.createElement('style');` +
    `__testStyle.textContent = ${JSON.stringify(css)};` +
    `(document.head || document.documentElement).appendChild(__testStyle);` +
    script;
  // eslint-disable-next-line no-eval
  return await page.evaluate((src) => eval(src), js);
}

// Wait until `fnSource` (an arrow-function source evaluated in the page)
// returns truthy, or give up. Used instead of a fixed sleep so the suite stays
// fast and does not flake on a loaded machine. The source is invoked, because
// Playwright treats a bare string as an expression — an arrow function would
// serialise to nothing and never become true.
export async function until(page, fnSource, { timeout = 5000, label = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await page.evaluate(`(${fnSource})()`);
    if (last) return last;
    await page.waitForTimeout(50);
  }
  throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}

// Text of the first node matching `sel`, piercing shadow roots.
export async function deepText(page, sel) {
  return await page.evaluate((s) => {
    const walk = (root) => {
      const hit = root.querySelector(s);
      if (hit) return hit;
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) { const r = walk(el.shadowRoot); if (r) return r; }
      }
      return null;
    };
    const n = walk(document);
    return n ? (n.textContent || "").trim() : null;
  }, sel);
}

// Every text value of `sel`, piercing shadow roots, in document order.
export async function deepAll(page, sel) {
  return await page.evaluate((s) => {
    const out = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll(s)) out.push((el.textContent || "").trim());
      for (const el of root.querySelectorAll("*")) if (el.shadowRoot) walk(el.shadowRoot);
    };
    walk(document);
    return out;
  }, sel);
}

// Bounding boxes for `sel`, piercing shadow roots. Each entry is
// { top, bottom, left, right, width, height, text }.
export async function deepRects(page, sel) {
  return await page.evaluate((s) => {
    const out = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll(s)) {
        const r = el.getBoundingClientRect();
        out.push({
          top: r.top, bottom: r.bottom, left: r.left, right: r.right,
          width: r.width, height: r.height, text: (el.textContent || "").trim(),
        });
      }
      for (const el of root.querySelectorAll("*")) if (el.shadowRoot) walk(el.shadowRoot);
    };
    walk(document);
    return out;
  }, sel);
}

// Hover the pill host (or any selector), letting the document-level pointer
// listeners fire, then give the card a tick to paint.
export async function hover(page, sel) {
  await page.hover(sel, { force: true });
  await page.waitForTimeout(120);
}

export async function unhover(page) {
  await page.mouse.move(2, 2);
  await page.waitForTimeout(120);
}

// Whether the hover card is actually visible, read from COMPUTED style. The
// script only ever sets style.display to "block" when it opens (or "none" to
// close); before the first open the inline value is "" and the visibility comes
// from the stylesheet, so comparing the inline string to "none" is wrong — the
// computed value is the truth.
export async function cardVisible(page) {
  return await page.evaluate(() => {
    const h = document.querySelector(".zcode-stats-pill-host");
    const c = h && h.shadowRoot && h.shadowRoot.querySelector(".cardp");
    return !!c && getComputedStyle(c).display !== "none";
  });
}

// The usage-context hover card (no shadow root — it is a plain div appended to
// the page body). Computed display, for the same reason as above.
export async function ucCardVisible(page) {
  return await page.evaluate(() => {
    const c = document.querySelector(".uc-card");
    return !!c && getComputedStyle(c).display !== "none";
  });
}

// Geometry of the usage-context card and the chip it is anchored to, so a test
// can assert placement against real bounding boxes rather than assumptions.
export async function ucCardGeom(page, chipSel = ".uc-usage") {
  return await page.evaluate((sel) => {
    const c = document.querySelector(".uc-card");
    if (!c) return null;
    const cr = c.getBoundingClientRect();
    const chip = document.querySelector(sel);
    const chr = chip ? chip.getBoundingClientRect() : null;
    return {
      card: { top: cr.top, bottom: cr.bottom, left: cr.left, right: cr.right, width: cr.width, height: cr.height },
      chip: chr && { top: chr.top, bottom: chr.bottom, left: chr.left, right: chr.right, width: chr.width, height: chr.height,
                     center: chr.left + chr.width / 2 },
      vw: window.innerWidth, vh: window.innerHeight,
    };
  }, chipSel);
}
