// One resolver for plugin settings.
//
// ZCode's Marketplace settings page writes userConfig values into
// ~/.zcode/cli/config.json under plugins.options["<plugin>@<marketplace>"].
// The plugin's own ~/.zcode/<plugin>/config.json remains the documented
// hand-edit route. Both must mean the same thing to the pill, the sidecar and
// the hooks, so precedence and validation live here once:
//
//   app option  →  plugin config  →  schema default
//
// A malformed hand edit degrades to the default instead of becoming a NaN port
// or an unknown mode.
import fs from "node:fs";
import { appConfigFile, pluginConfigFile } from "./paths.mjs";

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function appOptionsFor(plugin) {
  const options = readJson(appConfigFile())?.plugins?.options;
  if (!options || typeof options !== "object") return {};
  for (const id of Object.keys(options)) {
    if (id === plugin || id.startsWith(`${plugin}@`)) {
      const value = options[id];
      return value && typeof value === "object" ? value : {};
    }
  }
  return {};
}

function normalize(value, rule) {
  if (value === undefined || value === null) return rule.default;
  if (rule.oneOf) return rule.oneOf.includes(value) ? value : rule.default;
  if (rule.boolean) return typeof value === "boolean" ? value : rule.default;
  if (rule.integer) {
    const n = Number(value);
    const min = rule.min ?? 1;
    const max = rule.max ?? Number.MAX_SAFE_INTEGER;
    return Number.isInteger(n) && n >= min && n <= max ? n : rule.default;
  }
  return value;
}

// schema: { key: { default, oneOf?, boolean?, integer?, min?, max?, pluginOnly? } }
export function readPluginOptions(plugin, schema) {
  const app = appOptionsFor(plugin);
  const local = readJson(pluginConfigFile(plugin));
  const out = {};
  for (const [key, rule] of Object.entries(schema)) {
    const raw = !rule.pluginOnly && app[key] !== undefined ? app[key] : local[key];
    out[key] = normalize(raw, rule);
  }
  return out;
}
