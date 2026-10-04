// The stats dashboard, rendered by the REAL page the REAL sidecar serves.
//
// The dashboard is loaded from the sidecar's own /dashboard over HTTP (not
// through setContent), because it fetches with relative paths and its theme
// restoration reads localStorage before first paint — same-origin behaviour is
// part of what is being tested. The fixture DB behind it is hand-built, so the
// figures and the donut geometry are asserted exactly.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeMachine, createDb, addSession, addRequest, cleanup } from "../lib/fixtures.mjs";
import { startSidecar, waitFor, killAllSidecars } from "../lib/sidecar.mjs";
import { newPageAt, closeBrowser, until } from "../lib/browser.mjs";

const SID = "sess_dash_1";
const ESID = "sess_dash_empty";
let machine, sidecar, emptyMachine, emptySidecar;

// Write the state file the sidecar reads to resolve a default session (it is
// the same one the plugin's session-start hook writes).
function writeSessionState(m, sid) {
  const dir = path.join(m.dir, ".zcode");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "tps-monitor.last-session.json"),
    JSON.stringify({ sessionId: sid, ts: Date.now(), source: "test" }));
}

before(async () => {
  machine = makeMachine("dash");
  const db = createDb(machine);
  addSession(db, SID, "Dashboard fixture");
  // A completed set with EXACT arithmetic, so every figure on the page is a
  // number this file states rather than one it hopes for:
  //   24 completed main requests, each 500 generated tokens over 1000 ms
  //     → latest rate 500 tok/s, session output 12,000 tok, 3 pages of 10
  //   model-a 18 requests, model-b 6 → generated 9000 : 3000 = 75% : 25%
  //   the newest request (highest i) is model-a, so the headline names it
  //   plus one CANCELLED row, which the /requests table excludes (it only
  //   lists completed rows) but the status column still has to colour.
  for (let i = 0; i < 24; i++) {
    addRequest(db, {
      sessionId: SID, id: `d_req_${String(i).padStart(2, "0")}`,
      modelId: i < 6 ? "model-b" : "model-a",
      genMs: 1000, ttftMs: 100 + i,
      outputTokens: 500, reasoningTokens: 0, inputTokens: 1000, cacheRead: 0,
      startedAt: 2_000_000 + i * 10_000,
      completedAt: 2_000_000 + i * 10_000 + 100 + i + 1000,
    });
  }
  addRequest(db, {
    sessionId: SID, id: "d_req_cxl", modelId: "model-a", status: "cancelled",
    genMs: 1000, outputTokens: 500, inputTokens: 1000, cacheRead: 0,
    startedAt: 2_000_000 + 900_000, completedAt: 2_000_000 + 900_000 + 1100,
  });
  db.close();
  writeSessionState(machine, SID);
  sidecar = await startSidecar(machine, { config: { mode: "skill", window: 10 } });
  await waitFor(sidecar, (j) => j && j.sessionId === SID && j.session && j.session.samples === 24, { label: "populated snapshot" });

  // A second machine whose session has no completed requests, for the empty
  // state (a fresh install, before the first reply lands).
  emptyMachine = makeMachine("dash-empty");
  const edb = createDb(emptyMachine);
  addSession(edb, ESID, "Empty dashboard");
  edb.close();
  writeSessionState(emptyMachine, ESID);
  emptySidecar = await startSidecar(emptyMachine, { config: { mode: "skill", window: 10 } });
  await waitFor(emptySidecar, (j) => j && j.sessionId === ESID && j.session, { label: "empty snapshot" });
});

after(async () => {
  await sidecar?.stop();
  await emptySidecar?.stop();
  killAllSidecars();
  cleanup({ ...machine, db: null });
  cleanup({ ...emptyMachine, db: null });
  await closeBrowser();
});

// The dashboard settles when its table has rows (the first tick has completed).
async function dashboard(port, { viewport } = {}) {
  const page = await newPageAt(`http://127.0.0.1:${port}/dashboard`, { viewport });
  return page;
}
const rowsSettled = (page) =>
  until(page, () => document.querySelectorAll("#tbl tbody tr").length > 0, { label: "table rows" });

// ---------------------------------------------------------------------------
// Headline figures
// ---------------------------------------------------------------------------

test("the dashboard renders the session's headline cards from the live snapshot", async () => {
  const page = await dashboard(sidecar.port);
  await rowsSettled(page);
  const cards = await page.evaluate(() =>
    Array.from(document.querySelectorAll("#cards .card")).map((c) => ({
      k: c.querySelector(".k").textContent, v: c.querySelector(".v").textContent, n: c.querySelector(".n").textContent,
    }))
  );
  assert.equal(cards.length, 4);
  assert.equal(cards[0].k, "Latest request tok/s");
  assert.equal(cards[0].v, "500", "500 generated tokens over 1000 ms of generation");
  assert.equal(cards[0].n, "model-a", "the newest completed row is model-a");
  assert.equal(cards[1].k, "Latest request TTFT");
  assert.equal(cards[1].v, "123ms", "the newest row's TTFT (100 + i for i = 23)");
  assert.equal(cards[3].k, "Session output tok");
  assert.equal(cards[3].v, String(24 * 500), "session output is the sum of the completed rows");
  assert.deepEqual(page.__errors, []);
});

test("the table lists the newest request first and the pager counts the whole session", async () => {
  const page = await dashboard(sidecar.port);
  await rowsSettled(page);
  const state = await page.evaluate(() => ({
    rows: document.querySelectorAll("#tbl tbody tr").length,
    info: document.getElementById("pageInfo").textContent,
    prev: document.getElementById("prev").disabled,
    next: document.getElementById("next").disabled,
    arrowCol: (() => { const th = [...document.querySelectorAll("#tbl th")].find((t) => t.querySelector(".arrow")); return th && th.dataset.k; })(),
    firstRow: document.querySelector("#tbl tbody tr").textContent,
  }));
  assert.equal(state.rows, 10, "a page is ten rows");
  assert.equal(state.info, "page 1 of 3 · 24 requests");
  assert.equal(state.prev, true, "prev is disabled on the first page");
  assert.equal(state.next, false);
  assert.equal(state.arrowCol, "completedAt", "the default sort is by time, descending");
  assert.match(state.firstRow, /model-a/, "newest first means the highest index, which is model-a");
});

// ---------------------------------------------------------------------------
// The donut (the geometry fix)
// ---------------------------------------------------------------------------

test("the donut's slices encode the model split, and the legend is their key", async () => {
  const page = await dashboard(sidecar.port);
  await rowsSettled(page);
  const mix = await page.evaluate(() => {
    const svg = document.getElementById("donut");
    const circles = Array.from(svg.querySelectorAll("circle"));
    const slices = circles.filter((c) => c.getAttribute("stroke") !== "var(--track)");
    const legend = Array.from(document.querySelectorAll(".legend .lrow")).map((r) => ({
      name: r.querySelector(".nm").textContent,
      pct: r.querySelector(".pc").textContent,
      // The inline style carries the hex the script wrote; reading .background
      // would give the browser's normalised rgb() and lose the identity.
      hex: (r.querySelector(".sw").getAttribute("style").match(/#[0-9a-f]{6}/i) || [])[0],
    }));
    return {
      sliceDashes: slices.map((c) => parseFloat(c.getAttribute("stroke-dasharray").split(" ")[0])),
      sliceStrokes: slices.map((c) => c.getAttribute("stroke")),
      legend,
      center: { big: document.getElementById("donutPct").textContent, cap: document.getElementById("donutCap").textContent },
      aria: svg.getAttribute("aria-label"),
    };
  });
  // The radius is chosen so the circumference IS 100: a share is a dash length.
  assert.equal(mix.sliceDashes.length, 2, "one arc per model");
  const sum = mix.sliceDashes.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 100) < 0.01, "the arcs must fill the ring exactly once: " + sum);
  assert.ok(Math.abs(mix.sliceDashes[0] - 75) < 0.01, "the dominant model is 75% of generated tokens");
  assert.ok(Math.abs(mix.sliceDashes[1] - 25) < 0.01);
  // The legend swatch colours ARE the arc colours — the list is the ring's key.
  assert.deepEqual(mix.legend.map((l) => l.hex), mix.sliceStrokes);
  assert.equal(mix.legend[0].pct, "75.0%");
  assert.equal(mix.legend[1].pct, "25.0%");
  assert.match(mix.legend[0].name, /model-a/);
  assert.match(mix.legend[0].name, /tok · .* req/);
  // With more than one model the centre answers "which one dominates?".
  assert.equal(mix.center.big, "75%");
  assert.equal(mix.center.cap, "model-a");
  assert.match(mix.aria, /Share of generated tokens/);
});

test("the caption sits BELOW the ring, never overlapping the stroke", async () => {
  // This is the geometry fix: at any usable ring size a centred overlay crowds
  // the stroke, so the figures live under the ring with clear space between.
  const page = await dashboard(sidecar.port);
  await rowsSettled(page);
  const geom = await page.evaluate(() => {
    const wrap = document.getElementById("donutwrap").getBoundingClientRect();
    const center = document.querySelector(".dcenter").getBoundingClientRect();
    return { wrapBottom: wrap.bottom, wrapTop: wrap.top, centerTop: center.top, centerBottom: center.bottom };
  });
  assert.ok(geom.centerTop >= geom.wrapBottom - 0.5,
    `the caption must sit below the ring: ringBottom=${geom.wrapBottom} captionTop=${geom.centerTop}`);
  assert.ok(geom.centerBottom > geom.centerTop, "the caption must have real height");
});

test("the centre names the model that dominates when more than one did the work", async () => {
  // A lone "100%" says nothing, so a single-model session shows the total
  // instead. Here two models did the work, so the centre answers "which one
  // dominates?" — asserted so a change to that rule is caught.
  const page = await dashboard(sidecar.port);
  await rowsSettled(page);
  const n = await page.evaluate(() => document.querySelectorAll(".legend .lrow").length);
  assert.equal(n, 2, "the fixture has two models");
  assert.equal(await page.evaluate(() => document.getElementById("donutPct").textContent), "75%");
  assert.equal(await page.evaluate(() => document.getElementById("donutCap").textContent), "model-a",
    "the caption names the leading model, not a second percentage");
});

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

test("the theme toggle flips the one attribute, relabels itself and persists the choice", async () => {
  const page = await dashboard(sidecar.port);
  await rowsSettled(page);
  const initial = await page.evaluate(() => ({
    theme: document.documentElement.getAttribute("data-theme"),
    label: document.getElementById("themeLabel").textContent,
    stored: localStorage.getItem("sc-theme"),
  }));
  assert.equal(initial.theme, "dark", "dark is the default, matching the app it sits beside");
  assert.equal(initial.label, "Dark");
  assert.equal(initial.stored, "dark");

  await page.click("#themeToggle");
  await page.waitForTimeout(60);
  const light = await page.evaluate(() => ({
    theme: document.documentElement.getAttribute("data-theme"),
    label: document.getElementById("themeLabel").textContent,
    icon: document.getElementById("themeIcon").textContent,
    stored: localStorage.getItem("sc-theme"),
    bg: getComputedStyle(document.body).backgroundColor,
  }));
  assert.equal(light.theme, "light");
  assert.equal(light.label, "Light");
  assert.equal(light.stored, "light", "the choice must persist across a reload");
  assert.notEqual(light.bg, "rgb(14, 17, 22)", "the background must actually change colour");

  // Reload: the inline head script must restore light BEFORE first paint, so
  // setTheme never flips it back to dark.
  await page.reload({ waitUntil: "load" });
  await rowsSettled(page);
  assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-theme")), "light",
    "the remembered theme must survive a reload");
  assert.equal(await page.evaluate(() => document.getElementById("themeLabel").textContent), "Light");
  assert.deepEqual(page.__errors, []);
});

// ---------------------------------------------------------------------------
// Paging, sorting, auto-refresh
// ---------------------------------------------------------------------------

test("the pager walks the whole session and disables at the ends", async () => {
  const page = await dashboard(sidecar.port);
  await rowsSettled(page);
  await page.click("#next");
  await until(page, () => document.getElementById("pageInfo").textContent.includes("page 2"), { label: "page 2" });
  assert.equal(await page.evaluate(() => document.getElementById("prev").disabled), false);
  await page.click("#next");
  await until(page, () => document.getElementById("pageInfo").textContent.includes("page 3"), { label: "page 3" });
  assert.equal(await page.evaluate(() => document.getElementById("next").disabled), true, "next is disabled on the last page");
  // Page three holds the remaining four rows (24 = 10 + 10 + 4).
  assert.equal(await page.evaluate(() => document.querySelectorAll("#tbl tbody tr").length), 4);
});

test("clicking a column header sorts on that column and pauses auto-refresh", async () => {
  const page = await dashboard(sidecar.port);
  await rowsSettled(page);
  assert.equal(await page.evaluate(() => document.getElementById("refreshBadge").classList.contains("off")), false);
  // Every fixture row has the same tok/s, so sort on TTFT — which the fixture
  // varies (100 + i) — to make the reorder observable.
  await page.click('#tbl th[data-k="ttftMs"]');
  await until(page, () => !!document.querySelector('#tbl th[data-k="ttftMs"] .arrow'), { label: "sort arrow on TTFT" });
  const state = await page.evaluate(() => ({
    arrow: document.querySelector('#tbl th[data-k="ttftMs"] .arrow').textContent,
    badgeOff: document.getElementById("refreshBadge").classList.contains("off"),
    label: document.getElementById("autoLabel").textContent,
    // Descending by TTFT: the highest TTFT (123ms, from i = 23) leads.
    firstTtft: document.querySelector("#tbl tbody tr").children[3].textContent,
  }));
  assert.equal(state.arrow, "▼", "a new column starts descending");
  assert.equal(state.badgeOff, true, "sorting is an inspection action and must pause auto-refresh");
  assert.equal(state.label, "Auto-refresh: off");
  assert.equal(state.firstTtft, "123ms", "the descending sort must lead with the largest TTFT");
});

test("the auto-refresh toggle flips the badge and the label", async () => {
  const page = await dashboard(sidecar.port);
  await rowsSettled(page);
  await page.click("#toggleAuto");
  assert.equal(await page.evaluate(() => document.getElementById("autoLabel").textContent), "Auto-refresh: off");
  assert.equal(await page.evaluate(() => document.getElementById("refreshBadge").classList.contains("off")), true);
  await page.click("#toggleAuto");
  assert.equal(await page.evaluate(() => document.getElementById("autoLabel").textContent), "Auto-refresh: on");
});

test("the table holds only completed main requests, coloured as such", async () => {
  // The table's backing query is scoped to status='completed' AND
  // query_source='main_turn', so a cancelled row (which the fixture has) must
  // NOT appear, and every row that does is "completed" → the .ok colour.
  const page = await dashboard(sidecar.port);
  await rowsSettled(page);
  const statuses = await page.evaluate(() =>
    Array.from(document.querySelectorAll("#tbl tbody tr")).map((tr) => ({
      text: tr.children[6].textContent, cls: tr.children[6].className,
    }))
  );
  assert.ok(statuses.length > 0);
  for (const s of statuses) {
    assert.equal(s.text, "completed", "a non-completed row must not reach the table");
    assert.equal(s.cls, "ok");
  }
  // The cancelled request is still counted nowhere as a completed page row.
  assert.equal(await page.evaluate(() => document.getElementById("pageInfo").textContent), "page 1 of 3 · 24 requests",
    "24 completed rows, 3 pages — the cancelled row is excluded");
});

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

test("a session with no completed requests shows an honest empty state, not zeros", async () => {
  const page = await dashboard(emptySidecar.port);
  await until(page, () => document.querySelector("#cards .card"), { label: "cards" });
  const state = await page.evaluate(() => ({
    cards: Array.from(document.querySelectorAll("#cards .card")).map((c) => c.querySelector(".v").textContent),
    center: document.getElementById("donutPct").textContent,
    cap: document.getElementById("donutCap").textContent,
    legend: document.querySelector(".legend").textContent,
    info: document.getElementById("pageInfo").textContent,
    ringStroke: document.querySelector("#donut circle").getAttribute("stroke"),
  }));
  assert.equal(state.cards[0], "—", "an empty session reads as a dash, not a zero");
  assert.equal(state.center, "—");
  assert.equal(state.cap, "", "the caption is cleared rather than repeating the legend");
  assert.match(state.legend, /No completed requests yet/);
  assert.equal(state.info, "no requests");
  assert.equal(state.ringStroke, "var(--track)", "the placeholder ring is the neutral track");
  assert.deepEqual(page.__errors, []);
});

test("no page errors on the populated dashboard across a sort and a page change", async () => {
  const page = await dashboard(sidecar.port);
  await rowsSettled(page);
  await page.click('#tbl th[data-k="model"]');
  await page.waitForTimeout(120);
  await page.click("#next");
  await page.waitForTimeout(120);
  assert.deepEqual(page.__errors, []);
});
