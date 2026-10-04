// Absolute paths every test can rely on. One place, so a moved directory or a
// renamed plugin breaks here with a clear message instead of in twenty tests.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TESTS_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const REPO_ROOT = path.dirname(TESTS_DIR);

export const STATS = path.join(REPO_ROOT, "plugins", "stats-composer");
export const USAGE = path.join(REPO_ROOT, "plugins", "usage-context");

export const STATS_PLUGIN_JSON = path.join(STATS, ".zcode-plugin", "plugin.json");
export const USAGE_PLUGIN_JSON = path.join(USAGE, ".zcode-plugin", "plugin.json");
export const ROOT_MARKETPLACE = path.join(REPO_ROOT, "marketplace.json");
export const DEV_MARKETPLACE = path.join(REPO_ROOT, "plugins", "marketplace.json");

export const STATS_HOOKS = path.join(STATS, "hooks", "hooks.json");
export const USAGE_HOOKS = path.join(USAGE, "hooks", "hooks.json");
export const STATS_MCP_JSON = path.join(STATS, ".mcp.json");
export const STATS_MCP_SERVER = path.join(STATS, "mcp", "stats-server.mjs");
export const STATS_SIDECAR = path.join(STATS, "sidecar", "server.mjs");
export const STATS_METRICS = path.join(STATS, "scripts", "lib", "metrics.mjs");
export const STATS_DOCTOR = path.join(STATS, "scripts", "doctor.mjs");
export const STATS_CLI = path.join(STATS, "scripts", "stats.mjs");
export const STATS_RUNTIME = path.join(STATS, "scripts", "lib", "runtime.mjs");
export const USAGE_RUNTIME = path.join(USAGE, "scripts", "lib", "runtime.mjs");
export const STATS_INJECTOR = path.join(STATS, "injector", "inject.mjs");
export const USAGE_INJECTOR = path.join(USAGE, "injector", "inject.mjs");
export const STATS_SKILL = path.join(STATS, "skills", "stats-composer", "SKILL.md");
export const USAGE_SKILL = path.join(USAGE, "skills", "usage-context", "SKILL.md");

export const GITHUB_DIR = path.join(REPO_ROOT, ".github");
export const RELEASE_PLAN = path.join(GITHUB_DIR, "scripts", "release-plan.mjs");
export const PACKAGE_PLUGIN_SH = path.join(GITHUB_DIR, "scripts", "package-plugin.sh");
export const CI_WORKFLOW = path.join(GITHUB_DIR, "workflows", "ci.yml");
export const RELEASE_WORKFLOW = path.join(GITHUB_DIR, "workflows", "release.yml");
export const CHANGELOG_NOTES = path.join(GITHUB_DIR, "scripts", "changelog-notes.mjs");

// Per-plugin changelogs, and the root index that points at them.
export const STATS_CHANGELOG = path.join(STATS, "CHANGELOG.md");
export const USAGE_CHANGELOG = path.join(USAGE, "CHANGELOG.md");
export const ROOT_CHANGELOG = path.join(REPO_ROOT, "CHANGELOG.md");

// Every .mjs we ship, for the "do they all parse" sweep. Includes the release
// tooling under .github/scripts: a syntax error there fails a release rather
// than a test, and a red release is the worst place to discover one.
export function allModuleFiles() {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".mjs")) out.push(p);
    }
  };
  walk(path.join(REPO_ROOT, "plugins"));
  walk(path.join(REPO_ROOT, "tests"));
  walk(path.join(GITHUB_DIR, "scripts"));
  return out.sort();
}

export function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
