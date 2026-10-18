// The page scripts and stylesheets, obtained from the assets that ship.
//
// The injectors read injector/page/*.js and *.css at launch. The harness reads
// the same files and performs the same substitutions, so what Chromium runs is
// what the plugin would inject, differing only in the placeholder values.
import fs from "node:fs";
import path from "node:path";
import { STATS, USAGE } from "./paths.mjs";

const STATS_CORE = path.join(STATS, "injector", "page", "pill-core.js");
const STATS_SCRIPT = path.join(STATS, "injector", "page", "pill.js");
const STATS_STYLE = path.join(STATS, "injector", "page", "pill.css");
const USAGE_SCRIPT = path.join(USAGE, "injector", "page", "chips.js");
const USAGE_STYLE = path.join(USAGE, "injector", "page", "chips.css");

let _skeletonSource;

// A pure-data expression (string concatenation) taken from the page script.
function expressionOfMarker(src, marker, file) {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error(`${marker}: declaration not found in ${file}`);
  let i = at + marker.length;
  const start = i;
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"') {
      const quote = c;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "[" || c === "(" || c === "{") depth++;
    else if (c === "]" || c === ")" || c === "}") depth--;
    else if (c === ";" && depth === 0) return src.slice(start, i);
    i++;
  }
  throw new Error(`${marker}: no terminating semicolon`);
}

function evalData(expr) {
  return new Function(`return (${expr});`)();
}

export function statsPill(layout = "wide", sidecarPort = 7427, position = "left") {
  const css = fs.readFileSync(STATS_STYLE, "utf8");
  const script = fs.readFileSync(STATS_CORE, "utf8") + "\n" +
    fs
    .readFileSync(STATS_SCRIPT, "utf8")
    .replace(/__SC_CSS__/g, JSON.stringify(css))
    .replace(/__CARD_LAYOUT__/g, layout)
    .replace(/__PILL_POSITION__/g, position)
    .replace(/__SIDECAR_PORT__/g, String(sidecarPort));
  return { script, css };
}

export function usageChips(sidecarPort = 7427, { showChips = true, showRanFor = true } = {}) {
  const css = fs.readFileSync(USAGE_STYLE, "utf8");
  const script = fs
    .readFileSync(USAGE_SCRIPT, "utf8")
    .replace(/__SIDECAR_PORT__/g, String(sidecarPort))
    .replace(/__SHOW_CHIPS__/g, String(showChips))
    .replace(/__SHOW_RANFOR__/g, String(showRanFor));
  return { script, css };
}

// The page script's VERSION, read from source, so a test asserts re-injection
// behaviour without hardcoding a number the plugin is expected to bump.
export function statsPillVersion(layout = "wide", position = "left") {
  const src = fs.readFileSync(STATS_SCRIPT, "utf8");
  const match = /var VERSION = '([^']*)'\s*\+\s*LAYOUT\s*\+\s*'-'\s*\+\s*POSITION/.exec(src);
  if (!match) throw new Error("stats VERSION not found");
  return `${match[1]}${layout}-${position}`;
}

export function usageChipsVersion(showChips = true, showRanFor = true) {
  const src = fs.readFileSync(USAGE_SCRIPT, "utf8");
  const match = /var VERSION = '([^']*)-__SHOW_CHIPS__-__SHOW_RANFOR__'/.exec(src);
  if (!match) throw new Error("usage VERSION not found");
  return `${match[1]}-${showChips}-${showRanFor}`;
}

export function statsCardSkeleton() {
  _skeletonSource ??= fs.readFileSync(STATS_CORE, "utf8");
  return evalData(expressionOfMarker(_skeletonSource, "U.CARD_SKELETON =", STATS_CORE));
}
