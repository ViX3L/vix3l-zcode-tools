// The release tooling: the tag→plugin plan and the plugin packaging.
//
// These scripts run in CI on a tag, which is the least convenient moment to
// discover they are wrong. So they are exercised here: the plan is a pure
// function of the tag and the manifests (invoked as a subprocess, exactly as the
// workflow does), and packaging is run against the real plugin tree and then
// inspected (the archive's top-level entry, its checksums).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { REPO_ROOT, RELEASE_PLAN, PACKAGE_PLUGIN_SH, readJson, STATS_PLUGIN_JSON, USAGE_PLUGIN_JSON, ROOT_MARKETPLACE } from "../lib/paths.mjs";

const statsV = readJson(STATS_PLUGIN_JSON).version;
const usageV = readJson(USAGE_PLUGIN_JSON).version;

// Run the plan script and parse its stdout matrix (GITHUB_OUTPUT unset ⇒ it
// prints "matrix=…\nany=…" followed by the pretty JSON).
function plan(tag) {
  const out = execFileSync(process.execPath, [RELEASE_PLAN, tag], { cwd: REPO_ROOT, encoding: "utf8" });
  const line = out.split("\n").find((l) => l.startsWith("matrix="));
  const any = /^any=(true|false)$/m.exec(out)?.[1] === "true";
  return { matrix: JSON.parse(line.slice("matrix=".length)), any };
}
function planFails(tag) {
  try {
    execFileSync(process.execPath, [RELEASE_PLAN, tag], { cwd: REPO_ROOT, encoding: "utf8", stdio: "pipe" });
    return null;
  } catch (e) {
    return String(e.stderr || e.stdout || e.message);
  }
}

test("a repo-wide tag plans every plugin at its own manifest version", () => {
  const { matrix, any } = plan("v9.9.9");
  assert.equal(any, true);
  assert.deepEqual(matrix.include.map((x) => x.plugin).sort(), ["stats-composer", "usage-context"]);
  // Each plugin is planned at ITS manifest version, not the tag's — the tag is
  // the trigger, the manifest is the truth.
  const byPlugin = Object.fromEntries(matrix.include.map((x) => [x.plugin, x.version]));
  assert.equal(byPlugin["stats-composer"], statsV);
  assert.equal(byPlugin["usage-context"], usageV);
  // Release tags are plugin-qualified so two plugins' releases never share one.
  for (const x of matrix.include) assert.equal(x.tag, `${x.plugin}-v${x.version}`);
});

test("a plugin tag plans exactly that plugin", () => {
  const { matrix } = plan(`stats-composer-v${statsV}`);
  assert.equal(matrix.include.length, 1);
  assert.equal(matrix.include[0].plugin, "stats-composer");
  assert.equal(matrix.include[0].version, statsV);
  assert.equal(matrix.include[0].tag, `stats-composer-v${statsV}`);
});

test("the release title uses the marketplace display name, not the raw plugin name", () => {
  const cat = readJson(ROOT_MARKETPLACE);
  for (const x of plan("v1.0.0").matrix.include) {
    const display = (cat.plugins || []).find((p) => p.name === x.plugin)?.displayName;
    assert.equal(x.title, `${display} ${x.version}`, "the title must match what the marketplace shows");
    assert.notEqual(x.title, `${x.plugin} ${x.version}`);
  }
});

test("a tag whose version disagrees with the manifest is refused", () => {
  const err = planFails("stats-composer-v999.0.0");
  assert.ok(err, "a mismatched tag must fail the plan");
  assert.match(err, /says stats-composer@999\.0\.0/);
  assert.match(err, /plugin\.json says /, "the error must name the manifest, so the fix is obvious");
});

test("an unknown plugin in a tag is refused", () => {
  const err = planFails("not-a-plugin-v1.0.0");
  assert.ok(err);
  assert.match(err, /unknown plugin in tag/);
});

test("a malformed tag is refused", () => {
  assert.ok(planFails("just-a-name"));
  assert.ok(planFails(""));
});

test("the plan accepts a full refs/tags/ ref, as Actions supplies it", () => {
  const { matrix } = plan(`refs/tags/stats-composer-v${statsV}`);
  assert.equal(matrix.include[0].plugin, "stats-composer");
});

test("packaging a plugin produces a zip, a tar.gz and verifiable checksums", () => {
  const out = execFileSync("bash", [PACKAGE_PLUGIN_SH, "usage-context", usageV], { cwd: REPO_ROOT, encoding: "utf8" });
  const dist = path.join(REPO_ROOT, "dist");
  const base = `usage-context-${usageV}`;
  for (const f of [`${base}.zip`, `${base}.tar.gz`, `${base}.sha256`]) {
    assert.ok(fs.existsSync(path.join(dist, f)), `packaging must write ${f}`);
  }
  // The archive's top-level entry is the plugin directory: unpacking it into a
  // plugins directory yields exactly that plugin.
  const listing = execFileSync("tar", ["-tzf", path.join(dist, `${base}.tar.gz`)], { encoding: "utf8" })
    .trim().split("\n");
  assert.equal(listing[0], "usage-context/", "the archive root must be the plugin directory");
  assert.ok(listing.some((l) => l === "usage-context/.zcode-plugin/plugin.json"), "the manifest must be inside");
  // No dependency directories may be shipped.
  assert.ok(!listing.some((l) => l.includes("node_modules")), "the archive must not carry node_modules");
});

test("the checksum file verifies with sha256sum -c", () => {
  const dist = path.join(REPO_ROOT, "dist");
  const base = `usage-context-${usageV}`;
  const out = execFileSync("sha256sum", ["-c", `${base}.sha256`], { cwd: dist, encoding: "utf8" });
  assert.match(out, /OK/);
  assert.ok(!/FAILED/.test(out));
});

test("packaging refuses a version that disagrees with the manifest", () => {
  const err = (() => {
    try { execFileSync("bash", [PACKAGE_PLUGIN_SH, "stats-composer", "999.0.0"], { cwd: REPO_ROOT, encoding: "utf8", stdio: "pipe" }); return null; }
    catch (e) { return String(e.stderr || e.message); }
  })();
  assert.ok(err, "packaging a mismatched version must fail");
  assert.match(err, /version mismatch/);
});

test("packaging refuses a plugin that does not exist", () => {
  const err = (() => {
    try { execFileSync("bash", [PACKAGE_PLUGIN_SH, "no-such-plugin", "1.0.0"], { cwd: REPO_ROOT, encoding: "utf8", stdio: "pipe" }); return null; }
    catch (e) { return String(e.stderr || e.message); }
  })();
  assert.ok(err);
  assert.match(err, /no such plugin directory/);
});

after(() => {
  // The packaging tests wrote a dist/ tree; remove it so a test run leaves the
  // checkout as it found it.
  try { fs.rmSync(path.join(REPO_ROOT, "dist"), { recursive: true, force: true }); } catch {}
});
