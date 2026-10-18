// Shared plumbing for the repo-local quality gates.
//
// These gates are dependency-free on purpose: a plugin repository whose only
// install is Playwright should not grow a second dependency tree just to check
// its own source. Each gate prints one line per finding and exits non-zero, so
// it composes in CI and locally without a wrapper.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const SOURCE_DIRS = ["shared", "scripts", "plugins", "tests", ".github/scripts"];
const SOURCE_EXT = new Set([".mjs", ".js", ".css", ".sh", ".yml", ".yaml"]);

export function walk(dir, out = []) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(rel, out);
    else if (SOURCE_EXT.has(path.extname(entry.name))) out.push(rel);
  }
  return out;
}

export function sourceFiles() {
  return SOURCE_DIRS.flatMap((dir) => walk(dir)).sort();
}

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

let _ignore;
function ignoreList() {
  if (_ignore) return _ignore;
  const file = path.join(ROOT, ".qualityignore");
  if (!fs.existsSync(file)) return (_ignore = []);
  _ignore = fs.readFileSync(file, "utf8").split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const [pattern, ...reason] = line.split(/\s+#\s+/);
      if (!reason.length) throw new Error(`.qualityignore entry needs a " # reason": ${line}`);
      return { pattern, glob: globToRegExp(pattern), reason: reason.join(" # ") };
    });
  return _ignore;
}

export function ignored(rel) {
  const posix = rel.split(path.sep).join("/");
  return ignoreList().find((e) => e.glob.test(posix)) || null;
}

export function isGenerated(text) {
  return /^\/\/ GENERATED FROM /m.test(text);
}

export function report(gate, findings) {
  for (const f of findings) console.log(`${gate}: ${f}`);
  if (findings.length) {
    console.error(`${gate}: ${findings.length} finding(s)`);
    process.exitCode = 1;
  } else {
    console.log(`${gate}: clean`);
  }
}
