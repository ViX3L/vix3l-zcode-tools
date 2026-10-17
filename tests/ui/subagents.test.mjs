// The subagent block in the pill's hover card — the conversation's own tree.
//
// A subagent's requests are written to its own session, and that session names
// the conversation that spawned it (`session.parent_id`), so the block reports
// what THIS conversation delegated — never another chat's agents and never a
// rolling machine-wide window (which is what made the count fall: 91 → 89 as
// rows aged out; the monotonic property is pinned in tests/unit/metrics).
//
// What a human must see: nothing at all when the session spawned no subagent
// (the card unchanged for most users), a clearly separate block when it did, and
// — because the children's tokens are now part of the session's totals — a share
// row under the token panel saying how much of that total came from subagents.
// Rendered by the REAL page script against a controllable sidecar.
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

// Is the token panel's "Subagent share" row visible?
async function shareVisible(page) {
  return await page.evaluate(() => {
    const h = document.querySelector(".zcode-stats-pill-host");
    const r = h && h.shadowRoot && h.shadowRoot.querySelector(".v-subsharerow");
    return !!r && getComputedStyle(r).display !== "none";
  });
}

// The session token panel as the real sidecar now ships it: the conversation's
// own figures plus the children's, self-consistent throughout.
//   conversation  12000 cached + 18000 uncached + 2000 output = 32,000 (40.0 %)
//   subagents      6000 cached +  2500 uncached +  500 output =  9,000 (70.6 %)
//   tree          18000 cached + 20500 uncached + 2500 output = 41,000 (46.8 %)
//   share         9000 / 41000 = 21.95 % → 22.0
const SESSION_TOKENS = {
  total: 41_000, cached: 18_000, uncached: 20_500, output: 2_500, cacheHitPct: 46.8,
  main: { total: 32_000, cached: 12_000, uncached: 18_000, output: 2_000, cacheHitPct: 40 },
  subagents: { total: 9_000, cached: 6_000, uncached: 2_500, output: 500, cacheHitPct: 70.6 },
  subagentSharePct: 22,
};

test("with no spawned subagent the card hides the subagent block entirely", async () => {
  // The default snapshot carries no `subagents` — the same payload a session
  // whose tree is empty produces. The block must not appear, so the card is
  // byte-identical for the majority of users, who never delegate.
  mock.set({ stats: sampleSnapshot() });
  const page = await pillPage();
  await hover(page, ".zcode-stats-pill-host");
  assert.equal(await cardVisible(page), true, "the card itself must still open");
  assert.equal(await subVisible(page), false, "no subagent block without subagent activity");
  assert.equal(await shareVisible(page), false, "and no share row either");
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
  assert.equal(await deepText(page, ".csub .v-subtokens"), "9,000 tok", "the tree's tokens, as the panel above counts them");
  // The count names the state: "running now" when one is in flight.
  assert.match(await deepText(page, ".csub .v-subcount"), /12 reqs · running now/);
});

test("a completed subagent names its agent when only one kind ran", async () => {
  mock.set({
    stats: sampleSnapshot({
      subagents: sampleSubagents({
        running: 0, runningAgents: [], requests: 3, avgTps: 120, avgTtftMs: 800,
        agents: [{ agent: "zcode-Explore", requests: 3, generated: 900 }],
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

test("the children's tokens are inside the panel, and the share row says how much", async () => {
  // The accuracy fix, visible: the panel's total is the whole tree, and the
  // share row keeps it reconcilable with the app's own conversation-only card.
  mock.set({
    stats: sampleSnapshot({
      session: { tokens: SESSION_TOKENS },
      subagents: sampleSubagents(),
    }),
  });
  const page = await pillPage();
  await hover(page, ".zcode-stats-pill-host");
  assert.equal(await deepText(page, ".v-toktotal"), "41,000 tok", "the panel total is the tree's");
  assert.equal(await deepText(page, ".v-cachehit"), "46.8%", "cache hit describes the whole tree");
  assert.equal(await shareVisible(page), true, "subagents contributed, so the share is stated");
  assert.equal(await deepText(page, ".v-subshare"), "22%");
  // A session with no children shows the same panel and no share row: the row is
  // driven by the payload, never by a guess about what the figure contains.
  mock.set({ stats: sampleSnapshot() });
  await until(page, () => {
    const h = document.querySelector(".zcode-stats-pill-host");
    const r = h && h.shadowRoot && h.shadowRoot.querySelector(".v-subsharerow");
    return !!r && getComputedStyle(r).display === "none";
  }, { label: "share row hidden" });
});

test("the subagent block does not disturb the rate figures above it", async () => {
  mock.set({ stats: sampleSnapshot({ subagents: sampleSubagents() }) });
  const page = await pillPage();
  await hover(page, ".zcode-stats-pill-host");
  // The rate rows must read exactly as they do without any subagent activity:
  // the split is additive in the token panel and nowhere else, so parallel
  // subagent streams can never make "how fast is my conversation running" jump.
  assert.equal(await deepText(page, ".csub .v-subtps"), "88.4 tok/s");
  assert.equal(await deepText(page, ".c-avg"), "240.5 tok/s", "the session average must be unchanged");
  assert.equal(await deepText(page, ".v-toktotal"), "32,000 tok", "the panel total is the payload's, not a merge");
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

test("switching to a session whose tree is empty hides the block again", async () => {
  mock.set({ stats: sampleSnapshot({ subagents: sampleSubagents() }) });
  const page = await pillPage();
  await hover(page, ".zcode-stats-pill-host");
  assert.equal(await subVisible(page), true);
  // The next snapshot belongs to a conversation that never spawned a subagent,
  // so the block must go. It is the payload going quiet that hides it, never a
  // count falling: a session's own tree only ever grows.
  mock.set({
    stats: sampleSnapshot({
      subagents: sampleSubagents({
        requests: 0, running: 0, runningAgents: [], agents: [], sessions: 0, avgTps: null,
        tokens: { total: 0, cached: 0, uncached: 0, output: 0, cacheHitPct: null },
      }),
    }),
  });
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
