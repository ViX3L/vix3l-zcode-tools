// Plugin version from the installed manifest.
//
// The manifest is not on any hot path, but the first snapshot of a sidecar is:
// resolving it lazily (and never with a module-scope const that a call site can
// reach before initialization) is what keeps a startup race out of the data.
import fs from "node:fs";
import path from "node:path";

export function pluginVersion(root) {
  if (!root) return "0.0.0";
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, ".zcode-plugin", "plugin.json"), "utf8")
    );
    return manifest.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function pluginName(root) {
  if (!root) return "";
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, ".zcode-plugin", "plugin.json"), "utf8")
    );
    return manifest.name || "";
  } catch {
    return "";
  }
}
