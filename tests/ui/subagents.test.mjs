// The subagent-activity block in the pill's hover card — the separate surface.
//
// Subagent requests live in their own sessions and cannot be linked to a parent
// turn, so the plugin reports them as a machine-wide time window and NEVER mixes
// them into the session figures. What a human must see: nothing at all when no
// subagent ran (the card unchanged for most users), and a clearly separate block
// when one did. Rendered by the REAL page script against a controllable sidecar.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { newPage, closeBrowser, install, until, deepText, hover, unhover, cardVisible, composerHtml } from "../lib/browser.mjs";
import { startMockSidecar, sampleSnapshot, sampleSubagents } from "../lib/mock-sidecar.mjs";
import { statsPill } from "../lib/extract.mjs";

let mock;
before(async () => { mock = await startMockSidecar(); });
beforeEach(() => { mock.state.stats = sampleSnapshot(); mock.requests.length = 0; });
after(async () => { await mock.close(); await closeBrowser(); });

async function pillPage(opts = {}) {
  const { script, css } = statsPill(opts.layout || "wide", mock.port);
  const page = await newPage(composerHtml(opts.html || {}));
  await install(page, { script, css });
  await until(page, () => !!document.querySelector(".zcode-stats-pill-host"), { label: "pill host" });
  // Wait for figures so the card has data and can open on hover. Skipped when a
  // test deliberately has no session figures (the pill's own rate stays a dash
  // by design), in which case only the host mount is awaited.
  if (!opts.noFigures) {
    await until(page, () => {
      const h = document.querySelector(".zcode-stats-pill-host");
      const b = h && h.shadowRoot && h.shadowRoot.querySelector(".pill .b");
      return b && b.textContent !== "—";
    }, { label: "pill figures" });
  } else {
    // Give the first snapshot a moment to land so the card has data to show.
    await page.waitForTimeout(900);
  }
  return page;
}

// Is the subagent block visible in the open card? Reads computed display, so it
// distinguishes "hidden by display:none" from "never rendered".
async function subVisible(page) {
  return await page.evaluate(() => {
    const h = document.querySelector(".zcode-stats-pill-host");
    const s = h && h.shadowRoot && h.shadowRoot.querySelector(".csub");
    return !!s && getComputedStyle(s).display !== "none";
  });
}

test("with no subagent activity the card hides the subagent block entirely", async () => {
  // Default snapshot carries no `subagents`, matching a machine that never
  // spawned one. The block must not appear, so the card is unchanged for the
  // majority of users.
  mock.set({ stats: sampleSnapshot() });
  const page = await pillPage();
  await hover(page, ".zcode-stats-pill-host");
  assert.equal(await cardVisible(page), true, "the card itself must still open");
  assert.equal(await subVisible(page), false, "no subagent block without subagent activity");
});

test("a running subagent surfaces its count and agent in the card", async () => {
  mock.set({
    stats: sampleSnapshot({
      subagents: sampleSubagents({ running: 1, runningAgents: ["zcode-Explore"], requests: 12, avgTps: 88.4, avgTtftMs: 1450 }),
    }),
  });
  const page = await pillPage();
  await hover(page, ".zcode-stats-pill-host");
  assert.equal(await subVisible(page), true, "subagent activity must show its block");
  assert.equal(await deepText(page, ".csub .v-subtps"), "88.4 tok/s");
  // 1450 ms is under the 10 s threshold, so it renders in ms (not "1.5s").
  assert.equal(await deepText(page, ".csub .v-subttft"), "1450ms");
  // The count names the state: "running now" when one is in flight.
  assert.match(await deepText(page, ".csub .v-subcount"), /12 reqs · running now/);
});

test("a completed subagent names its agent when only one kind ran", async () => {
  mock.set({
    stats: sampleSnapshot({
      subagents: sampleSubagents({
        running: 0, runningAgents: [], requests: 3, avgTps: 120,
        avgTtftMs: 800,
        agents: [{ agent: "zcode-Explore", requests: 3, sessions: 1, avgTps: 120, peakTps: 150, avgTtftMs: 800, outputTokens: 900, lastAt: Date.now() }],
      }),
    }),
  });
  const page = await pillPage();
  await hover(page, ".zcode-stats-pill-host");
  assert.equal(await subVisible(page), true);
  assert.match(await deepText(page, ".csub .v-subcount"), /3 reqs · zcode-Explore/);
});

test("multiple agents are summarised by count, not by one name", async () => {
  mock.set({ stats: sampleSnapshot({ subagents: sampleSubagents({ running: 0, runningAgents: [] }) }) });
  const page = await pillPage();
  await hover(page, ".zcode-stats-pill-host");
  // sampleSubagents has two agent kinds, so the label must say "2 agents".
  assert.match(await deepText(page, ".csub .v-subcount"), /12 reqs · 2 agents/);
});

test("a single subagent request is labelled 'req', not 'reqs'", async () => {
  mock.set({
    stats: sampleSnapshot({
      subagents: sampleSubagents({ running: 0, runningAgents: [], requests: 1, agents: [{ agent: "zcode-Explore", requests: 1 }] }),
    }),
  });
  const page = await pillPage();
  await hover(page, ".zcode-stats-pill-host");
  assert.match(await deepText(page, ".csub .v-subcount"), /1 req · zcode-Explore/);
});

test("the subagent block does not disturb the session figures above it", async () => {
  mock.set({ stats: sampleSnapshot({ subagents: sampleSubagents() }) });
  const page = await pillPage();
  await hover(page, ".zcode-stats-pill-host");
  // The session rows must read exactly as they do without any subagent activity:
  // the surface is additive, never a merge.
  assert.equal(await deepText(page, ".csub .v-subtps"), "88.4 tok/s");
  assert.equal(await deepText(page, ".c-avg"), "240.5 tok/s", "the session average must be unchanged");
  assert.equal(await deepText(page, ".v-toktotal"), "20,000 tok", "the session token total must be unchanged");
});

test("the subagent block updates live without a reload", async () => {
  mock.set({ stats: sampleSnapshot({ subagents: sampleSubagents({ requests: 12, avgTps: 88.4 }) }) });
  const page = await pillPage();
  await hover(page, ".zcode-stats-pill-host");
  assert.equal(await deepText(page, ".csub .v-subtps"), "88.4 tok/s");
  // A new snapshot with more activity must repaint the same open card.
  mock.set({ stats: sampleSnapshot({ subagents: sampleSubagents({ requests: 30, avgTps: 150.2, running: 1, runningAgents: ["zcode-Explore"] }) }) });
  await until(page, () => {
    const h = document.querySelector(".zcode-stats-pill-host");
    const v = h && h.shadowRoot && h.shadowRoot.querySelector(".csub .v-subtps");
    return v && v.textContent === "150.2 tok/s";
  }, { label: "subagent repaint" });
  assert.match(await deepText(page, ".csub .v-subcount"), /30 reqs · running now/);
});

test("activity disappearing hides the block again", async () => {
  mock.set({ stats: sampleSnapshot({ subagents: sampleSubagents() }) });
  const page = await pillPage();
  await hover(page, ".zcode-stats-pill-host");
  assert.equal(await subVisible(page), true);
  // The window closes: the next snapshot has no activity, so the block must go.
  mock.set({ stats: sampleSnapshot({ subagents: sampleSubagents({ requests: 0, running: 0, runningAgents: [], agents: [] }) }) });
  await until(page, () => {
    const h = document.querySelector(".zcode-stats-pill-host");
    const s = h && h.shadowRoot && h.shadowRoot.querySelector(".csub");
    return !!s && getComputedStyle(s).display === "none";
  }, { label: "subagent block hidden again" });
});

test("the subagent block also appears for a draft chat with no session activity", async () => {
  // A subagent can be running while the composer shows a fresh chat with no
  // requests of its own, so the block must not depend on session data. The
  // sidecar's draft handling returns an empty snapshot; the subagent block
  // rides the same payload and must still render.
  mock.set({
    stats: sampleSnapshot({
      session: { samples: 0, requests: 0, avgTps: null, tokens: {}, models: [] },
      last: null,
      window: { window: 0, samples: 0, avgTps: null, avgTtftMs: null },
      subagents: sampleSubagents({ running: 1, runningAgents: ["zcode-Explore"], requests: 4, avgTps: 95 }),
    }),
  });
  const page = await pillPage({ noFigures: true });
  await hover(page, ".zcode-stats-pill-host");
  // With no session figures the card's own rows are dashes, but the subagent
  // block is real data and must show.
  assert.equal(await subVisible(page), true, "subagent activity must render without session figures");
  assert.equal(await deepText(page, ".csub .v-subtps"), "95 tok/s");
});

test("no page errors across a subagent hover cycle", async () => {
  mock.set({ stats: sampleSnapshot({ subagents: sampleSubagents() }) });
  const page = await pillPage();
  await hover(page, ".zcode-stats-pill-host");
  mock.set({ stats: sampleSnapshot({ subagents: sampleSubagents({ requests: 99, running: 1, runningAgents: ["a", "b"] }) }) });
  await page.waitForTimeout(1200);
  await unhover(page);
  assert.deepEqual(page.__errors, []);
});
