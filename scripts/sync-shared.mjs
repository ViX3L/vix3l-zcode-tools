#!/usr/bin/env node
// sync-shared — keep the canonical shared modules and their plugin copies in
// lock-step.
//
// Each plugin must install and run standalone, so shared bytes physically exist
// inside each plugin. The canonical copy lives in shared/lib/; this script
// writes the reviewed copies into each plugin and fails (`--check`) when a
// copy has drifted. Never edit a generated copy directly: edit shared/lib/.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HEADER = (name) =>
  `// GENERATED FROM shared/lib/${name} — DO NOT EDIT.\n` +
  `// Edits belong in shared/lib/${name}; run \`node scripts/sync-shared.mjs\`.\n\n`;

const ALL = [
  "constants.mjs",
  "paths.mjs",
  "version.mjs",
  "plugin-options.mjs",
  "runtime.mjs",
  "launcher.mjs",
  "cdp.mjs",
  "lock.mjs",
  "hook-protocol.mjs",
];

// Per-plugin allowlist: usage-context never receives launcher/doctor code.
const PLUGINS = {
  "stats-composer": ALL,
  "usage-context": [
    "constants.mjs",
    "paths.mjs",
    "version.mjs",
    "plugin-options.mjs",
    "runtime.mjs",
    "cdp.mjs",
    "lock.mjs",
    "hook-protocol.mjs",
  ],
};

const check = process.argv.includes("--check");
let drift = 0;

for (const [plugin, modules] of Object.entries(PLUGINS)) {
  const targetDir = path.join(ROOT, "plugins", plugin, "scripts", "lib");
  fs.mkdirSync(targetDir, { recursive: true });
  for (const name of modules) {
    const source = path.join(ROOT, "shared", "lib", name);
    const target = path.join(targetDir, name);
    const expected = HEADER(name) + fs.readFileSync(source, "utf8");
    const actual = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
    if (actual === expected) continue;
    if (check) {
      drift++;
      console.error(`drift: plugins/${plugin}/scripts/lib/${name}`);
    } else {
      fs.writeFileSync(target, expected);
      console.log(`wrote plugins/${plugin}/scripts/lib/${name}`);
    }
  }
  // Remove generated copies that are no longer in the allowlist.
  for (const name of fs.readdirSync(targetDir)) {
    if (!name.endsWith(".mjs") || modules.includes(name)) continue;
    const body = fs.readFileSync(path.join(targetDir, name), "utf8");
    if (!body.startsWith("// GENERATED FROM shared/lib/")) continue;
    if (check) {
      drift++;
      console.error(`stale: plugins/${plugin}/scripts/lib/${name}`);
    } else {
      fs.rmSync(path.join(targetDir, name));
      console.log(`removed stale plugins/${plugin}/scripts/lib/${name}`);
    }
  }
}

if (check && drift) {
  console.error(`sync-shared: ${drift} file(s) out of date`);
  process.exit(1);
}
console.log(check ? "sync-shared: up to date" : "sync-shared: done");
