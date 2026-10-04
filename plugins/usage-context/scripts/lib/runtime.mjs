// runtime.mjs — the one place that knows how to launch a Node child process on
// Linux, macOS and Windows.
//
// Why this exists (three real, platform-specific hazards it fixes):
//
// 1. ELECTRON_RUN_AS_NODE must be inherited.
//    ZCode is an Electron app that embeds Node (v24 on 3.14.x) inside its own
//    binary. It also rewrites plugin MCP servers to run under that embedded
//    Node, launching  <appBinary> <zcode.cjs> __zcode-plugin-host <script>
//    with ELECTRON_RUN_AS_NODE=1. Any code of ours that runs in that context
//    has process.execPath === the Electron app binary, not a `node` binary.
//    Spawning process.execPath WITHOUT ELECTRON_RUN_AS_NODE=1 therefore starts
//    a second copy of the GUI application instead of a Node process — verified
//    on this machine: the child printed app startup logs and never ran the
//    script. So every child spawn must re-assert the flag when the parent has
//    it.
//
// 2. windowsHide.
//    On Windows a spawned console child flashes a console window unless
//    windowsHide:true. The hooks and the sidecar spawn detached children
//    specifically so they outlive the parent, which is exactly the case that
//    flashes. Harmless on Linux/macOS (the option is simply ignored there).
//
// 3. Detached + stdio:"ignore".
//    A child we want to outlive the hook must not hold the parent's stdout
//    (the hook's stdout IS the hook protocol and must contain only JSON), so
//    stdio is "ignore" everywhere and the child is unref'd.

import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

// The Node executable to use for our own child processes.
export function nodeExecutable() {
  return process.execPath;
}

// Environment for a Node child. Preserves the embedded-Node marker when the
// current process was itself started as embedded Node, so the child becomes a
// Node process rather than a GUI relaunch (hazard 1).
export function childEnv(extra) {
  const env = { ...process.env, ...(extra || {}) };
  if (process.env.ELECTRON_RUN_AS_NODE === "1") env.ELECTRON_RUN_AS_NODE = "1";
  // Node warns on the experimental sqlite module; the sidecar/injector both
  // import it, and a warning on stderr would pollute the hook JSON protocol.
  env.NODE_NO_WARNINGS = env.NODE_NO_WARNINGS || "1";
  return env;
}

// Launch a Node script as a detached background process that survives the
// caller (used by the hooks to bring the sidecar up). Returns the child, or
// null when the spawn could not even be started. Never throws.
export function spawnDetachedNode(scriptPath, args, extraEnv) {
  try {
    const child = spawn(nodeExecutable(), [scriptPath, ...(args || [])], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: childEnv(extraEnv),
    });
    child.unref();
    return child;
  } catch {
    return null;
  }
}

// Launch a Node script tied to the caller's lifetime (the sidecar's injector).
// Same flag/hidden-console handling, but the caller keeps the handle to kill.
export function spawnAttachedNode(scriptPath, args, extraEnv) {
  try {
    return spawn(nodeExecutable(), [scriptPath, ...(args || [])], {
      detached: false,
      stdio: "ignore",
      windowsHide: true,
      env: childEnv(extraEnv),
    });
  } catch {
    return null;
  }
}

// Launch a Node script whose OUTPUT the caller needs to read (the doctor's MCP
// handshake probe). Same executable and env handling as the others — including
// the ELECTRON_RUN_AS_NODE re-assertion, which matters here: the doctor may run
// under ZCode's embedded Node, where process.execPath is the GUI app binary, so
// a plain spawn would relaunch the GUI instead of running the script. stdout is
// piped; stderr is discarded (the sqlite experimental warning would otherwise
// interleave with the protocol).
export function spawnNodePiped(scriptPath, args, extraEnv) {
  try {
    return spawn(nodeExecutable(), [scriptPath, ...(args || [])], {
      detached: false,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
      env: childEnv(extraEnv),
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Locating the ZCode installation
// ---------------------------------------------------------------------------
//
// The launcher scripts (launcher/) need the app binary path, and the user may
// have installed ZCode anywhere. ZCode always exports the paths of its bundled
// CLI tools (bfs/ripgrep/ugrep) as  <appRoot>/resources/tools/<tool>/<bin>,
// which is a reliable, platform-independent way to recover the app root.

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

// The GUI executable for a given app root and platform.
export function appBinaryFor(root, platform = process.platform) {
  if (!root) return null;
  if (platform === "darwin") {
    // <root> is "<...>/ZCode.app/Contents/Resources"
    const m = root.match(/^(.*\.app)[\\/]Contents[\\/]Resources$/);
    return m ? path.join(m[1], "Contents", "MacOS", "ZCode") : null;
  }
  if (platform === "win32") return path.join(root, "ZCode.exe");
  return path.join(root, "zcode");
}

// Default on-disk locations to probe when the env gives us nothing.
export function candidateAppBinaries(platform = process.platform, env = process.env) {
  const found = [];
  const fromEnv = appBinaryFor(appRootFromEnv(env, platform), platform);
  if (fromEnv) found.push(fromEnv);
  if (platform === "darwin") {
    found.push("/Applications/ZCode.app/Contents/MacOS/ZCode");
    found.push(path.join(os.homedir(), "Applications", "ZCode.app", "Contents", "MacOS", "ZCode"));
  } else if (platform === "win32") {
    const local = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    found.push(path.join(local, "Programs", "ZCode", "ZCode.exe"));
    found.push(path.join(env["ProgramFiles"] || "C:\\Program Files", "ZCode", "ZCode.exe"));
  } else {
    found.push("/opt/ZCode/zcode");
    found.push("/usr/lib/zcode/zcode");
    found.push("/usr/bin/zcode");
    found.push(path.join(os.homedir(), ".local", "bin", "zcode"));
  }
  return found;
}
