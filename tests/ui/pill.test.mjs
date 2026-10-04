// The composer pill and its hover card, rendered by the REAL page script in a
// real Chromium against a controllable sidecar.
//
// This is the plugin's visible surface, so the assertions are about what a
// human would see: the numbers in the pill, the figures in the card, where the
// card is placed, and that a hover never shows a card full of dashes. The
// script is the shipping one (tests/lib/extract.mjs), so a change to the pill
// that breaks any of this fails here.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import {
  newPage, closeBrowser, install, until, deepText, deepAll, deepRects, hover, unhover,
  cardVisible, composerHtml,
} from "../lib/browser.mjs";
import { startMockSidecar, sampleSnapshot } from "../lib/mock-sidecar.mjs";
import { statsPill, statsPillVersion, statsCardSkeleton } from "../lib/extract.mjs";

let mock;
before(async () => { mock = await startMockSidecar(); });
// The mock is one server shared by every test in this file, so its state would
// otherwise leak forward: a test that set an empty snapshot would leave the next
// test's pill empty and its waits would time out. Reset before each test.
beforeEach(() => { mock.state.stats = sampleSnapshot(); mock.requests.length = 0; });
after(async () => { await mock.close(); await closeBrowser(); });

// Boot a page with the pill script installed and its first snapshot painted.
async function pillPage(opts = {}) {
  const layout = opts.layout || "wide";
  const { script, css } = statsPill(layout, mock.port);
  const page = await newPage(composerHtml(opts.html || {}));
  await install(page, { script, css });
  await until(page, () => !!document.querySelector(".zcode-stats-pill-host"), { label: "pill host" });
  return page;
}

// Wait until the pill's rate text is no longer the skeleton dash.
async function settled(page) {
  await until(
    page,
    () => {
      const h = document.querySelector(".zcode-stats-pill-host");
      const b = h && h.shadowRoot && h.shadowRoot.querySelector(".pill .b");
      return b && b.textContent !== "—";
    },
    { label: "pill figures" }
  );
}

test("the pill renders the last request's rate and TTFT", async () => {
  mock.set({ stats: sampleSnapshot() });
  const page = await pillPage();
  await settled(page);
  assert.equal(await deepText(page, ".pill .b"), "310.1");
  assert.equal(await deepText(page, ".pill .u"), "tok/s");
  assert.equal(await deepText(page, ".pill .t"), "420ms");
  assert.deepEqual(page.__errors, []);
});

test("the pill is attached inside the composer toolbar, next to the + button", async () => {
  const page = await pillPage();
  await settled(page);
  const parent = await page.evaluate(() => {
    const h = document.querySelector(".zcode-stats-pill-host");
    return { tag: h.parentElement.getAttribute("data-composer-leading-content") !== null,
             cls: h.parentElement.className };
  });
  assert.equal(parent.tag, true, "the pill must be appended into the composer leading content");
  // And it must come after the leading child, i.e. immediately right of it.
  const order = await page.evaluate(() => {
    const h = document.querySelector(".zcode-stats-pill-host");
    const kids = Array.from(h.parentElement.children);
    return { index: kids.indexOf(h), count: kids.length };
  });
  assert.equal(order.count, 2, "toolbar should be: leading element, then the pill host");
  assert.equal(order.index, 1);
});

test("an idle pill hides the live dot; a streaming one shows it", async () => {
  mock.set({ stats: sampleSnapshot({ live: undefined }) });
  const page = await pillPage();
  await settled(page);
  assert.equal(await deepText(page, ".pill.idle") !== null, true, "idle class expected with no live request");
  assert.equal(
    await page.evaluate(() => document.querySelector(".zcode-stats-pill-host").shadowRoot.querySelector(".pill .dot").style.display),
    "none"
  );
  // Now flip the sidecar to report a live request: the poller must pick it up.
  mock.set({ stats: sampleSnapshot({ live: { streaming: true, estTps: 123.4, model: "m" } }) });
  await until(page, () => {
    const sh = document.querySelector(".zcode-stats-pill-host").shadowRoot;
    return sh.querySelector(".pill .dot").style.display !== "none";
  }, { label: "live dot" });
  assert.equal(await deepText(page, ".pill .b"), "123.4", "the live estimate must replace the last rate");
  assert.deepEqual(page.__errors, []);
});

test("hovering the pill opens the card already filled (never a card of dashes)", async () => {
  const page = await pillPage();
  await settled(page);
  // Card must start closed (computed style: an unopened card's inline display
  // is "", so comparing it to "none" would be wrong).
  assert.equal(await cardVisible(page), false, "card should start closed");
  await hover(page, ".zcode-stats-pill-host");
  assert.equal(await cardVisible(page), true, "hover must open the card");
  assert.equal(await deepText(page, ".cardp .c-req"), "3 requests");
});

test("the card shows the latest request, the window averages and the session totals", async () => {
  mock.set({ stats: sampleSnapshot() });
  const page = await pillPage();
  await settled(page);
  await hover(page, ".zcode-stats-pill-host");
  const values = {
    lasttps: await deepText(page, ".cardp .v-lasttps"),
    lastttft: await deepText(page, ".cardp .v-lastttft"),
    tps: await deepText(page, ".cardp .v-tps"),
    ttft: await deepText(page, ".cardp .v-ttft"),
    turns: await deepText(page, ".cardp .v-turns"),
    steps: await deepText(page, ".cardp .v-steps"),
    toolcalls: await deepText(page, ".cardp .v-toolcalls"),
    avg: await deepText(page, ".cardp .c-avg"),
  };
  assert.equal(values.lasttps, "310.1 tok/s");
  assert.equal(values.lastttft, "420ms");
  assert.equal(values.tps, "240.5 tok/s");
  assert.equal(values.ttft, "420ms");
  assert.equal(values.turns, "2");
  assert.equal(values.steps, "5");
  assert.equal(values.toolcalls, "7");
  assert.equal(values.avg, "240.5 tok/s");
});

test("the card's token panel matches the app's own decomposition", async () => {
  mock.set({ stats: sampleSnapshot() });
  const page = await pillPage();
  await settled(page);
  await hover(page, ".zcode-stats-pill-host");
  assert.equal(await deepText(page, ".cardp .v-toktotal"), "20,000 tok");
  assert.equal(await deepText(page, ".cardp .v-cachehit"), "40%");
  assert.equal(await deepText(page, ".cardp .v-uncached"), "18,000 tok");
  assert.equal(await deepText(page, ".cardp .v-cached"), "12,000 tok");
  assert.equal(await deepText(page, ".cardp .v-output"), "2,000 tok");
});

test("the card's window label follows the server's window, not a hardcoded 10", async () => {
  mock.set({ stats: sampleSnapshot({ window: { window: 25, samples: 25, avgTps: 200, peakTps: 300, avgTtftMs: 100 } }) });
  const page = await pillPage();
  await settled(page);
  await hover(page, ".zcode-stats-pill-host");
  assert.equal(await deepText(page, ".cardp .cwin"), "25");
  assert.equal(await deepText(page, ".cardp .cwin2"), "25");
});

test("the card is positioned ABOVE the pill and stays inside the window", async () => {
  // "Above" is only the expectation when the card actually fits above the pill,
  // and the card's height depends on font metrics, so the room is measured
  // rather than assumed: hover once to learn the height, then push the composer
  // down by more than that and re-check.
  const page = await pillPage();
  await settled(page);
  await hover(page, ".zcode-stats-pill-host");
  const height = await page.evaluate(() => document.querySelector(".zcode-stats-pill-host").shadowRoot.querySelector(".cardp").getBoundingClientRect().height);
  assert.ok(height > 100, "the card should have a real height: " + height);
  // Give the page enough room above the pill for the measured card.
  await page.evaluate((h) => { document.querySelector(".spacer").style.height = (h + 120) + "px"; }, height);
  await page.waitForTimeout(80);
  await hover(page, ".zcode-stats-pill-host");
  const geom = await page.evaluate(() => {
    const host = document.querySelector(".zcode-stats-pill-host");
    const card = host.shadowRoot.querySelector(".cardp");
    const p = host.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    return { pillTop: p.top, pillCenter: p.left + p.width / 2, cardBottom: c.bottom, cardCenter: c.left + c.width / 2,
             cardLeft: c.left, cardRight: c.right, cardTop: c.top, cardH: c.height, vw: window.innerWidth, vh: window.innerHeight };
  });
  assert.ok(geom.cardBottom <= geom.pillTop + 0.5,
    `with room above, the card should sit above the pill: cardBottom=${geom.cardBottom} pillTop=${geom.pillTop} cardH=${geom.cardH}`);
  // Horizontal placement: centered on the pill when that fits, otherwise flush
  // to the viewport edge it would have overflowed. Both are correct; asserting
  // only "centered" would fail whenever the card is wider than the room to its
  // left, which is the common case for a pill near the window edge.
  const centered = Math.abs(geom.cardCenter - geom.pillCenter) <= 2;
  const clampedLeft = geom.cardLeft <= 8.5;
  const clampedRight = geom.cardRight >= geom.vw - 8.5;
  assert.ok(centered || clampedLeft || clampedRight,
    `card must be centered on the pill (delta ${Math.abs(geom.cardCenter - geom.pillCenter)}px) or clamped to an edge; ` +
    `cardLeft=${geom.cardLeft} cardRight=${geom.cardRight} vw=${geom.vw}`);
  // And fully on screen, both axes.
  assert.ok(geom.cardLeft >= 0 && geom.cardRight <= geom.vw + 0.5, "card must not overflow the viewport horizontally");
  assert.ok(geom.cardTop >= 0 && geom.cardBottom <= geom.vh + 0.5, "card must not overflow the viewport vertically");
});

test("the card falls BELOW the pill when there is no room above", async () => {
  // With the composer at the very top, and the card taller than the space above
  // the pill (measured, not assumed — see the previous test), the card must drop
  // below rather than be clipped off the top of the window.
  const page = await pillPage();
  await settled(page);
  await page.evaluate(() => { document.querySelector(".spacer").style.height = "0px"; });
  await page.waitForTimeout(80);
  await hover(page, ".zcode-stats-pill-host");
  const geom = await page.evaluate(() => {
    const host = document.querySelector(".zcode-stats-pill-host");
    const card = host.shadowRoot.querySelector(".cardp");
    const p = host.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    return { pillTop: p.top, pillBottom: p.bottom, cardTop: c.top, cardBottom: c.bottom, vh: window.innerHeight };
  });
  assert.ok(geom.cardTop >= geom.pillBottom - 0.5,
    `with no room above, the card must drop below the pill: cardTop=${geom.cardTop} pillBottom=${geom.pillBottom}`);
  assert.ok(geom.cardBottom <= geom.vh + 0.5, "the dropped card must still be on screen");
});

test("the card closes when the pointer leaves", async () => {
  const page = await pillPage();
  await settled(page);
  await hover(page, ".zcode-stats-pill-host");
  assert.equal(await page.evaluate(() => document.querySelector(".zcode-stats-pill-host").shadowRoot.querySelector(".cardp").style.display), "block");
  await unhover(page);
  assert.equal(await page.evaluate(() => document.querySelector(".zcode-stats-pill-host").shadowRoot.querySelector(".cardp").style.display), "none");
});

test("a draft chat shows no figures at all (never the previous chat's numbers)", async () => {
  // data-session-id="draft" is a brand-new unsent chat. The pill must clear
  // rather than display another session's rate.
  const { script, css } = statsPill("wide", mock.port);
  const page = await newPage(composerHtml({ sessionId: "draft" }));
  await install(page, { script, css });
  await until(page, () => !!document.querySelector(".zcode-stats-pill-host"), { label: "host" });
  await page.waitForTimeout(500); // give the first fetch time to be skipped
  assert.equal(await deepText(page, ".pill .b"), "—");
  assert.equal(await deepText(page, ".pill .t"), "");
  // And the card must refuse to open with dashes.
  await hover(page, ".zcode-stats-pill-host");
  assert.equal(await cardVisible(page), false, "a draft chat must not open a card of dashes");
});

test("an empty session shows the empty state, and its card reports zero rather than stale data", async () => {
  mock.set({ stats: sampleSnapshot({ last: null, window: { window: 0, samples: 0, avgTps: null, peakTps: null, avgTtftMs: null },
    session: { samples: 0, requests: 0, avgTps: null, peakTps: null, outputTokens: 0, reasoningTokens: 0, inputTokens: 0, cacheRead: 0,
      tokens: { total: 0, cached: 0, uncached: 0, output: 0, cacheHitPct: null }, models: [], modelCount: 0 } }) });
  const page = await pillPage();
  await until(page, () => {
    const sh = document.querySelector(".zcode-stats-pill-host").shadowRoot;
    return sh.querySelector(".pill .b").textContent === "—";
  }, { label: "empty pill" });
  // The pill must read as empty, not as a zero rate.
  assert.equal(await deepText(page, ".pill .b"), "—");
  assert.equal(await deepText(page, ".pill .t"), "");
  assert.equal(await deepText(page, ".pill.idle") !== null, true, "an empty session is idle");
  // Hovering an empty session: the card may open (a snapshot exists), but it
  // must report the empty session honestly rather than showing a figure from any
  // other session. Note the deliberate difference from the draft case above,
  // where no snapshot has landed at all and the card stays shut: both are
  // honest, and the distinction is whether a snapshot exists, not whether it
  // holds numbers.
  await hover(page, ".zcode-stats-pill-host");
  if (await cardVisible(page)) {
    assert.equal(await deepText(page, ".cardp .c-req"), "0 requests");
    // Rates are absent, so they render as a dash...
    assert.equal(await deepText(page, ".cardp .v-lasttps"), "—", "no stale rate may survive an empty snapshot");
    assert.equal(await deepText(page, ".cardp .c-avg"), "—");
    // ...while a token count of zero is a real figure and renders as zero,
    // not as "no data".
    assert.equal(await deepText(page, ".cardp .v-toktotal"), "0 tok");
  }
});

test("the pill collapses to the bolt glyph when the row is too narrow", async () => {
  const page = await pillPage();
  await settled(page);
  // A roomy row keeps the full form.
  assert.equal(await page.evaluate(() => document.querySelector(".zcode-stats-pill-host").shadowRoot.querySelector(".pill").classList.contains("min")), false);
  // Squeeze the composer so the full "310.1 tok/s · 420ms" cannot fit. The
  // script measures the free space in its own row, so narrowing the row (and the
  // viewport with it) is what triggers the collapse.
  await page.setViewportSize({ width: 260, height: 600 });
  await page.evaluate(() => {
    document.querySelector(".composer").style.width = "240px";
    document.querySelector(".row").style.width = "20px";
    const lead = document.querySelector(".lead");
    if (lead) lead.style.display = "none";
  });
  await until(page, () => document.querySelector(".zcode-stats-pill-host").shadowRoot.querySelector(".pill").classList.contains("min"), { label: "collapse", timeout: 5000 });
  const bolt = await page.evaluate(() => getComputedStyle(document.querySelector(".zcode-stats-pill-host").shadowRoot.querySelector(".pill .bolt")).display);
  assert.notEqual(bolt, "none", "the bolt glyph must be visible when collapsed");
  // And the card stays reachable — collapsing relocates the data, it does not
  // hide it.
  await hover(page, ".zcode-stats-pill-host");
  assert.equal(await cardVisible(page), true, "the card must still open while collapsed");
  assert.equal(await deepText(page, ".cardp .v-lasttps"), "310.1 tok/s");
});

test("the pill host is re-appended if the app detaches it", async () => {
  // The app's React reconciliation drops our node; the MutationObserver must put
  // it straight back, because a pill that vanishes reads as a bug.
  const page = await pillPage();
  await settled(page);
  await page.evaluate(() => document.querySelector(".zcode-stats-pill-host").remove());
  await until(page, () => !!document.querySelector(".zcode-stats-pill-host"), { label: "reattach" });
  assert.equal(await deepText(page, ".pill .b"), "310.1", "the re-appended host must keep its painted text");
});

test("a re-injection is a no-op while the generation is current", async () => {
  const { script, css } = statsPill("wide", mock.port);
  const page = await newPage(composerHtml({}));
  assert.notEqual(await install(page, { script, css }), "already");
  await until(page, () => !!document.querySelector(".zcode-stats-pill-host"), { label: "host" });
  assert.equal(await install(page, { script, css }), "already");
  // Exactly one host must exist — no orphan generations.
  const hosts = await page.evaluate(() => document.querySelectorAll(".zcode-stats-pill-host").length);
  assert.equal(hosts, 1);
});

test("flipping the card density re-injects and supersedes the running generation", async () => {
  // The layout is part of the script's VERSION identity: switching wide<->compact
  // must produce a different script so the new look applies live.
  assert.notEqual(statsPillVersion("wide"), statsPillVersion("compact"));
  const wide = statsPill("wide", mock.port);
  const compact = statsPill("compact", mock.port);
  const page = await newPage(composerHtml({}));
  await install(page, wide);
  await until(page, () => !!document.querySelector(".zcode-stats-pill-host"), { label: "host" });
  // The wide card carries no "compact" class.
  assert.equal(await page.evaluate(() => document.querySelector(".zcode-stats-pill-host").shadowRoot.querySelector(".cardp").classList.contains("compact")), false);
  // Injecting the compact script must NOT be dismissed as "already".
  assert.notEqual(await install(page, compact), "already");
  await until(page, () => {
    const h = document.querySelector(".zcode-stats-pill-host");
    return h && h.shadowRoot && h.shadowRoot.querySelector(".cardp") &&
      h.shadowRoot.querySelector(".cardp").classList.contains("compact");
  }, { label: "compact card" });
  assert.equal(await page.evaluate(() => document.querySelectorAll(".zcode-stats-pill-host").length), 1, "the superseded host must be cleaned up");
});

test("both densities render the same content, differing only in geometry", async () => {
  for (const layout of ["wide", "compact"]) {
    const { script, css } = statsPill(layout, mock.port);
    const page = await newPage(composerHtml({}));
    mock.set({ stats: sampleSnapshot() });
    await install(page, { script, css });
    await settled(page);
    await hover(page, ".zcode-stats-pill-host");
    assert.equal(await deepText(page, ".cardp .v-lasttps"), "310.1 tok/s", `${layout}: content must match`);
    assert.equal(await deepText(page, ".cardp .c-req"), "3 requests", `${layout}: content must match`);
  }
});

test("a compact card is narrower than a wide one", async () => {
  const widths = {};
  for (const layout of ["wide", "compact"]) {
    const { script, css } = statsPill(layout, mock.port);
    const page = await newPage(composerHtml({}));
    mock.set({ stats: sampleSnapshot() });
    await install(page, { script, css });
    await settled(page);
    await hover(page, ".zcode-stats-pill-host");
    widths[layout] = await page.evaluate(() => document.querySelector(".zcode-stats-pill-host").shadowRoot.querySelector(".cardp").getBoundingClientRect().width);
    await page.close();
  }
  assert.ok(widths.compact < widths.wide, `compact (${widths.compact}) should be narrower than wide (${widths.wide})`);
});

test("the card's structure matches the script's own skeleton", async () => {
  // Guards against the skeleton drifting from what a test expects: the rows
  // present in the DOM must be exactly the rows the script builds.
  const skeleton = statsCardSkeleton();
  const classes = [...skeleton.matchAll(/class="([^"]+)"/g)].map((m) => m[1]);
  const page = await pillPage();
  await settled(page);
  await hover(page, ".zcode-stats-pill-host");
  const dom = await page.evaluate(() => document.querySelector(".zcode-stats-pill-host").shadowRoot.querySelector(".cardp").innerHTML);
  for (const cls of classes) {
    const first = cls.split(/\s+/)[0];
    assert.ok(dom.includes(`class="${cls}"`), `card is missing the skeleton's "${cls}" node`);
  }
});

test("no page errors across a full hover cycle and a live update", async () => {
  const page = await pillPage();
  await settled(page);
  await hover(page, ".zcode-stats-pill-host");
  mock.set({ stats: sampleSnapshot({ live: { streaming: true, estTps: 99, model: "m" } }) });
  await page.waitForTimeout(1200); // at least one poll
  assert.deepEqual(page.__errors, []);
});

test("the sidecar fetch is scoped to the session the app is showing", async () => {
  mock.requests.length = 0;
  const page = await pillPage({ html: { sessionId: "sess_scope_check" } });
  await settled(page);
  assert.ok(
    mock.requests.some((u) => u.includes("session=sess_scope_check")),
    "the pill must ask for the visible session's stats: " + mock.requests.slice(0, 3).join(", ")
  );
});
