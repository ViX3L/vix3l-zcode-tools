#!/usr/bin/env node
// Unused imports and exports, without a dependency.
//
// The detector is deliberately conservative: a name counts as used if it
// appears anywhere in another source file, so a test-only export is kept. It
// reports the two failures that actually bit this repo: an import left behind
// by a move, and an export whose last caller went away.
import fs from "node:fs";
import path from "node:path";
import { ROOT, sourceFiles, ignored, isGenerated, report } from "./lib.mjs";

const files = sourceFiles().filter((rel) => /\.(mjs|js)$/.test(rel) && !ignored(rel));
const texts = new Map(files.map((rel) => [rel, fs.readFileSync(path.join(ROOT, rel), "utf8")]));
const findings = [];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const references = (name) => new RegExp(`\\b${escapeRe(name)}\\b`);

// --- imports ---------------------------------------------------------------
for (const [rel, text] of texts) {
  if (isGenerated(text)) continue;
  // Anchored at a line start so prose and comments cannot be mistaken for an
  // import whose clause then swallows the next real statement.
  const importRe = /^import\s+([\s\S]*?)\s+from\s+["'][^"']+["'];?/gm;
  let m;
  while ((m = importRe.exec(text))) {
    const clause = m[1].trim();
    const names = [];
    const braces = /\{([\s\S]*?)\}/.exec(clause);
    if (braces) {
      for (const part of braces[1].split(",")) {
        const bits = part.trim().split(/\s+as\s+/);
        if (bits[0]) names.push(bits[bits.length - 1].trim());
      }
    }
    const rest = clause.replace(/\{[\s\S]*?\}/, "").replace(/,/g, " ").trim();
    if (rest && !rest.startsWith("*")) names.push(rest.split(/\s+/)[0]);
    for (const name of names) {
      if (!name || name === "type") continue;
      const body = text.slice(0, m.index) + text.slice(m.index + m[0].length);
      if (!references(name).test(body)) findings.push(`${rel}: unused import ${name}`);
    }
  }
}

// --- exports ---------------------------------------------------------------
const exported = [];
for (const [rel, text] of texts) {
  if (isGenerated(text)) continue;
  for (const m of text.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    exported.push({ rel, name: m[1] });
  }
}
for (const { rel, name } of exported) {
  const usedElsewhere = [...texts].some(([other, text]) =>
    other !== rel && !isGenerated(text) && references(name).test(text)
  );
  if (!usedElsewhere) findings.push(`${rel}: unused export ${name}`);
}

report("dead", findings);
