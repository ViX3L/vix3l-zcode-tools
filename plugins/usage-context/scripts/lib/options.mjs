// usage-context settings, resolved by the shared plugin-options resolver.
//
// Every key declared in .zcode-plugin/plugin.json has a reader here:
//   showChips   → whether the injected page renders chips at all
//   showRanFor  → whether the elapsed-time chip (and its panel) is rendered
//   sidecarPort → the stats-composer sidecar this plugin reads /turn from
import { readPluginOptions } from "./plugin-options.mjs";
import { DEFAULT_SIDECAR_PORT } from "./constants.mjs";

export const DEFAULTS = Object.freeze({
  showChips: true,
  showRanFor: true,
  sidecarPort: DEFAULT_SIDECAR_PORT,
});

const SCHEMA = {
  showChips: { default: DEFAULTS.showChips, boolean: true },
  showRanFor: { default: DEFAULTS.showRanFor, boolean: true },
  sidecarPort: { default: DEFAULTS.sidecarPort, integer: true, max: 65_535 },
};

export function readOptions() {
  return readPluginOptions("usage-context", SCHEMA);
}
