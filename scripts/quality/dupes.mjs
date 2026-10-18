#!/usr/bin/env node
// Clone detection without a dependency.
//
// A clone is 10 consecutive significant code lines that appear verbatim in two
// different places. Blank lines, braces-only lines and comments are ignored so
// formatting cannot hide (or invent) a duplicate; generated copies are ignored
// because their duplication is the packaging model, verified instead by
// `sync-shared.mjs --check`.
import fs from "node:fs";
import path from "node:path";
import { ROOT, sourceFiles, ignored, isGenerated, report } from "./lib.mjs";

const MIN_LINES = 10;
const TRIVIAL = /^(?:[{}()[\];,]+|[{}()[\];,]+\)?;?)$/;

function significant(text) {
  return text.split("\n")
    .map((line, index) => ({ line: index + 1, text: line.trim() }))
    .filter(({ text: t }) => t && !t.startsWith("//") && !t.startsWith("/*") && !t.startsWith("*") && !TRIVIAL.test(t))
    .map(({ line, text: t }) => ({ line, text: t.replace(/\s+/g, " ") }));
}

const seen = new Map();
const findings = [];

for (const rel of sourceFiles()) {
  if (ignored(rel)) continue;
  const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
  if (isGenerated(text)) continue;
  const lines = significant(text);
  for (let i = 0; i + MIN_LINES <= lines.length; i++) {
    const block = lines.slice(i, i + MIN_LINES);
    const key = block.map((l) => l.text).join("\n");
    const at = `${rel}:${block[0].line}`;
    const first = seen.get(key);
    if (!first) {
      seen.set(key, at);
      continue;
    }
    // Overlapping windows of one real block are the same occurrence, not two
    // clones; and a window that starts where the previous one did is the same
    // finding reported twice.
    if (first.startsWith(rel + ":") && Math.abs(parseInt(first.split(":")[1], 10) - block[0].line) < MIN_LINES) continue;
    if (findings.some((f) => f.startsWith(at))) continue;
    findings.push(`${at} duplicates ${first}`);
  }
}

report("dupes", findings);
