// End to end: the REAL injector processes, pointed at a REAL CDP endpoint.
//
// Everything above this tier tests a layer. This one tests the seam between
// them — the part that a unit test cannot reach and a UI test has to fake: the
// injector's HTTP+WebSocket CDP client, its app-target filter, its attach
// state, and (for both plugins) the fact that two injectors can attach to the
// same page over the browser endpoint without blocking each other.
//
// The page is a real Chromium page loaded from a file:// URL deliberately laid
// out as <dir>/out/renderer/index.html — the exact shape both injectors'
// target filters require — and it carries a `window.zcode` bridge, which is the
// runtime proof the injectors demand before injecting. So the injector is not
// being told "this is the app"; it is reaching that conclusion itself, the same
// way it does against the shipping client.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { REPO_ROOT, STATS_INJECTOR, USAGE_INJECTOR } from "../lib/paths.mjs";
import { writeAppPage, launchCdpBrowser, evaluateInPage } from "../lib/cdp.mjs";
import { startMockSidecar } from "../lib/mock-sidecar.mjs";

// The page the injectors will find: the composer DOM the pill needs AND the
// assistant-turn DOM the chips need, plus the app-shell markers. The zcode
// bridge is re-added after load because the real app's preload defines it; a
// file:// page cannot, so it is installed by the CDP client before the injector
// runs (see bootstrap below) — which is also what the injector's own probe
// reads.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>app</title><style>
  body { margin: 0; font-family: system-ui, sans-serif; background: #1e1e1e; color: #eee; --ui-font-size: 14px; }
  .composer { display: flex; align-items: center; gap: 8px; padding: 10px; position: relative; }
  .row { display: flex; align-items: center; gap: 8px; flex: 1 1 auto; border: 1px dashed #333; }
  .footer { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #8b949e; }
  .fsp { flex: 1; }
</style></head><body>
  <div id="root">
    <div class="chat" data-session-id="sess_e2e_1">
      <div class="turn" data-turn-id="msg_1">
        <div class="body">reply</div>
        <div class="footer"><span class="fsp"></span><span class="ts">04:46 AM</span></div>
      </div>
    </div>
    <div class="composer-region">
      <div class="composer" data-session-id="sess_e2e_1">
        <div class="row" data-composer-leading-content><span class="lead">access</span></div>
      </div>
    </div>
  </div>
  <script>window.__injected = { stats: false };</script>
</body></html>`;

let mock, browser, machine, fileUrl;

// Install the app bridge via CDP, the way a preload would, then confirm it.
async function installBridge() {
  await evaluateInPage(browser.port, "window.zcode = { v: 1 }; 'ok'");
}

before(async () => {
  machine = fs.mkdtempSync(path.join(os.tmpdir(), "zstats-e2e-"));
  fileUrl = writeAppPage(machine, "index.html", PAGE);
  browser = await launchCdpBrowser({ url: fileUrl });
  mock = await startMockSidecar();
  // Install the bridge on every target the injector will see.
  let tries = 0;
  while (tries++ < 40) {
    try { await installBridge(); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
});

after(async () => {
  await mock?.close();
  await browser?.close();
  try { fs.rmSync(machine, { recursive: true, force: true }); } catch {}
});

// Run an injector to completion (--once) with its own sandboxed HOME, and
// return { code, out, home }. A FRESH home per run matters: the injector's
// singleflight lock lives under HOME, and two runs sharing one HOME would have
// the second stand down as superseded even though the first has exited — a
// collision of the test's making, not the product's. The home is returned so a
// test can read the attach state the run wrote.
let runSeq = 0;
function runInjector(script, extraArgs = [], env = {}) {
  const home = path.join(machine, `home-${++runSeq}`);
  fs.mkdirSync(home, { recursive: true });
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, "--once", ...extraArgs], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        ZCODE_PLUGIN_ROOT: REPO_ROOT,
        STATS_SIDECAR_PLUGIN_ROOT: path.join(REPO_ROOT, "plugins", "stats-composer"),
        NODE_NO_WARNINGS: "1",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c.toString()));
    child.stderr.on("data", (c) => (out += c.toString()));
    child.on("close", (code) => resolve({ code, out, home }));
  });
}

// The attach-state file the stats injector writes, under a run's own HOME.
const pillState = (home) => {
  try { return JSON.parse(fs.readFileSync(path.join(home, ".zcode", "stats-composer", "pill.json"), "utf8")); }
  catch { return null; }
};

// The page scripts mount on their own first scheduled tick (setTimeout(0)),
// which runs AFTER the injector's Runtime.evaluate has returned. So a read
// immediately after the injector exits can precede the mount by a few ms — poll
// instead of assuming. `expr` must evaluate to a boolean in the page.
async function untilInPage(expr, { timeout = 5000, label = "page condition" } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await evaluateInPage(browser.port, `JSON.stringify(${expr})`);
    if (JSON.parse(last)) return;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error(`timed out waiting for ${label} (last: ${last})`);
}

test("the stats injector attaches to the app page over CDP and mounts the pill", async () => {
  const { out, home } = await runInjector(STATS_INJECTOR, ["--port", String(browser.port), "--sidecar-port", String(mock.port)]);
  assert.match(out, /injected into 1\/1 target/, "the injector must find and inject the app page: " + out);
  // The attach state is what the hook ladder reads to know the pill channel is up.
  const st = pillState(home);
  assert.ok(st, "the injector must write its attach state");
  assert.equal(st.attached, true);
  assert.equal(st.reason, "attached");
  assert.equal(st.port, browser.port);
  assert.equal(st.sidecar, mock.port);
  // And the pill is really in the page: the host node exists and the script ran.
  await untilInPage("!!document.querySelector('.zcode-stats-pill-host')", { label: "pill host" });
  const probe = await evaluateInPage(browser.port, "JSON.stringify({host: !!document.querySelector('.zcode-stats-pill-host'), bridge: typeof window.zcode})");
  const p = JSON.parse(probe);
  assert.equal(p.host, true, "the pill host must be in the live page");
  assert.equal(p.bridge, "object");
});

test("the usage-context injector attaches to the same page and mounts the chips", async () => {
  // Point it at the sidecar so the chips have data to read.
  const { out } = await runInjector(USAGE_INJECTOR, ["--port", String(browser.port), "--sidecar-port", String(mock.port)]);
  assert.match(out, /mounted on 1 target/, "the chips injector must mount on the app page: " + out);
  await untilInPage("!!document.querySelector('.uc-wrap')", { label: "chip wrap" });
  const probe = await evaluateInPage(browser.port, "JSON.stringify({wrap: !!document.querySelector('.uc-wrap'), epoch: (window.__usageContext||{}).epoch||null})");
  const p = JSON.parse(probe);
  assert.equal(p.wrap, true, "the chip wrap must be in the live page");
  assert.ok(p.epoch, "the page script must have claimed the document singleton");
});

test("both plugins coexist: the chips injector mounts while the pill is already there", async () => {
  // The whole reason both use the BROWSER endpoint (one flat session each) is
  // that a page socket admits a single debugger client. Two separate injector
  // processes attaching to the same page, with both results present, is the
  // proof of that claim.
  await untilInPage("!!document.querySelector('.zcode-stats-pill-host') && !!document.querySelector('.uc-wrap')", { label: "both surfaces" });
  const p = JSON.parse(await evaluateInPage(
    browser.port,
    "JSON.stringify({pill: !!document.querySelector('.zcode-stats-pill-host'), chips: !!document.querySelector('.uc-wrap')})"
  ));
  assert.equal(p.pill, true);
  assert.equal(p.chips, true);
});

test("a re-run of the injector is idempotent (no second pill host)", async () => {
  await runInjector(STATS_INJECTOR, ["--port", String(browser.port), "--sidecar-port", String(mock.port)]);
  await runInjector(STATS_INJECTOR, ["--port", String(browser.port), "--sidecar-port", String(mock.port)]);
  const n = await evaluateInPage(browser.port, "document.querySelectorAll('.zcode-stats-pill-host').length");
  assert.equal(n, 1, "a re-injection must not stack a second pill host");
});

test("the chips render the mocked turn's figures in the live page", async () => {
  // The mock's default turn set gives msg_1 729,123 tokens over 43s. The chips
  // poll on a 2 s cadence, so the figure lands a beat after the injector mounts.
  await untilInPage("document.querySelector('.uc-usage-val') && document.querySelector('.uc-usage-val').textContent === '729K tok'",
    { label: "chip figure", timeout: 8000 });
  assert.equal(
    await evaluateInPage(browser.port, "document.querySelector('.uc-usage-val').textContent"),
    "729K tok",
    "the chip must show the sidecar's figure for that turn"
  );
});

test("a foreign Chromium with no app renderer is refused (no pill, attach state says so)", async () => {
  // A page that is NOT under out/renderer and has no bridge: the injector must
  // decline to inject, because a pill rendered into an arbitrary browser is a
  // pill rendered nowhere useful. This is the guard the target filter exists for.
  const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), "zstats-foreign-"));
  const plainPage = path.join(plainDir, "plain.html");
  fs.writeFileSync(plainPage, "<!doctype html><html><body><div id='root'></div></body></html>");
  const foreign = await launchCdpBrowser({ url: "file://" + plainPage });
  try {
    const { code, out, home } = await runInjector(STATS_INJECTOR, ["--port", String(foreign.port), "--sidecar-port", String(mock.port)]);
    assert.match(out, /no ZCode app renderer/, "a foreign browser must be declined: " + out);
    // exitCode 2 is the injector's "no app CDP" signal to the hook ladder.
    assert.equal(code, 2, "declining must exit 2 so the fallback channels stay active");
    const st = pillState(home);
    assert.equal(st.attached, false);
    assert.equal(st.reason, "no-app-cdp");
    const host = await evaluateInPage(foreign.port, "!!document.querySelector('.zcode-stats-pill-host')");
    assert.equal(host, false, "nothing may be injected into a foreign page");
  } finally {
    await foreign.close();
    try { fs.rmSync(plainDir, { recursive: true, force: true }); } catch {}
  }
});
