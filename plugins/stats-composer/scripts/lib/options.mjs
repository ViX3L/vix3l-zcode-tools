// stats-composer settings, resolved by the shared plugin-options resolver.
//
// The schema is the single declaration of what this plugin reads. Every key
// here is read by code (the injector, the sidecar or a hook) and is covered by
// tests/unit/options.test.mjs, so a manifest key cannot silently become inert.
import { readPluginOptions } from "./plugin-options.mjs";
import { DEFAULT_REFRESH_MS, DEFAULT_SIDECAR_PORT, DEFAULT_WINDOW, MAX_REFRESH_MS, MIN_REFRESH_MS } from "./constants.mjs";

export const DEFAULTS = Object.freeze({
  mode: "auto",
  position: "left",
  wideCard: true,
  live: true,
  window: DEFAULT_WINDOW,
  port: DEFAULT_SIDECAR_PORT,
  attachStatsLine: true,
  refreshMs: DEFAULT_REFRESH_MS,
});

const SCHEMA = {
  mode: { default: DEFAULTS.mode, oneOf: ["auto", "skill", "sidecar"] },
  position: { default: DEFAULTS.position, oneOf: ["left", "right"] },
  wideCard: { default: DEFAULTS.wideCard, boolean: true },
  live: { default: DEFAULTS.live, boolean: true },
  window: { default: DEFAULTS.window, integer: true, max: 10_000 },
  port: { default: DEFAULTS.port, integer: true, max: 65_535 },
  // Plugin-config-only escape hatches: not part of userConfig, so they must not
  // be picked up from the app's options object.
  attachStatsLine: { default: DEFAULTS.attachStatsLine, boolean: true, pluginOnly: true },
  refreshMs: { default: DEFAULTS.refreshMs, integer: true, min: MIN_REFRESH_MS, max: MAX_REFRESH_MS, pluginOnly: true },
};

export function readOptions() {
  return readPluginOptions("stats-composer", SCHEMA);
}
