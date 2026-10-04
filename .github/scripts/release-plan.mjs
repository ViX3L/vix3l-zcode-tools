#!/usr/bin/env node
// Turn a git tag into the list of plugins to release, and emit it as a GitHub
// Actions matrix. Kept as a script (not inline YAML) so it can be run and tested
// locally: `.github/scripts/release-plan.mjs v0.1.17`, `... stats-composer-v0.1.17`.
//
// Tag shapes:
//   v<version>                  → every plugin, each at its CURRENT manifest version
//   <plugin>-v<version>         → that one plugin, at the tag's version
//
// In the second form the tag version must match the manifest, and a mismatch is
// a hard failure: publishing an archive whose internal version disagrees with
// the tag is the one outcome a release must never produce.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");

// The plugins this marketplace ships, in catalog order. A directory present but
// unlisted is ignored (it is not part of the marketplace).
const PLUGINS = ["stats-composer", "usage-context"];

function manifestOf(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "plugins", name, ".zcode-plugin", "plugin.json"), "utf8"));
}

// displayName is not in the plugin manifest; it is a catalog field. Read it from
// the root marketplace.json so a Release title matches what the marketplace
// shows the user.
function displayNameOf(name) {
  try {
    const cat = JSON.parse(fs.readFileSync(path.join(ROOT, "marketplace.json"), "utf8"));
    return (cat.plugins || []).find((p) => p.name === name)?.displayName || name;
  } catch {
    return name;
  }
}

function main() {
  const raw = (process.argv[2] || "").trim();
  if (!raw) throw new Error("usage: release-plan.mjs <tag>");
  // Accept a full ref (refs/tags/x) as well as a bare tag name.
  const tag = raw.replace(/^refs\/tags\//, "");

  let selected; // [{ name, version, tag }]
  const bare = /^v(\d[^/]*)$/.exec(tag);
  if (bare) {
    // A repo-wide tag: release every plugin, each at its own manifest version,
    // and tag each Release with the plugin-qualified tag so the two plugins'
    // releases do not collide on one tag.
    selected = PLUGINS.map((name) => {
      const m = manifestOf(name);
      return { name, version: m.version, tag: `${name}-v${m.version}` };
    });
    // The bare tag itself is the "everything at once" marker; if the caller
    // wants one Release under it, a per-plugin tag is still what is published,
    // because a Release tag must be unique.
    if (!selected.length) throw new Error("no plugins to release");
  } else {
    const m = /^([a-z0-9-]+)-v(\d[^/]*)$/.exec(tag);
    if (!m) throw new Error(`unrecognised tag: ${tag} (expected vX.Y.Z or <plugin>-vX.Y.Z)`);
    const [, name, version] = m;
    if (!PLUGINS.includes(name)) throw new Error(`unknown plugin in tag: ${name}`);
    const manifest = manifestOf(name);
    if (manifest.version !== version) {
      throw new Error(
        `tag ${tag} says ${name}@${version} but plugins/${name}/.zcode-plugin/plugin.json says ${manifest.version}. ` +
          `Bump the manifest (and both marketplace.json entries) to ${version}, or retag.`
      );
    }
    selected = [{ name, version, tag }];
  }

  const matrix = {
    include: selected.map((s) => ({
      plugin: s.name,
      version: s.version,
      tag: s.tag,
      title: `${displayNameOf(s.name)} ${s.version}`,
    })),
  };

  // GitHub Actions reads outputs from $GITHUB_OUTPUT when present; otherwise
  // (a local run) print, so the script doubles as a way to inspect the plan.
  const out = process.env.GITHUB_OUTPUT;
  const emit = `matrix=${JSON.stringify(matrix)}\nany=${selected.length > 0}\n`;
  if (out) fs.appendFileSync(out, emit);
  else process.stdout.write(emit + JSON.stringify(matrix, null, 2) + "\n");
}

main();
