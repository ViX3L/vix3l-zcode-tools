// The plugin package contract: manifests parse, the three version declarations
// agree, paths a manifest names actually exist, and every shipped .mjs parses.
//
// The version rule is a repo convention with real consequences (ZCode compares
// the marketplace declaration against the installed one to decide whether an
// update exists), and it is the kind of thing that rots silently. Making it a
// test is the cheapest way to keep it true.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  STATS, USAGE, STATS_PLUGIN_JSON, USAGE_PLUGIN_JSON, ROOT_MARKETPLACE, DEV_MARKETPLACE,
  STATS_HOOKS, USAGE_HOOKS, STATS_MCP_JSON, readJson, allModuleFiles, REPO_ROOT,
} from "../lib/paths.mjs";

const rootMarket = readJson(ROOT_MARKETPLACE);
const devMarket = readJson(DEV_MARKETPLACE);
const statsPkg = readJson(STATS_PLUGIN_JSON);
const usagePkg = readJson(USAGE_PLUGIN_JSON);

function pluginEntry(market, name) {
  const e = market.plugins.find((p) => p.name === name);
  assert.ok(e, `${market.name} is missing plugin "${name}"`);
  return e;
}

test("marketplace manifests are well formed", () => {
  for (const m of [rootMarket, devMarket]) {
    assert.equal(typeof m.name, "string");
    assert.ok(Array.isArray(m.plugins) && m.plugins.length >= 2, `${m.name} should list its plugins`);
    for (const p of m.plugins) {
      for (const field of ["name", "source", "version", "description", "displayName", "icon", "category"]) {
        assert.ok(p[field], `${m.name}:${p.name} missing "${field}"`);
      }
      assert.match(p.version, /^\d+\.\d+\.\d+$/, `${p.name} version must be semver`);
      assert.equal(p.author?.name, "ViX3L");
    }
  }
});

test("the version is identical in all three declarations", () => {
  // A version string is immutable: a material change means bumping every
  // declaration, so a mismatch here means a bump was half-applied.
  for (const [plugin, pkg] of [["stats-composer", statsPkg], ["usage-context", usagePkg]]) {
    assert.equal(pluginEntry(rootMarket, plugin).version, pkg.version,
      `${plugin}: root marketplace disagrees with plugin.json`);
    assert.equal(pluginEntry(devMarket, plugin).version, pkg.version,
      `${plugin}: dev marketplace disagrees with plugin.json`);
  }
});

test("marketplace source paths resolve inside this repo", () => {
  // The root catalog is consumed by URL, so its source is relative to the repo
  // root; the dev catalog is consumed as a local directory, so its source is
  // relative to plugins/. Both must exist.
  for (const p of rootMarket.plugins) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, p.source)), `root source missing: ${p.source}`);
    assert.ok(fs.existsSync(path.join(REPO_ROOT, p.source, ".zcode-plugin", "plugin.json")),
      `${p.source} has no .zcode-plugin/plugin.json`);
  }
  for (const p of devMarket.plugins) {
    const abs = path.join(REPO_ROOT, "plugins", p.source);
    assert.ok(fs.existsSync(abs), `dev source missing: plugins/${p.source}`);
  }
});

test("each plugin.json declares what its directory actually contains", () => {
  for (const [dir, pkg] of [[STATS, statsPkg], [USAGE, usagePkg]]) {
    if (pkg.commands) {
      assert.ok(fs.existsSync(path.join(dir, pkg.commands)), `${pkg.name}: commands dir missing`);
    }
    if (pkg.skills) {
      assert.ok(fs.existsSync(path.join(dir, pkg.skills)), `${pkg.name}: skills dir missing`);
    }
    assert.equal(pkg.license, "MIT");
    assert.ok(Array.isArray(pkg.keywords) && pkg.keywords.length > 0);
  }
});

test("userConfig entries are complete and sane", () => {
  // Every option needs a title, a description and a default, because the
  // settings form renders all three and a missing default shows up as a broken
  // row. Enumerated options must list their allowed values.
  const allowed = new Map([
    ["mode", ["auto", "skill", "sidecar"]],
    ["position", ["left", "right"]],
  ]);
  for (const pkg of [statsPkg, usagePkg]) {
    for (const [key, opt] of Object.entries(pkg.userConfig || {})) {
      assert.ok(opt.title, `${pkg.name}.${key}: no title`);
      assert.ok(opt.description, `${pkg.name}.${key}: no description`);
      assert.ok("default" in opt, `${pkg.name}.${key}: no default`);
      assert.ok(["string", "boolean", "number"].includes(opt.type), `${pkg.name}.${key}: bad type`);
      if (allowed.has(key)) {
        assert.deepEqual(opt.default, allowed.get(key)[0], `${pkg.name}.${key}: default should be first option`);
        for (const v of allowed.get(key)) {
          assert.match(opt.description, new RegExp(`\\b${v}\\b`), `${pkg.name}.${key}: description must document "${v}"`);
        }
      }
    }
  }
});

test("hook manifests declare only supported events with valid shape", () => {
  const KNOWN = new Set(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"]);
  for (const [file, name] of [[STATS_HOOKS, "stats-composer"], [USAGE_HOOKS, "usage-context"]]) {
    const m = readJson(file);
    assert.ok(m.description, `${name}: hooks.json needs a description`);
    for (const [event, matchers] of Object.entries(m.hooks)) {
      assert.ok(KNOWN.has(event), `${name}: unknown hook event ${event}`);
      assert.ok(Array.isArray(matchers) && matchers.length, `${name}.${event}: must be an array`);
      for (const group of matchers) {
        assert.ok(Array.isArray(group.hooks) && group.hooks.length, `${name}.${event}: no hooks`);
        for (const h of group.hooks) {
          assert.equal(h.type, "process", `${name}.${event}: only "process" hooks are supported`);
          assert.equal(h.command, "node", `${name}.${event}: must run under node`);
          assert.ok(Array.isArray(h.args) && h.args.length, `${name}.${event}: args required`);
          assert.ok(h.timeoutMs > 0 && h.timeoutMs <= 10_000, `${name}.${event}: timeoutMs out of range`);
          assert.ok(h.statusMessage && h.statusMessage.length <= 60, `${name}.${event}: statusMessage too long`);
          // The one variable that is actually expanded for hooks is
          // ZCODE_PLUGIN_ROOT (verified against the app bundle); any other
          // ${...} here would reach the child literally.
          for (const arg of h.args) {
            const vars = [...String(arg).matchAll(/\$\{([^}]+)\}/g)].map((x) => x[1]);
            for (const v of vars) {
              assert.equal(v, "ZCODE_PLUGIN_ROOT", `${name}: hook arg uses unexpanded ${v}`);
            }
          }
        }
      }
    }
  }
});

test("hook entrypoints named by the manifests exist", () => {
  for (const [file, name] of [[STATS_HOOKS, "stats-composer"], [USAGE_HOOKS, "usage-context"]]) {
    const m = readJson(file);
    for (const groups of Object.values(m.hooks)) {
      for (const g of groups) {
        for (const h of g.hooks) {
          const rel = h.args[0].replace("${ZCODE_PLUGIN_ROOT}/", "");
          const abs = path.join(REPO_ROOT, "plugins", name, rel);
          assert.ok(fs.existsSync(abs), `${name}: hook script missing: ${rel}`);
        }
      }
    }
  }
});

test("the MCP manifest points at the server and names it consistently", () => {
  const m = readJson(STATS_MCP_JSON);
  const server = m.mcpServers["stats-composer"];
  assert.ok(server, ".mcp.json must declare the stats-composer server");
  assert.equal(server.command, "node");
  const rel = server.args[0].replace("${ZCODE_PLUGIN_ROOT}/", "");
  assert.ok(fs.existsSync(path.join(STATS, rel)), `MCP server script missing: ${rel}`);
  // The name the app will show must match the plugin, and the server must
  // report the same one in its handshake (checked in the MCP framing test).
  assert.equal(statsPkg.name, "stats-composer");
});

test("every shipped module parses", () => {
  const files = allModuleFiles();
  assert.ok(files.length >= 12, `expected the plugin modules, found ${files.length}`);
  const bad = [];
  for (const f of files) {
    const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
    if (r.status !== 0) bad.push(`${path.relative(REPO_ROOT, f)}: ${r.stderr.split("\n")[0]}`);
  }
  assert.deepEqual(bad, [], "these modules do not parse:\n" + bad.join("\n"));
});

test("no module imports a third-party package", () => {
  // The plugins ship with no dependencies: they run under ZCode's embedded
  // Node, which has only the standard library. An import of anything else would
  // work in this repo (node_modules exists for the tests) and fail on a user's
  // machine — precisely the class of bug a test should catch.
  const importRe = /(?:^|\n)\s*import\s+(?:[^'"]*?from\s+)?["']([^"']+)["']/g;
  const violations = [];
  for (const f of allModuleFiles().filter((x) => x.startsWith(path.join(REPO_ROOT, "plugins")))) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(importRe)) {
      const spec = m[1];
      if (spec.startsWith("node:") || spec.startsWith(".") || spec.startsWith("/")) continue;
      violations.push(`${path.relative(REPO_ROOT, f)} imports "${spec}"`);
    }
  }
  assert.deepEqual(violations, [], violations.join("\n"));
});

test("the two runtime.mjs copies are identical", () => {
  // They are deliberately duplicated (each plugin is separately installable and
  // must not reach into the other's directory), so a fix applied to one and not
  // the other is a real hazard. Keep them byte-identical and this cannot happen.
  const a = fs.readFileSync(path.join(STATS, "scripts", "lib", "runtime.mjs"), "utf8");
  const b = fs.readFileSync(path.join(USAGE, "scripts", "lib", "runtime.mjs"), "utf8");
  assert.equal(a, b, "the two plugins' runtime.mjs have drifted apart");
});

test("the license is MIT in every declaration and a LICENSE file exists", () => {
  // The README, the package.json and both plugin manifests claim MIT; a
  // repository that declares a license without shipping the text of it is a
  // papercut for anyone who wants to reuse the code. So the three declarations
  // are asserted to agree AND the LICENSE file is asserted to exist and hold the
  // standard MIT grant.
  const licensePath = path.join(REPO_ROOT, "LICENSE");
  assert.ok(fs.existsSync(licensePath), "the repository must ship a LICENSE file");
  const text = fs.readFileSync(licensePath, "utf8");
  assert.match(text, /^MIT License/m, "LICENSE must be the MIT license");
  assert.match(text, /Permission is hereby granted, free of charge/, "LICENSE must carry the MIT grant");
  assert.match(text, /WITHOUT WARRANTY OF ANY KIND/, "LICENSE must carry the MIT warranty disclaimer");
  assert.ok(/Copyright \(c\) \d{4}/.test(text), "LICENSE must name a copyright holder and year");
  // Every place a license is declared must say MIT, matching the file.
  assert.equal(readJson(path.join(REPO_ROOT, "package.json")).license, "MIT");
  assert.equal(statsPkg.license, "MIT");
  assert.equal(usagePkg.license, "MIT");
});

test("the documented test commands and the container's agree", () => {
  // The README tells a user to run the suite with a quoted glob, and the
  // container's entrypoint does the same. If either drifts (a bare directory
  // argument, which node --test rejects) the documented command stops working —
  // so the shape is asserted rather than trusted.
  const pkg = readJson(path.join(REPO_ROOT, "package.json"));
  for (const [name, cmd] of Object.entries(pkg.scripts)) {
    if (!name.startsWith("test") || name === "test:docker" || name === "test:docker:build" || name === "test:browser:install") continue;
    assert.ok(
      cmd.includes('"tests/') && cmd.includes('*.test.mjs"'),
      `${name} must use a quoted glob, not a bare directory: ${cmd}`
    );
  }
  const compose = fs.readFileSync(path.join(REPO_ROOT, "tests", "docker", "compose.yml"), "utf8");
  assert.match(compose, /"tests\/\*\*\/\*\.test\.mjs"/, "the compose command must use the full test glob");
  const dockerfile = fs.readFileSync(path.join(REPO_ROOT, "tests", "docker", "Dockerfile"), "utf8");
  assert.match(dockerfile, /"tests\/\*\*\/\*\.test\.mjs"/, "the image entrypoint must use the full test glob");
});

test("the tests README documents every tier directory", () => {
  const readme = fs.readFileSync(path.join(REPO_ROOT, "tests", "README.md"), "utf8");
  for (const tier of ["unit", "integration", "ui", "e2e"]) {
    assert.ok(readme.includes(`${tier}/`), `tests/README.md must document the ${tier} tier`);
  }
  assert.match(readme, /docker compose -f tests\/docker\/compose\.yml run --rm tests/, "the README must give the container command");
});
