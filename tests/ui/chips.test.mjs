// The usage-context per-turn chips and their TWO hover panels, rendered by the
// REAL page script (tests/lib/extract.mjs slices PAGE_JS out of the injector)
// in a real Chromium, against a controllable /turn response.
//
// What is being checked is the pair of surfaces a user actually touches: the
// chips in an assistant turn's footer, and the two hover cards — the app's
// "Turn usage" panel for the token chip and its separate "Turn time and speed"
// panel for the clock chip. The figures are asserted exactly, because these
// chips are a readout of the turn_usage table and a wrong number is the failure
// that matters most.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import {
  newPage, closeBrowser, install, until, deepText, deepAll, deepRects, hover,
  ucCardVisible, ucCardGeom, conversationHtml,
} from "../lib/browser.mjs";
import { startMockSidecar, sampleTurns } from "../lib/mock-sidecar.mjs";
import { usageChips, usageChipsVersion } from "../lib/extract.mjs";

let mock;
before(async () => { mock = await startMockSidecar(); });
// The mock is a single server shared by every test in this file, so state a test
// writes would otherwise be inherited by the next one. Reset to the default
// turn set before each test.
beforeEach(() => {
  mock.state.turns = sampleTurns();
  mock.requests.length = 0;
});
after(async () => { await mock.close(); await closeBrowser(); });

// Boot a page with the chips installed and their first /turn painted.
async function chipsPage(opts = {}) {
  const { script, css } = usageChips(mock.port);
  const page = await newPage(conversationHtml(opts.html || {}));
  await install(page, { script, css });
  return page;
}

// Wait until a "known" chip exists, i.e. the fetch landed and at least one turn
// has accounting. `sel` is a parameter because in the "turn with no accounting"
// tests the FIRST chip is legitimately a dash, so waiting on it would never
// settle; those tests wait on the other turn's wrapper instead.
async function settled(page, sel = ".uc-wrap:not(.uc-unknown)") {
  await until(page, `() => !!document.querySelector(${JSON.stringify(sel)})`, { label: "chip figures" });
}

// Move the pointer somewhere the card cannot be, so the pointerover-on-new-
// element path can close it. A fixed corner would sometimes land on the card
// itself (the card is anchored to the chip), so the point is chosen against the
// card's real rectangle.
async function moveAway(page) {
  const p = await page.evaluate(() => {
    const c = document.querySelector(".uc-card");
    const r = c ? c.getBoundingClientRect() : { left: 0, top: 0, right: 0, bottom: 0 };
    const w = window.innerWidth, h = window.innerHeight;
    for (const [x, y] of [[5, 5], [w - 5, 5], [5, h - 5], [w - 5, h - 5], [w / 2, 5]]) {
      if (x < r.left - 4 || x > r.right + 4 || y < r.top - 4 || y > r.bottom + 4) return { x, y };
    }
    return { x: 5, y: 5 };
  });
  await page.mouse.move(p.x, p.y);
  await page.waitForTimeout(140);
}

// ---------------------------------------------------------------------------
// The chips
// ---------------------------------------------------------------------------

test("each turn's chips read that turn's own figures", async () => {
  const page = await chipsPage({ html: { turnIds: ["msg_1", "msg_2"] } });
  await settled(page);
  const usage = await deepAll(page, ".uc-usage-val");
  const time = await deepAll(page, ".uc-time-val");
  assert.deepEqual(usage, ["729K tok", "2K tok"], "the token chip is a glance figure, rounded to K");
  assert.deepEqual(time, ["43s", "1s"]);
  assert.deepEqual(page.__errors, []);
});

test("the chips sit to the RIGHT of the timestamp in the turn's footer row", async () => {
  const page = await chipsPage({ html: { turnIds: ["msg_1"] } });
  await settled(page);
  const layout = await page.evaluate(() => {
    const wrap = document.querySelector(".uc-wrap");
    const footer = wrap.parentElement;
    const kids = Array.from(footer.children);
    return {
      wrapIsLast: kids.indexOf(wrap) === kids.length - 1,
      tsBefore: kids.indexOf(document.querySelector(".ts")) < kids.indexOf(wrap),
      classes: footer.className,
      tsText: document.querySelector(".ts").textContent.trim(),
    };
  });
  assert.equal(layout.wrapIsLast, true, "the chip wrap must be the footer row's last child");
  assert.equal(layout.tsBefore, true, "the timestamp must come before the chips");
  assert.equal(layout.tsText, "04:46 AM");
});

test("only the turn's FOOTER is chipped, not the other node carrying the same data-turn-id", async () => {
  // The app renders several wrappers with the same data-turn-id. Only the one
  // with the timestamp row is the footer, and only it may get chips — otherwise
  // the same turn is counted twice and the extra chips render in the middle of
  // the reply.
  const page = await chipsPage({ html: { turnIds: ["msg_1"] } });
  await settled(page);
  const counts = await page.evaluate(() => ({
    wraps: document.querySelectorAll(".uc-wrap").length,
    metas: document.querySelectorAll(".uc-wrap").length &&
      document.querySelector(".meta").querySelectorAll(".uc-wrap").length,
  }));
  assert.equal(counts.wraps, 1, "exactly one chip wrap per turn");
  assert.equal(counts.metas, 0, "the timestamp-less wrapper must not be chipped");
});

test("a turn with no accounting renders dimmed dashes, never a figure from another turn", async () => {
  // The response describes msg_2 only; msg_1 is on screen with no accounting.
  mock.set({ turns: sampleTurns({ turns: [sampleTurns().turns[1]] }) });
  const page = await chipsPage({ html: { turnIds: ["msg_1", "msg_2"] } });
  // msg_1's own chip is the dash, so settle on msg_2's known wrapper.
  await settled(page, '.uc-wrap[data-uc-for="msg_2"]:not(.uc-unknown)');
  const chips = await page.evaluate(() => {
    const wraps = Array.from(document.querySelectorAll(".uc-wrap"));
    return wraps.map((w) => ({
      for: w.getAttribute("data-uc-for"),
      unknown: w.classList.contains("uc-unknown"),
      usage: w.querySelector(".uc-usage-val").textContent,
      time: w.querySelector(".uc-time-val").textContent,
    }));
  });
  const unknown = chips.find((c) => c.for === "msg_1");
  const known = chips.find((c) => c.for === "msg_2");
  assert.equal(unknown.unknown, true, "a turn with no accounting is marked unknown");
  assert.equal(unknown.usage, "—");
  assert.equal(unknown.time, "—");
  assert.equal(known.unknown, false);
  assert.equal(known.usage, "2K tok", "the known turn keeps its own figure");
});

test("a draft chat renders no chips at all", async () => {
  const page = await chipsPage({ html: { sessionId: "draft" } });
  await page.waitForTimeout(600);
  assert.equal(await page.evaluate(() => document.querySelectorAll(".uc-wrap").length), 0,
    "an unsent chat must not carry chips");
  assert.equal(await page.evaluate(() => !!document.querySelector(".uc-card")), false);
});

test("the /turn fetch is scoped to the session the app is showing", async () => {
  const page = await chipsPage({ html: { sessionId: "sess_chip_scope" } });
  await settled(page);
  assert.ok(
    mock.requests.some((u) => u.includes("/turn") && u.includes("session=sess_chip_scope")),
    "the chips must ask for the visible session's turns: " + mock.requests.slice(0, 3).join(", ")
  );
});

// ---------------------------------------------------------------------------
// Formatting — the chip is deliberately a glance figure
// ---------------------------------------------------------------------------

test("the token chip rounds to K/M; the exact figure belongs to the panel", async () => {
  mock.set({
    turns: sampleTurns({
      turns: [
        { userMessageId: "msg_1", totalTokens: 1234567, durationMs: 1000, outputTokens: 1, uncachedTokens: 1, model: "m" },
        { userMessageId: "msg_2", totalTokens: 1500, durationMs: 2000, outputTokens: 1, uncachedTokens: 1, model: "m" },
        { userMessageId: "msg_3", totalTokens: 999, durationMs: 3000, outputTokens: 1, uncachedTokens: 1, model: "m" },
      ],
    }),
  });
  const page = await chipsPage({ html: { turnIds: ["msg_1", "msg_2", "msg_3"] } });
  await settled(page);
  assert.deepEqual(await deepAll(page, ".uc-usage-val"), ["1.23M tok", "2K tok", "999 tok"]);
});

test("the clock chip scales s/m/h and keeps sub-second precision in ms", async () => {
  mock.set({
    turns: sampleTurns({
      turns: [
        { userMessageId: "msg_1", totalTokens: 1, durationMs: 43000, outputTokens: 1, uncachedTokens: 1, model: "m" },
        { userMessageId: "msg_2", totalTokens: 1, durationMs: 3700000, outputTokens: 1, uncachedTokens: 1, model: "m" },
        { userMessageId: "msg_3", totalTokens: 1, durationMs: 500, outputTokens: 1, uncachedTokens: 1, model: "m" },
        { userMessageId: "msg_4", totalTokens: 1, durationMs: 2000, outputTokens: 1, uncachedTokens: 1, model: "m" },
      ],
    }),
  });
  const page = await chipsPage({ html: { turnIds: ["msg_1", "msg_2", "msg_3", "msg_4"] } });
  await settled(page);
  // 3,700,000 ms is 1h 2m: the minutes are the ROUNDED remainder (100000 ms of
  // the hour, i.e. 1.67 m), and the chip says so rather than printing "3700s".
  assert.deepEqual(await deepAll(page, ".uc-time-val"), ["43s", "1h 2m", "500ms", "2s"]);
});

// ---------------------------------------------------------------------------
// The two hover panels
// ---------------------------------------------------------------------------

test("hovering the token chip opens the 'Turn usage' panel with the turn's exact accounting", async () => {
  const page = await chipsPage({ html: { turnIds: ["msg_1"] } });
  await settled(page);
  assert.equal(await ucCardVisible(page), false, "the panel must start closed");

  await hover(page, ".uc-usage");
  assert.equal(await ucCardVisible(page), true, "hovering the token chip must open a panel");

  const panel = await page.evaluate(() => {
    const c = document.querySelector(".uc-card");
    return {
      title: c.querySelector(".uc-ct").textContent.trim(),
      headerValue: c.querySelector(".uc-cv") ? c.querySelector(".uc-cv").textContent.trim() : null,
      rows: Array.from(c.querySelectorAll(".uc-cr")).map((r) => ({
        label: r.querySelector(".uc-cl").textContent.trim(),
        value: r.querySelector(".uc-cvv").textContent.trim(),
      })),
      hasDivider: !!c.querySelector(".uc-sep"),
    };
  });
  assert.match(panel.title, /Turn usage/, "the token chip's panel must be the app's Turn usage card");
  // The header is the ONLY place the total appears — full precision, matching
  // the app's own panel, not the chip's rounded glance figure.
  assert.equal(panel.headerValue, "729,123 tok");
  assert.equal(panel.hasDivider, true);
  assert.deepEqual(panel.rows, [
    { label: "Provider / model", value: "Ollama Cloud/deepseek-v4.1-flash:cloud" },
    { label: "Uncached input", value: "100,000 tok" },
    { label: "Output", value: "20,000 tok" },
  ]);
  assert.deepEqual(page.__errors, []);
});

test("hovering the clock chip opens the SEPARATE 'Turn time and speed' panel", async () => {
  const page = await chipsPage({ html: { turnIds: ["msg_1"] } });
  await settled(page);
  await hover(page, ".uc-time");
  assert.equal(await ucCardVisible(page), true);
  const panel = await page.evaluate(() => {
    const c = document.querySelector(".uc-card");
    return {
      title: c.querySelector(".uc-ct").textContent.trim(),
      rows: Array.from(c.querySelectorAll(".uc-cr")).map((r) => ({
        label: r.querySelector(".uc-cl").textContent.trim(),
        value: r.querySelector(".uc-cvv").textContent.trim(),
      })),
    };
  });
  assert.match(panel.title, /Turn time and speed/);
  assert.deepEqual(panel.rows, [{ label: "Total run time", value: "43s" }]);
});

test("the time panel's header carries no figure — its only row already states it", async () => {
  // Printing "43s" in the header of a one-row card would state the same number
  // twice in two lines, which reads as a mistake (the VERSION 8 fix).
  const page = await chipsPage({ html: { turnIds: ["msg_1"] } });
  await settled(page);
  await hover(page, ".uc-time");
  const header = await page.evaluate(() => {
    const c = document.querySelector(".uc-card");
    const cv = c.querySelector(".uc-cv");
    return { hasValue: !!cv, value: cv ? cv.textContent.trim() : null, rowCount: c.querySelectorAll(".uc-cr").length };
  });
  assert.equal(header.hasValue, false, "the time panel's header must render the title alone");
  assert.equal(header.rowCount, 1);
});

test("the two chips open two DIFFERENT panels, and the second hover replaces the first", async () => {
  const page = await chipsPage({ html: { turnIds: ["msg_1"] } });
  await settled(page);
  await hover(page, ".uc-usage");
  assert.match(await deepText(page, ".uc-ct"), /Turn usage/);
  await hover(page, ".uc-time");
  assert.match(await deepText(page, ".uc-ct"), /Turn time and speed/);
  assert.match(await deepText(page, ".uc-cl"), /Total run time/);
  // Exactly one card exists: the panel is replaced, never stacked.
  assert.equal(await page.evaluate(() => document.querySelectorAll(".uc-card").length), 1);
});

test("the second turn's chips open THAT turn's panel, not the first one's", async () => {
  const page = await chipsPage({ html: { turnIds: ["msg_1", "msg_2"] } });
  await settled(page);
  await hover(page, '.uc-wrap[data-uc-for="msg_2"] .uc-usage');
  const rows = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".uc-card .uc-cr")).map((r) => r.querySelector(".uc-cvv").textContent.trim())
  );
  assert.deepEqual(rows, ["Anthropic/claude-sonnet-4.6", "800 tok", "300 tok"],
    "hovering turn two must show turn two's accounting");
});

test("a turn with no accounting never opens a panel of dashes", async () => {
  mock.set({ turns: sampleTurns({ turns: [sampleTurns().turns[1]] }) }); // msg_2 only
  const page = await chipsPage({ html: { turnIds: ["msg_1", "msg_2"] } });
  await settled(page, '.uc-wrap[data-uc-for="msg_2"]:not(.uc-unknown)');
  await hover(page, '.uc-wrap[data-uc-for="msg_1"] .uc-usage');
  assert.equal(await ucCardVisible(page), false, "an unaccounted turn must not open a panel");
  assert.deepEqual(page.__errors, []);
});

test("a missing turn in the response leaves the other turns' panels working", async () => {
  mock.set({ turns: sampleTurns({ turns: [sampleTurns().turns[0]] }) }); // msg_1 only
  const page = await chipsPage({ html: { turnIds: ["msg_1", "msg_2"] } });
  await settled(page, '.uc-wrap[data-uc-for="msg_1"]:not(.uc-unknown)');
  await hover(page, '.uc-wrap[data-uc-for="msg_2"] .uc-time');
  assert.equal(await ucCardVisible(page), false, "the unknown turn stays closed");
  await hover(page, '.uc-wrap[data-uc-for="msg_1"] .uc-time');
  assert.equal(await ucCardVisible(page), true, "the known turn still opens");
  assert.equal(await deepText(page, ".uc-card .uc-cvv"), "43s");
});

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

test("the panel is placed above the hovered chip when there is room, and stays on screen", async () => {
  // The room is measured, not assumed: hover once to learn the panel's height,
  // then push the conversation down by more than that and re-check.
  const page = await chipsPage({ html: { turnIds: ["msg_1"], topSpace: 0 } });
  await settled(page);
  await hover(page, ".uc-usage");
  const h = await page.evaluate(() => document.querySelector(".uc-card").getBoundingClientRect().height);
  assert.ok(h > 40, "the panel should have a real height: " + h);
  await page.evaluate((px) => { document.querySelector(".spacer").style.height = px + "px"; }, h + 140);
  await page.waitForTimeout(80);
  await hover(page, ".uc-usage");
  const g = await ucCardGeom(page, ".uc-usage");
  assert.ok(g.card.bottom <= g.chip.top + 0.5,
    `with room above, the panel should sit above the chip: cardBottom=${g.card.bottom} chipTop=${g.chip.top}`);
  // Centered on the hovered chip when that fits, else clamped to the edge it
  // would have overflowed — both are correct placement.
  const centered = Math.abs((g.card.left + g.card.right) / 2 - g.chip.center) <= 2;
  const clamped = g.card.left <= 8.5 || g.card.right >= g.vw - 8.5;
  assert.ok(centered || clamped,
    `panel must centre on the chip (delta ${Math.abs((g.card.left + g.card.right) / 2 - g.chip.center)}px) or clamp to an edge`);
  assert.ok(g.card.left >= 0 && g.card.right <= g.vw + 0.5, "the panel must not overflow horizontally");
  assert.ok(g.card.top >= 0 && g.card.bottom <= g.vh + 0.5, "the panel must not overflow vertically");
});

test("the panel falls below the chip when there is no room above", async () => {
  const page = await chipsPage({ html: { turnIds: ["msg_1"], topSpace: 0 } });
  await settled(page);
  await hover(page, ".uc-usage");
  const g = await ucCardGeom(page, ".uc-usage");
  assert.ok(g.card.top >= g.chip.bottom - 0.5,
    `with no room above, the panel must drop below the chip: cardTop=${g.card.top} chipBottom=${g.chip.bottom}`);
  assert.ok(g.card.bottom <= g.vh + 0.5, "the dropped panel must still be on screen");
});

test("the panel is anchored to the chip that was hovered, not to the whole row", async () => {
  // The two chips of one turn sit side by side; the panel must centre over the
  // hovered one, which is what makes the hover feel attached to the pointer.
  const page = await chipsPage({ html: { turnIds: ["msg_1"], topSpace: 300 } });
  await settled(page);
  const centers = {};
  for (const [which, sel] of [["usage", ".uc-usage"], ["time", ".uc-time"]]) {
    await hover(page, sel);
    const g = await ucCardGeom(page, sel);
    centers[which] = (g.card.left + g.card.right) / 2 - g.chip.center;
  }
  // Each panel centres on its own chip (each within clamping tolerance).
  assert.ok(Math.abs(centers.usage) <= 2 || centers.usage > 0,
    "the usage panel should centre on (or clamp right of) the usage chip: " + centers.usage);
  assert.ok(Math.abs(centers.time) <= 2 || centers.time < 0,
    "the time panel should centre on (or clamp left of) the time chip: " + centers.time);
});

test("the panel closes when the pointer leaves the chip", async () => {
  const page = await chipsPage({ html: { turnIds: ["msg_1"], topSpace: 300 } });
  await settled(page);
  await hover(page, ".uc-usage");
  assert.equal(await ucCardVisible(page), true);
  await moveAway(page);
  assert.equal(await ucCardVisible(page), false, "the panel must close when the pointer leaves");
});

// ---------------------------------------------------------------------------
// Robustness of the surface itself
// ---------------------------------------------------------------------------

test("a long provider/model string wraps inside the panel instead of painting outside it", async () => {
  // The original defect: the box clamped to a max-width while the glyphs kept
  // going, so a long model name ran out of the card. Every value must stay
  // within the panel's own box.
  const long = "Ollama Cloud/deepseek-v4.1-flash:cloud-with-an-extremely-long-qualifier-that-keeps-going";
  mock.set({ turns: sampleTurns({ turns: [{ userMessageId: "msg_1", totalTokens: 5, durationMs: 1000, outputTokens: 1, uncachedTokens: 1, model: long }] }) });
  const page = await chipsPage({ html: { turnIds: ["msg_1"], topSpace: 300 } });
  await settled(page);
  await hover(page, ".uc-usage");
  const fit = await page.evaluate(() => {
    const c = document.querySelector(".uc-card");
    const cr = c.getBoundingClientRect();
    const over = [];
    for (const el of c.querySelectorAll(".uc-cvv, .uc-ct, .uc-cv")) {
      const r = el.getBoundingClientRect();
      if (r.right > cr.right + 1 || r.left < cr.left - 1) over.push(el.className + ":" + el.textContent.slice(0, 24));
    }
    return { over, scrollW: c.scrollWidth, clientW: c.clientWidth };
  });
  assert.deepEqual(fit.over, [], "no value may exceed the panel's box");
  assert.ok(fit.scrollW <= fit.clientW + 1, `the panel must not scroll horizontally (scroll=${fit.scrollW} client=${fit.clientW})`);
});

test("no page errors across a full hover cycle over both chips", async () => {
  const page = await chipsPage({ html: { turnIds: ["msg_1", "msg_2"] } });
  await settled(page);
  await hover(page, ".uc-usage");
  await hover(page, ".uc-time");
  await hover(page, '.uc-wrap[data-uc-for="msg_2"] .uc-usage');
  await moveAway(page);
  await page.waitForTimeout(1200); // at least one poll
  assert.deepEqual(page.__errors, []);
});

test("a repaint while hovered keeps the panel open and correct", async () => {
  // The chips are repainted on the 2 s poll, which must patch text in place
  // rather than replace the node under the cursor (that would close the panel).
  const page = await chipsPage({ html: { turnIds: ["msg_1"], topSpace: 300 } });
  await settled(page);
  await hover(page, ".uc-usage");
  assert.equal(await ucCardVisible(page), true);
  mock.set({ turns: sampleTurns({ turns: [{ userMessageId: "msg_1", totalTokens: 8888, durationMs: 9000, outputTokens: 400, uncachedTokens: 700, model: "m2" }] }) });
  await until(page, () => document.querySelector(".uc-usage-val").textContent === "9K tok", { label: "repaint", timeout: 6000 });
  assert.equal(await ucCardVisible(page), true, "the panel must survive a repaint");
  assert.equal(await deepText(page, ".uc-card .uc-cv"), "8,888 tok", "the open panel must show the refreshed total");
  assert.deepEqual(page.__errors, []);
});

test("the chip wrap is rebuilt if the app's reconciliation detaches it", async () => {
  const page = await chipsPage({ html: { turnIds: ["msg_1"] } });
  await settled(page);
  await page.evaluate(() => document.querySelector(".uc-wrap").remove());
  await until(page, () => !!document.querySelector(".uc-wrap"), { label: "chip re-created" });
  assert.equal(await deepText(page, ".uc-usage-val"), "729K tok", "the rebuilt chip must carry the figure");
});

// ---------------------------------------------------------------------------
// Re-injection
// ---------------------------------------------------------------------------

test("a re-injection is a no-op while the generation is current", async () => {
  const { script, css } = usageChips(mock.port);
  const page = await newPage(conversationHtml({ turnIds: ["msg_1"] }));
  assert.notEqual(await install(page, { script, css }), "already");
  await settled(page);
  assert.equal(await install(page, { script, css }), "already");
  assert.equal(await page.evaluate(() => document.querySelectorAll(".uc-wrap").length), 1,
    "a second injection must not append a second wrap");
  // The card host is created lazily on the first hover, so it must be opened
  // once before it can be counted — the point is that the second injection did
  // not create a SECOND host (an orphaned generation would).
  await hover(page, ".uc-usage");
  assert.equal(await page.evaluate(() => document.querySelectorAll(".uc-card-host").length), 1);
  assert.equal(await page.evaluate(() => document.querySelectorAll(".uc-card").length), 1);
});

test("a superseding generation sweeps the previous generation's nodes instead of duplicating them", async () => {
  // A real supersede (a plugin update, or a version bump) arrives as the SAME
  // page script with a different VERSION, re-evaluated against the SAME
  // window.__usageContext singleton. That shared identity is what lets the new
  // generation shut the old one down: the old closure's owner() compares its
  // captured epoch against the singleton's, so bumping the singleton's version
  // makes the old generation stand down. The stale nodes a previous generation
  // left are then swept and rebuilt — never duplicated.
  const { script, css } = usageChips(mock.port);
  const page = await newPage(conversationHtml({ turnIds: ["msg_1"] }));
  await install(page, { script, css });
  await settled(page);
  await hover(page, ".uc-usage"); // creates the card host, as a real session would
  await page.evaluate(() => {
    // Plant a previous generation's leftovers: a chip wrap and a card host.
    const stale = document.createElement("span");
    stale.className = "uc-wrap";
    stale.setAttribute("data-uc-for", "msg_1");
    document.querySelector(".footer").appendChild(stale);
    const host = document.createElement("div");
    host.className = "uc-card-host";
    document.body.appendChild(host);
    // Force the running generation to look superseded, on the shared singleton.
    window.__usageContext.version = "0-stale";
  });
  assert.notEqual(await install(page, { script, css }), "already", "a changed generation must not be dismissed as already current");
  await until(page, () => document.querySelectorAll(".uc-wrap").length === 1, { label: "stale wraps swept" });
  assert.equal(await page.evaluate(() => document.querySelectorAll(".uc-wrap").length), 1,
    "the previous generation's wrap must be swept, not left behind");
  assert.equal(await page.evaluate(() => document.querySelectorAll(".uc-card-host").length), 0,
    "the previous generation's card host must be swept (the new one is created lazily)");
  await settled(page);
  await hover(page, ".uc-usage");
  assert.equal(await page.evaluate(() => document.querySelectorAll(".uc-card-host").length), 1);
  assert.equal(await page.evaluate(() => document.querySelectorAll(".uc-card").length), 1);
  assert.equal(await deepText(page, ".uc-usage-val"), "729K tok", "the rebuilt chips must carry the figures");
});

test("the script's VERSION is a non-empty identity", async () => {
  const v = usageChipsVersion();
  assert.equal(typeof v, "string");
  assert.ok(v.length > 0, "the chips must carry a version so a re-injection is recognisable");
});
