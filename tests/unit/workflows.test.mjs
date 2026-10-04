// The GitHub workflows, checked as files rather than trusted.
//
// A workflow is only validated when it runs — i.e. on a push or a tag, which is
// the worst time to discover a typo. Most of what can go wrong is structural and
// checkable locally, so it is checked here: the triggers, the required jobs, the
// scripts the workflows invoke (they must exist and be executable), and the fact
// that CI does not fire on tags (release.yml owns tags; a second run there would
// be wasted work and a confusing duplicate).
//
// This is a shape check, not a YAML validator: the semantics of every field are
// GitHub's to enforce. It catches the class of mistake a human makes — a renamed
// script, a deleted job, a trigger that overlaps another workflow.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CI_WORKFLOW, RELEASE_WORKFLOW, RELEASE_PLAN, PACKAGE_PLUGIN_SH, GITHUB_DIR, REPO_ROOT, STATS } from "../lib/paths.mjs";

const read = (p) => fs.readFileSync(p, "utf8");

test("both workflows exist and are non-empty", () => {
  for (const f of [CI_WORKFLOW, RELEASE_WORKFLOW]) {
    assert.ok(fs.existsSync(f), `missing workflow: ${path.relative(REPO_ROOT, f)}`);
    assert.ok(read(f).length > 200, `${path.basename(f)} looks empty`);
  }
});

test("CI runs on pushes to branches and on pull requests, but NOT on tags", () => {
  const yml = read(CI_WORKFLOW);
  assert.match(yml, /on:/);
  assert.match(yml, /push:/, "CI must run on push");
  assert.match(yml, /pull_request:/, "CI must run on pull requests");
  // A `push:` block that mentions `tags` would make CI fire on a tag, where
  // release.yml already runs the suite — a duplicate, contradictory run. The
  // trigger is therefore asserted to be branch-only.
  const onBlock = yml.slice(yml.indexOf("on:"), yml.indexOf("jobs:"));
  assert.ok(!/tags:/.test(onBlock), "CI must not trigger on tags; release.yml owns tags");
});

test("the release workflow triggers on tag pushes and can be dispatched", () => {
  const yml = read(RELEASE_WORKFLOW);
  assert.match(yml, /on:/);
  const onBlock = yml.slice(yml.indexOf("on:"), yml.indexOf("jobs:"));
  assert.match(onBlock, /tags:/, "release must trigger on tags");
  assert.match(onBlock, /workflow_dispatch:/, "release should be re-runnable by hand");
  assert.match(yml, /contents: write/, "creating a Release needs contents: write");
});

test("the release workflow gates on the test suite before publishing", () => {
  const yml = read(RELEASE_WORKFLOW);
  assert.match(yml, /needs: \[test, plan\]/, "the release job must depend on the test and plan jobs");
  assert.ok(/docker run/.test(yml) && /shm-size=1g/.test(yml), "the release gate must run the suite in the same container CI uses");
});

test("the scripts the workflows call exist and are runnable", () => {
  assert.ok(fs.existsSync(RELEASE_PLAN), "release-plan.mjs is missing");
  assert.ok(fs.existsSync(PACKAGE_PLUGIN_SH), "package-plugin.sh is missing");
  // package-plugin.sh must be executable: the workflow invokes it with `bash`,
  // but a human runs it directly, and a script that is not +x is a papercut.
  //
  // The failure message names the git cause on purpose. This repo has
  // core.fileMode=false, so `chmod +x` on a working file is NOT recorded by
  // `git add` — the bit has to be set in the index explicitly
  // (`git update-index --chmod=+x <file>`). Locally the file looks executable
  // while a fresh CI checkout is not, which is exactly how this test first went
  // red on a runner but green on the author's machine.
  assert.ok(
    fs.statSync(PACKAGE_PLUGIN_SH).mode & 0o111,
    "package-plugin.sh must be executable. If it looks +x here but CI fails, the bit is not in git: " +
      "this repo has core.fileMode=false, so run `git update-index --chmod=+x .github/scripts/package-plugin.sh`."
  );
  // The workflows must reference exactly the paths that exist, so a rename
  // breaks this test rather than a release.
  const rel = path.relative(REPO_ROOT, RELEASE_PLAN);
  assert.ok(read(RELEASE_WORKFLOW).includes(rel), `release.yml must invoke ${rel}`);
  const shRel = path.relative(REPO_ROOT, PACKAGE_PLUGIN_SH);
  assert.ok(read(RELEASE_WORKFLOW).includes(shRel), `release.yml must invoke ${shRel}`);
});

test("the launcher script a desktop entry Exec= runs is executable", () => {
  // zcode-stats.sh is the target of the Linux .desktop file's Exec= line, which
  // the desktop environment runs directly — a non-executable one silently does
  // nothing when launched from the app menu. Same core.fileMode=false caveat as
  // package-plugin.sh above: the bit must be recorded in the index.
  const launcher = path.join(STATS, "launcher", "zcode-stats.sh");
  assert.ok(fs.existsSync(launcher), "the Linux launcher is missing");
  assert.equal(fs.readFileSync(launcher, "utf8").split("\n")[0], "#!/bin/sh", "the launcher must carry a shebang");
  assert.ok(
    fs.statSync(launcher).mode & 0o111,
    "plugins/stats-composer/launcher/zcode-stats.sh must be executable (its .desktop Exec= runs it directly); " +
      "if it looks +x locally but CI fails, the bit is not in git — run `git update-index --chmod=+x` on it."
  );
  // The desktop entry must actually point at that file name, so a rename cannot
  // leave the launcher unreachable from the app menu.
  const desktop = fs.readFileSync(path.join(STATS, "launcher", "zcode-stats.desktop"), "utf8");
  assert.match(desktop, /Exec=.*zcode-stats\.sh/, "the .desktop Exec= must name zcode-stats.sh");
});

test("the release workflow uploads the three archive kinds per plugin", () => {
  const yml = read(RELEASE_WORKFLOW);
  for (const ext of [".zip", ".tar.gz", ".sha256"]) {
    assert.ok(yml.includes(ext), `release.yml must upload ${ext} assets`);
  }
});

test("the About metadata file exists and names the release tags", () => {
  const about = path.join(GITHUB_DIR, "ABOUT.md");
  assert.ok(fs.existsSync(about), "the About copy must live in version control");
  const txt = read(about);
  assert.match(txt, /stats-composer-v/, "About must document the per-plugin tag shape");
  assert.match(txt, /Topics/i, "About must include the Topics list");
});
