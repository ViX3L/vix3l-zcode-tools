// The changelog tooling: every released version must have a changelog section,
// and the extractor that turns one into a GitHub Release body must find it.
//
// Why this is tested rather than trusted: the extractor runs inside the release
// workflow, on a tag, which is the worst possible moment to discover it is
// wrong. A silent "no notes" release is exactly the failure this tooling exists
// to prevent, so the failure path is asserted here too — a version with no
// section must fail loudly, not print an empty body.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { REPO_ROOT, CHANGELOG_NOTES, STATS_CHANGELOG, USAGE_CHANGELOG, ROOT_CHANGELOG, STATS_PLUGIN_JSON, USAGE_PLUGIN_JSON, readJson } from "../lib/paths.mjs";

const read = (p) => fs.readFileSync(p, "utf8");

function notes(plugin, version) {
  return execFileSync(process.execPath, [CHANGELOG_NOTES, plugin, version], { cwd: REPO_ROOT, encoding: "utf8" });
}
function notesFail(plugin, version) {
  try {
    execFileSync(process.execPath, [CHANGELOG_NOTES, plugin, version], { cwd: REPO_ROOT, encoding: "utf8", stdio: "pipe" });
    return null;
  } catch (e) {
    return String(e.stderr || e.stdout || e.message);
  }
}

test("every plugin ships a changelog and the root index points at it", () => {
  for (const f of [STATS_CHANGELOG, USAGE_CHANGELOG, ROOT_CHANGELOG]) {
    assert.ok(fs.existsSync(f), `missing changelog: ${path.relative(REPO_ROOT, f)}`);
  }
  const root = read(ROOT_CHANGELOG);
  assert.match(root, /plugins\/stats-composer\/CHANGELOG\.md/, "the root index must link the stats-composer changelog");
  assert.match(root, /plugins\/usage-context\/CHANGELOG\.md/, "the root index must link the usage-context changelog");
});

test("the current version of each plugin has a changelog section", () => {
  // The version a release would be cut at is the manifest's; if it has no
  // section, the first tag push after this commit would fail the release.
  for (const [plugin, manifest, changelog] of [
    ["stats-composer", STATS_PLUGIN_JSON, STATS_CHANGELOG],
    ["usage-context", USAGE_PLUGIN_JSON, USAGE_CHANGELOG],
  ]) {
    const version = readJson(manifest).version;
    assert.match(
      read(changelog),
      new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\]`, "m"),
      `${path.relative(REPO_ROOT, changelog)} must have a "## [${version}] - <date>" section for the current manifest version`
    );
  }
});

test("the extractor returns the section body, without the heading or the next version", () => {
  const body = notes("stats-composer", "0.1.18");
  assert.ok(body.trim().length > 0, "the release body must not be empty");
  assert.ok(!/^## \[/.test(body.trim()), "the version heading itself must not be in the body");
  assert.ok(!/\[0\.1\.17\]/.test(body), "the body must stop before the next version's section");
  assert.match(body, /### Fixed/, "the section's own subsections must be preserved");
});

test("the extractor fails loudly when a version has no section", () => {
  const err = notesFail("stats-composer", "9.9.9");
  assert.ok(err, "a version with no changelog section must fail, not print nothing");
  assert.match(err, /no changelog section for stats-composer@9\.9\.9/);
  assert.match(err, /CHANGELOG\.md/, "the error must name the file to fix");
});

test("the extractor refuses an unknown plugin", () => {
  const err = notesFail("not-a-plugin", "1.0.0");
  assert.ok(err);
  assert.match(err, /unknown plugin/);
});

test("--out writes the same notes to a file, as the workflow uses it", async () => {
  const os = await import("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "changelog-notes-"));
  try {
    const out = path.join(dir, "body.md");
    execFileSync(process.execPath, [CHANGELOG_NOTES, "usage-context", "0.1.2", "--out", out], { cwd: REPO_ROOT, encoding: "utf8" });
    assert.ok(fs.existsSync(out), "--out must write the file");
    assert.equal(fs.readFileSync(out, "utf8").trim(), notes("usage-context", "0.1.2").trim(),
      "the file content must equal what stdout would carry");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
