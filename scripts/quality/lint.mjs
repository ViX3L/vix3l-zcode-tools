#!/usr/bin/env node
// Mechanical clean-code rules that do not need a full parser.
//
// Each check encodes a rule from the clean-code scorecard:
// size limits (C1), deliberate error handling (C4), no dead warning plumbing,
// exact CORS origins (C8).
import fs from "node:fs";
import path from "node:path";
import { ROOT, sourceFiles, ignored, isGenerated, report } from "./lib.mjs";

const MAX_MODULE = 400;
const MAX_ENTRYPOINT = 150;
const MAX_FUNCTION = 60;
const ENTRYPOINT = /^(?:plugins\/[^/]+\/(?:hooks\/[^/]+\.mjs|injector\/inject\.mjs|sidecar\/server\.mjs|scripts\/(?:stats|doctor)\.mjs|mcp\/[^/]+\.mjs|launcher\/[^/]+\.mjs)|\.github\/scripts\/[^/]+\.mjs)$/;

const findings = [];
const production = sourceFiles().filter((rel) =>
  /\.(mjs|js)$/.test(rel) && !rel.startsWith("tests/") && !rel.startsWith("scripts/quality/") && !ignored(rel)
);

function linesOf(text) {
  return text.split("\n").length;
}

// A cheap function-length scan: find a declaration, count braces until they
// close. Strings and line comments are stripped first; template literals with
// braces are rare in this code and are handled by the same counter.
function stripCode(line) {
  return line.replace(/\/\/.*$/, "").replace(/'(?:\\.|[^'])*'/g, "''").replace(/"(?:\\.|[^"])*"/g, '""');
}

function functionLengths(text) {
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const code = stripCode(lines[i]);
    const m = /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(code) ||
      /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/.exec(code) ||
      /^\s*([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?\([^)]*\)\s*=>/.exec(code);
    if (!m) continue;
    // Find the first opening brace at/after this line, then balance.
    let depth = 0;
    let opened = false;
    let end = i;
    for (; end < lines.length; end++) {
      const c = stripCode(lines[end]);
      for (const ch of c) {
        if (ch === "{") { depth++; opened = true; }
        else if (ch === "}") depth--;
      }
      if (opened && depth <= 0) break;
    }
    if (opened) out.push({ name: m[1], line: i + 1, length: end - i + 1 });
  }
  return out;
}

for (const rel of production) {
  const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
  const count = linesOf(text);
  if (count > MAX_MODULE) findings.push(`${rel}: ${count} lines exceeds ${MAX_MODULE}`);
  if (ENTRYPOINT.test(rel) && count > MAX_ENTRYPOINT) {
    findings.push(`${rel}: entrypoint is ${count} lines, limit ${MAX_ENTRYPOINT}`);
  }
  if (isGenerated(text)) continue;
  for (const fn of functionLengths(text)) {
    if (fn.length > MAX_FUNCTION) {
      findings.push(`${rel}:${fn.line} ${fn.name}() is ${fn.length} lines, limit ${MAX_FUNCTION}`);
    }
  }
  // A one-line `try { ... } catch {}` is visibly scoped; a catch block on its
  // own line must say why the failure is safe to ignore.
  text.split("\n").forEach((line, i) => {
    if (/^\s*[})]?\s*catch\s*(?:\([^)]*\))?\s*\{\s*\}\s*$/.test(line) && !line.includes("try")) {
      findings.push(`${rel}:${i + 1} empty catch needs a reason`);
    }
  });
  if (text.includes("process.removeAllListeners(")) findings.push(`${rel}: process.removeAllListeners is not allowed`);
  for (const m of text.matchAll(/startsWith\(\s*["']https?:\/\/(?:localhost|127\.0\.0\.1)/g)) {
    findings.push(`${rel}: origin prefix check at offset ${m.index} accepts lookalike hosts`);
  }
}

report("lint", findings);
