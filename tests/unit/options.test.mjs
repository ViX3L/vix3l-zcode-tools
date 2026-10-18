// One resolver, one precedence, one set of defaults.
//
// Every plugin component reads settings through these modules, so these tests
// are the contract: app option → plugin config → schema default, with malformed
// values degrading to the default instead of becoming NaN.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { STATS_OPTIONS, USAGE_OPTIONS, STATS_PLUGIN_JSON, USAGE_PLUGIN_JSON } from "../lib/paths.mjs";

const stats = await import(STATS_OPTIONS);
const usage = await import(USAGE_OPTIONS);

function homeWith({ app, stats: statsCfg, usage: usageCfg } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "zstats-options-"));
  if (app) {
    fs.mkdirSync(path.join(home, ".zcode", "cli"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".zcode", "cli", "config.json"),
      JSON.stringify({ plugins: { options: app } })
    );
  }
  if (statsCfg) {
    fs.mkdirSync(path.join(home, ".zcode", "stats-composer"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".zcode", "stats-composer", "config.json"),
      JSON.stringify(statsCfg)
    );
  }
  if (usageCfg) {
    fs.mkdirSync(path.join(home, ".zcode", "usage-context"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".zcode", "usage-context", "config.json"),
      JSON.stringify(usageCfg)
    );
  }
  return home;
}

function withHome(home, fn) {
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn();
  } finally {
    process.env.HOME = previous;
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  }
}

test("defaults apply when neither config file exists", () => {
  const home = homeWith();
  withHome(home, () => {
    assert.deepEqual(stats.readOptions(), stats.DEFAULTS);
    assert.deepEqual(usage.readOptions(), usage.DEFAULTS);
  });
});

test("a Marketplace app option wins over the plugin config", () => {
  const home = homeWith({
    app: { "stats-composer@vix3l-zcode-tools": { mode: "sidecar", wideCard: false, window: 25 } },
    stats: { mode: "skill", wideCard: true, window: 5 },
  });
  withHome(home, () => {
    const opts = stats.readOptions();
    assert.equal(opts.mode, "sidecar");
    assert.equal(opts.wideCard, false);
    assert.equal(opts.window, 25);
  });
});

test("the plugin config is the fallback, and a bare plugin id is accepted", () => {
  const home = homeWith({
    app: { "stats-composer": { position: "right" } },
    stats: { mode: "skill", live: false },
  });
  withHome(home, () => {
    const opts = stats.readOptions();
    assert.equal(opts.position, "right", "the app option wins");
    assert.equal(opts.mode, "skill", "the plugin config fills the rest");
    assert.equal(opts.live, false);
  });
});

test("malformed values degrade to the default instead of becoming NaN", () => {
  const home = homeWith({
    app: { "stats-composer@dev": { mode: "turbo", position: "middle", wideCard: "yes", window: -4, port: "7427" } },
  });
  withHome(home, () => {
    const opts = stats.readOptions();
    assert.equal(opts.mode, "auto");
    assert.equal(opts.position, "left");
    assert.equal(opts.wideCard, true);
    assert.equal(opts.window, 10);
    // A numeric string is a valid integer; a real string is not.
    assert.equal(opts.port, 7427);
  });
});

test("plugin-only escape hatches are never taken from the app options", () => {
  const home = homeWith({
    app: { "stats-composer@dev": { attachStatsLine: false, refreshMs: 5000 } },
    stats: {},
  });
  withHome(home, () => {
    const opts = stats.readOptions();
    assert.equal(opts.attachStatsLine, true, "app options must not disable the stats line");
    assert.equal(opts.refreshMs, 900);
  });
});

test("settings are re-read on every call (a saved change applies live)", () => {
  const home = homeWith({ stats: { mode: "skill" } });
  withHome(home, () => {
    assert.equal(stats.readOptions().mode, "skill");
    fs.writeFileSync(
      path.join(home, ".zcode", "stats-composer", "config.json"),
      JSON.stringify({ mode: "sidecar" })
    );
    assert.equal(stats.readOptions().mode, "sidecar");
  });
});

test("usage-context reads its own options, not stats-composer's", () => {
  const home = homeWith({
    app: {
      "stats-composer@dev": { sidecarPort: 1111, showChips: false },
      "usage-context@dev": { sidecarPort: 2222, showRanFor: false },
    },
  });
  withHome(home, () => {
    const opts = usage.readOptions();
    assert.equal(opts.sidecarPort, 2222);
    assert.equal(opts.showRanFor, false);
    assert.equal(opts.showChips, true, "a key from the other plugin must not leak in");
  });
});

test("every declared userConfig key is read by its plugin's resolver", () => {
  for (const [manifestPath, module] of [
    [STATS_PLUGIN_JSON, stats],
    [USAGE_PLUGIN_JSON, usage],
  ]) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const home = homeWith();
    withHome(home, () => {
      const opts = module.readOptions();
      for (const key of Object.keys(manifest.userConfig || {})) {
        assert.ok(key in opts, `${manifest.name}: userConfig key "${key}" has no reader`);
      }
    });
  }
});
