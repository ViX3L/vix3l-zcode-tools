// The page scripts and the injected CSS, obtained from the injectors' own
// SOURCE — never retyped.
//
// Why this matters more than it looks: these two scripts are the entire UI. If
// the harness carried a hand-written copy, the tests would keep passing after
// someone edited the real script, which is the worst possible outcome for a
// suite whose subject is exactly this rendering. So the harness extracts the
// real template-literal bodies and stylesheet array from inject.mjs, performs
// the same substitutions the injector's own launch path performs
// (__SIDECAR_PORT__ -> a test port, and for stats __CARD_LAYOUT__ -> wide or
// compact), and hands the result to a real Chromium. What the browser runs is
// therefore what the plugin would inject, differing only in those placeholders.
//
// The extraction is done with a small JS-aware scanner rather than a regex,
// because the first attempt with a regex silently swallowed comment text (the
// CSS comments contain apostrophes) and over-ran the closing delimiter. The
// scanner understands single/double-quoted strings, template literals, line and
// block comments, and bracket depth — enough to cut these exact literals
// correctly, and it fails loudly instead of returning something plausible.
import fs from "node:fs";
import { STATS_INJECTOR, USAGE_INJECTOR } from "./paths.mjs";

// --- scanner primitives ---------------------------------------------------

function skipQuoted(src, i) {
  const quote = src[i];
  i++;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") { i += 2; continue; }
    if (c === quote) return i + 1;
    i++;
  }
  throw new Error("unterminated string literal");
}
function skipLineComment(src, i) {
  while (i < src.length && src[i] !== "\n") i++;
  return i;
}
function skipBlockComment(src, i) {
  const e = src.indexOf("*/", i + 2);
  if (e < 0) throw new Error("unterminated block comment");
  return e + 2;
}
// A token is a string, template literal or comment; return the index after it,
// or -1 when src[i] starts none of those.
function skipToken(src, i) {
  const c = src[i];
  if (c === "'" || c === '"') return skipQuoted(src, i);
  if (c === "/" && src[i + 1] === "/") return skipLineComment(src, i);
  if (c === "/" && src[i + 1] === "*") return skipBlockComment(src, i);
  return -1;
}

// The text of `const NAME = \`...\`` — with escapes RESOLVED, exactly as the
// injector's own module evaluation resolves them.
//
// This matters: the page scripts contain escaped code sequences (the chip icons
// are written `\\u{1F5C4}` in the source). The injector evaluates the template
// literal in Node, so by the time the string reaches Runtime.evaluate it holds
// a real escape for the page's parser to turn into the glyph. Returning the RAW
// slice instead would ship the two characters "\" and "u" to the browser, which
// renders a literal "\u{1F5C4}" — a harness that is not running the plugin. So
// the literal is re-evaluated here (a template literal with no interpolation is
// pure data, and re-parsing the exact source text of a valid literal cannot
// fail). A `${...}` would make Node evaluate an expression whose bindings we do
// not have, so its presence is refused rather than silently mis-evaluated.
function templateLiteralBody(src, varName, file) {
  const opener = `const ${varName} = \``;
  const anchor = src.indexOf(opener);
  if (anchor < 0) throw new Error(`${varName}: template literal not found in ${file}`);
  const start = anchor + opener.length - 1; // index of the opening backtick
  let i = start + 1;
  while (i < src.length) {
    if (src[i] === "\\") { i += 2; continue; }
    if (src[i] === "`") {
      const text = src.slice(start, i + 1); // includes both backticks
      const body = text.slice(1, -1);
      if (body.includes("${")) {
        throw new Error(`${varName}: contains \${...} interpolation; this extractor cannot evaluate it safely`);
      }
      return evalData(text);
    }
    i++;
  }
  throw new Error(`${varName}: unterminated template literal in ${file}`);
}

// The whole `[ ... ]` array literal starting at the first `[` after `anchor`.
function arrayLiteralAfter(src, anchor, file) {
  const at = src.indexOf(anchor);
  if (at < 0) throw new Error(`anchor not found in ${file}: ${anchor}`);
  const open = src.indexOf("[", at);
  if (open < 0) throw new Error("array literal not found");
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const s = skipToken(src, i);
    if (s >= 0) { i = s; continue; }
    const c = src[i];
    if (c === "[") depth++;
    else if (c === "]") { depth--; if (depth === 0) return src.slice(open, i + 1); }
    i++;
  }
  throw new Error("unbalanced array literal");
}

// The expression assigned to `const NAME =` up to the top-level `;`.
function expressionOf(src, varName, file) {
  const marker = `const ${varName} =`;
  const at = src.indexOf(marker);
  if (at < 0) throw new Error(`${varName}: declaration not found in ${file}`);
  let i = at + marker.length;
  const start = i;
  let depth = 0;
  while (i < src.length) {
    const s = skipToken(src, i);
    if (s >= 0) { i = s; continue; }
    const c = src[i];
    if (c === "[" || c === "(" || c === "{") depth++;
    else if (c === "]" || c === ")" || c === "}") depth--;
    else if (c === ";" && depth === 0) return src.slice(start, i);
    i++;
  }
  throw new Error(`${varName}: no terminating semicolon`);
}

// Evaluate a pure-data expression (string concat, array of strings) taken from
// the plugin source. This is exactly what the plugin's own runtime does with
// these values, so it is the faithful reading — not a reimplementation.
function evalData(expr) {
  return new Function(`return (${expr});`)();
}

// --- sources --------------------------------------------------------------

let _stats, _usage;
const statsSource = () => (_stats ??= fs.readFileSync(STATS_INJECTOR, "utf8"));
const usageSource = () => (_usage ??= fs.readFileSync(USAGE_INJECTOR, "utf8"));

// { script, css } for the composer pill, at one density and sidecar port.
export function statsPill(layout = "wide", sidecarPort = 7427) {
  const src = statsSource();
  const script = templateLiteralBody(src, "PILL_JS_TEMPLATE", STATS_INJECTOR)
    .replace(/__CARD_LAYOUT__/g, layout)
    .replace(/__SIDECAR_PORT__/g, String(sidecarPort));
  const css = evalData(arrayLiteralAfter(src, "style.textContent =", STATS_INJECTOR)).join("");
  return { script, css };
}

// { script, css } for the usage-context chips.
export function usageChips(sidecarPort = 7427) {
  const src = usageSource();
  const script = templateLiteralBody(src, "PAGE_JS", USAGE_INJECTOR)
    .replace(/__SIDECAR_PORT__/g, String(sidecarPort));
  const css = templateLiteralBody(src, "CSS", USAGE_INJECTOR);
  return { script, css };
}

// The page script's VERSION, read from source, so a test asserts re-injection
// behaviour without hardcoding a number the plugin is expected to bump.
export function statsPillVersion(layout = "wide") {
  const src = statsSource();
  const m = /var VERSION = '([^']*)'\s*\+\s*LAYOUT/.exec(src);
  if (!m) throw new Error("stats VERSION not found");
  return `${m[1]}${layout}`;
}
export function usageChipsVersion() {
  const m = /var VERSION = '([^']+)'/.exec(usageSource());
  if (!m) throw new Error("usage VERSION not found");
  return m[1];
}

// The pill/card skeletons, as the script builds them.
export function statsPillSkeleton() {
  return evalData(expressionOf(statsSource(), "PILL_SKELETON", STATS_INJECTOR));
}
export function statsCardSkeleton() {
  return evalData(expressionOf(statsSource(), "CARD_SKELETON", STATS_INJECTOR));
}
