// GENERATED FROM shared/lib/launcher.mjs — DO NOT EDIT.
// Edits belong in shared/lib/launcher.mjs; run `node scripts/sync-shared.mjs`.

// Locating the ZCode installation.
//
// The launcher scripts need the app binary path, and the user may have
// installed ZCode anywhere. ZCode exports the paths of its bundled CLI tools
// as <appRoot>/resources/tools/<tool>/<bin>, which is a reliable,
// platform-independent way to recover the app root.
import os from "node:os";
import path from "node:path";

export function appRootFromEnv(env = process.env, platform = process.platform) {
  const sep = platform === "win32" ? "\\" : "/";
  const marker = `${sep}resources${sep}tools${sep}`;
  for (const key of ["ZCODE_BFS_BINARY", "ZCODE_RG_BINARY", "ZCODE_UGREP_BINARY"]) {
    const value = env[key];
    if (!value) continue;
    const at = value.lastIndexOf(marker);
    if (at > 0) return value.slice(0, at);
  }
  return null;
}

export function appBinaryFor(root, platform = process.platform) {
  if (!root) return null;
  if (platform === "darwin") {
    const match = root.match(/^(.*\.app)[\\/]Contents[\\/]Resources$/);
    return match ? path.join(match[1], "Contents", "MacOS", "ZCode") : null;
  }
  if (platform === "win32") return path.join(root, "ZCode.exe");
  return path.join(root, "zcode");
}

export function candidateAppBinaries(platform = process.platform, env = process.env) {
  const found = [];
  const fromEnv = appBinaryFor(appRootFromEnv(env, platform), platform);
  if (fromEnv) found.push(fromEnv);
  if (platform === "darwin") {
    found.push("/Applications/ZCode.app/Contents/MacOS/ZCode");
    found.push(
      path.join(os.homedir(), "Applications", "ZCode.app", "Contents", "MacOS", "ZCode")
    );
  } else if (platform === "win32") {
    const local = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    found.push(path.join(local, "Programs", "ZCode", "ZCode.exe"));
    found.push(path.join(env.ProgramFiles || "C:\\Program Files", "ZCode", "ZCode.exe"));
  } else {
    found.push("/opt/ZCode/zcode");
    found.push("/usr/lib/zcode/zcode");
    found.push("/usr/bin/zcode");
    found.push(path.join(os.homedir(), ".local", "bin", "zcode"));
  }
  return found;
}
