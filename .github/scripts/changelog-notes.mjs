#!/usr/bin/env node
// Extract one version's section from a plugin's CHANGELOG.md, for use as the
// body of its GitHub Release.
//
// Why this exists: a Release whose notes are GitHub's auto-generated commit list
// does not tell a user what the version does — it redirects them to commits. The
// changelog is the human-written record of what changed, so the release body is
// taken from it verbatim. A release with no notes is a bug; if the version has
// no section, this script FAILS (non-zero, message naming the file and the
// version) rather than letting the workflow publish an empty release.
//
// Usage:
//   changelog-notes.mjs <plugin> <version>   # prints the section body to stdout
//   changelog-notes.mjs <plugin> <version> --out FILE
//
// The section is matched on the exact heading `## [<version>] - <date>` and runs
// until the next `## [` heading (or EOF), so an entry may contain any prose and
// any number of `###` subsections.
//
// `--out` is what the workflow uses: GitHub Actions' `$GITHUB_OUTPUT` cannot
// carry multi-line values directly, so the notes are written to a file and only
// that file's path crosses the output boundary (see release.yml).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const PLUGINS = ["stats-composer", "usage-context"];

function changelogPath(plugin) {
  return path.join(ROOT, "plugins", plugin, "CHANGELOG.md");
}

// The body of `## [version] - date`, without the heading line itself. Returns
// null when no such heading exists.
export function sectionFor(md, version) {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\]`).test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## \[/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start + 1, end).join("\n").trim();
}

function main() {
  const [plugin, version] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const outIdx = process.argv.indexOf("--out");
  const outFile = outIdx >= 0 ? process.argv[outIdx + 1] : null;

  if (!plugin || !version) throw new Error("usage: changelog-notes.mjs <plugin> <version> [--out FILE]");
  if (!PLUGINS.includes(plugin)) throw new Error(`unknown plugin: ${plugin} (expected one of ${PLUGINS.join(", ")})`);

  const file = changelogPath(plugin);
  if (!fs.existsSync(file)) throw new Error(`no changelog for ${plugin}: expected ${path.relative(ROOT, file)}`);

  const body = sectionFor(fs.readFileSync(file, "utf8"), version);
  if (body == null) {
    throw new Error(
      `no changelog section for ${plugin}@${version} in ${path.relative(ROOT, file)}. ` +
        `Add a "## [${version}] - <date>" section before tagging, so the Release says what changed.`
    );
  }
  if (!body) throw new Error(`the ${plugin}@${version} changelog section is empty in ${path.relative(ROOT, file)}`);

  if (outFile) fs.writeFileSync(outFile, body + "\n");
  else process.stdout.write(body + "\n");
}

// Only run when invoked directly, so a test can import sectionFor without the
// process being driven by argv.
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
