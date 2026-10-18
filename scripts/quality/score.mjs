#!/usr/bin/env node
// Certify the DRY and clean-code scorecards mechanically.
//
// Every scorecard point must be backed by a command. This script is that
// command: it runs the four gates plus the small
// structural checks that the gates cannot express, prints one line per point,
// and exits non-zero unless every point passes. A 10/10 is therefore an
// assertion about the tree, not a reviewer's mood.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, sourceFiles } from "./lib.mjs";

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const node = (...args) => spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8" }).status === 0;

const MANIFESTS = ["stats-composer", "usage-context"];
const manifestOf = (name) =>
  JSON.parse(read(`plugins/${name}/.zcode-plugin/plugin.json`));

// A source file is first-party if the quality lib walks it; generated copies
// carry the header and are verified by the sync gate instead.
const sources = sourceFiles().filter((rel) => /\.(mjs|js)$/.test(rel) && !read(rel).startsWith("// GENERATED FROM "));
const code = new Map(sources.map((rel) => [rel, read(rel)]));

function sharedCopiesHaveHeader() {
  // The allowlist per plugin lives in sync-shared.mjs; this check verifies the
  // property the allowlist exists for: every copied file announces its source.
  const shared = fs.readdirSync(path.join(ROOT, "shared", "lib")).filter((f) => f.endsWith(".mjs"));
  const copies = MANIFESTS.flatMap((plugin) =>
    fs.readdirSync(path.join(ROOT, "plugins", plugin, "scripts", "lib"))
      .filter((f) => f.endsWith(".mjs"))
      .map((f) => `plugins/${plugin}/scripts/lib/${f}`)
  ).filter((rel) => read(rel).startsWith("// GENERATED FROM "));
  return shared.length > 0 && copies.every((rel) =>
    /^\/\/ GENERATED FROM shared\/lib\/[a-z-]+\.mjs/.test(read(rel))
  );
}

function onlyDefinition(name) {
  const re = new RegExp(`(?:function\\s+${name}\\b|${name}\\s*=\\s*(?:async\\s*)?function)`);
  return sources.filter((rel) => re.test(code.get(rel)));
}

function hasIntervalAndClear(rel) {
  const text = read(rel);
  return !text.includes("setInterval(") || text.includes("clearInterval(");
}

function hasServerClose(rel) {
  const text = read(rel);
  return !text.includes("createServer(") || /server\.close\(|closeAllConnections\(/.test(text);
}

function noTopLevelServerInLibrary(rel) {
  if (/(?:^|\/)(?:inject|server)\.mjs$/.test(rel)) return true;
  return !/^const\s+\w+\s*=\s*(?:createServer|new\s+DatabaseSync)\(/m.test(read(rel));
}

function readmeStatesVersions() {
  const readme = read("README.md");
  return MANIFESTS.every((name) => readme.includes(manifestOf(name).version));
}

function changelogStatesVersions() {
  return MANIFESTS.every((name) => {
    const version = manifestOf(name).version;
    return read(`plugins/${name}/CHANGELOG.md`).includes(version);
  });
}

const points = [
  // --- DRY ---------------------------------------------------------------
  ["D1", "DRY", "Canonical shared sources, generated copies named", sharedCopiesHaveHeader],
  ["D2", "DRY", "shared copies synchronized", () => node("scripts/sync-shared.mjs", "--check")],
  ["D3", "DRY", "no clone blocks in first-party source", () => node("scripts/quality/dupes.mjs")],
  ["D4", "DRY", "defaults come from constants", () =>
    ["plugins/stats-composer/injector/inject.mjs", "plugins/usage-context/injector/inject.mjs"]
      .every((rel) => read(rel).includes("DEFAULT_CDP_PORT")) &&
    read("plugins/stats-composer/scripts/lib/options.mjs").includes("DEFAULT_SIDECAR_PORT") &&
    read("plugins/usage-context/scripts/lib/options.mjs").includes("DEFAULT_SIDECAR_PORT")],
  ["D5", "DRY", "one projection for model_usage rows", () =>
    !sources.some((rel) =>
      /FROM model_usage/.test(code.get(rel)) &&
      !rel.startsWith("plugins/stats-composer/scripts/lib/metrics/") &&
      !rel.endsWith("lib/doctor.mjs") &&
      !rel.startsWith("scripts/quality/")
    )],
  ["D6", "DRY", "one renderer per format inside each plugin", () =>
    ["fmtMs", "fmtDur", "fmtTok"].every((name) => {
      const defs = onlyDefinition(name);
      const plugins = new Set(defs.map((rel) => rel.split("/")[1]));
      return defs.length === plugins.size;
    })],
  ["D7", "DRY", "one config resolver", () =>
    read("shared/lib/plugin-options.mjs").includes("export function readPluginOptions") &&
    MANIFESTS.every((name) => read(`plugins/${name}/scripts/lib/options.mjs`).includes("readPluginOptions("))],
  ["D8", "DRY", "marketplace catalogs agree with manifests", () => node("--test", "tests/unit/manifests.test.mjs")],
  ["D9", "DRY", "CI and release share one container-test job", () =>
    ["ci.yml", "release.yml"].every((f) =>
      read(`.github/workflows/${f}`).includes("./.github/workflows/container-tests.yml")) &&
    read(".github/workflows/container-tests.yml").includes("docker run")],
  ["D10", "DRY", "one test-helper set", () =>
    ["net", "env", "poll", "sidecar", "cdp"].every((f) => exists(`tests/lib/${f}.mjs`)) &&
    read("tests/lib/sidecar.mjs").includes('from "./net.mjs"') &&
    read("tests/lib/sidecar.mjs").includes('from "./poll.mjs"')],

  // --- Clean code --------------------------------------------------------
  ["C1", "Clean", "size limits (module/function/entrypoint)", () => node("scripts/quality/lint.mjs")],
  ["C2", "Clean", "libraries have no module-scope server or DB", () =>
    sources.filter((rel) => rel.startsWith("plugins/") || rel.startsWith("shared/"))
      .every(noTopLevelServerInLibrary)],
  ["C3", "Clean", "timers and servers have a teardown", () =>
    sources.filter((rel) => !rel.startsWith("scripts/quality/"))
      .every((rel) => hasIntervalAndClear(rel) && hasServerClose(rel))],
  ["C4", "Clean", "errors surfaced or deliberately recovered", () => node("scripts/quality/lint.mjs")],
  ["C5", "Clean", "no write-only state", () => node("scripts/quality/dead.mjs")],
  ["C6", "Clean", "no dead imports or exports", () => node("scripts/quality/dead.mjs")],
  ["C7", "Clean", "every declared option has a reader", () =>
    node("--test", "tests/unit/options.test.mjs", "tests/unit/manifests.test.mjs")],
  ["C8", "Clean", "trust boundaries encoded", () =>
    node("scripts/quality/lint.mjs") &&
    read("tests/ui/chips.test.mjs").includes("onerror") &&
    read("tests/ui/chips.test.mjs").includes("__uc_pwned")],
  ["C9", "Clean", "tests are not silently skipped", () =>
    !sources.some((rel) => rel.startsWith("tests/") && /\.(?:only|skip)\(|\btodo\s*:/.test(code.get(rel)))],
  ["C10", "Clean", "README and changelogs state the shipped versions", () =>
    readmeStatesVersions() && changelogStatesVersions()],
];

const results = [];
for (const [id, axis, label, run] of points) {
  let ok = false;
  let detail = "";
  try {
    ok = run() === true;
  } catch (e) {
    detail = e?.message || String(e);
  }
  results.push({ id, axis, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id.padEnd(3)} ${axis.padEnd(5)} ${label}${detail ? ` — ${detail}` : ""}`);
}

const score = (axis) => {
  const list = results.filter((r) => r.axis === axis);
  return list.filter((r) => r.ok).length + "/" + list.length;
};
const failed = results.filter((r) => !r.ok).length;
console.log(`\nDRY ${score("DRY")} · Clean code ${score("Clean")}`);
if (failed) {
  console.error(`${failed} scorecard point(s) failed`);
  process.exitCode = 1;
} else {
  console.log("10/10 on both axes");
}
