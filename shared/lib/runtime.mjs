// The one place that knows how to launch a Node child process on Linux,
// macOS and Windows.
//
// Three real, platform-specific hazards it fixes:
//
// 1. ELECTRON_RUN_AS_NODE must be inherited. ZCode is an Electron app that
//    embeds Node. Any code of ours running in that context has
//    process.execPath === the Electron binary, so spawning it without the flag
//    starts a second GUI instead of a Node process. Every child spawn
//    re-asserts the flag when the parent has it.
// 2. windowsHide. A spawned console child flashes a window on Windows unless
//    the option is set. Harmless elsewhere.
// 3. Detached + stdio:"ignore". A child that must outlive a hook cannot hold
//    the hook's stdout (the hook protocol is JSON on stdout), so stdio is
//    ignored and the child is unref'd.
import { spawn } from "node:child_process";
import { HTTP_TIMEOUT_MS } from "./constants.mjs";

export function nodeExecutable() {
  return process.execPath;
}

export function childEnv(extra) {
  const env = { ...process.env, ...(extra || {}) };
  if (process.env.ELECTRON_RUN_AS_NODE === "1") env.ELECTRON_RUN_AS_NODE = "1";
  // node:sqlite is experimental; its warning on stderr would pollute the hook
  // JSON protocol (stdout) or the sidecar log.
  env.NODE_NO_WARNINGS = env.NODE_NO_WARNINGS || "1";
  return env;
}

function spawnNode(scriptPath, args, extraEnv, options) {
  try {
    return spawn(nodeExecutable(), [scriptPath, ...(args || [])], {
      windowsHide: true,
      env: childEnv(extraEnv),
      ...options,
    });
  } catch {
    return null;
  }
}

export function spawnDetachedNode(scriptPath, args, extraEnv) {
  const child = spawnNode(scriptPath, args, extraEnv, {
    detached: true,
    stdio: "ignore",
  });
  try {
    child && child.unref();
  } catch { /* unref is best effort on already-exited children */ }
  return child;
}

export function spawnAttachedNode(scriptPath, args, extraEnv) {
  return spawnNode(scriptPath, args, extraEnv, {
    detached: false,
    stdio: "ignore",
  });
}

export function spawnNodePiped(scriptPath, args, extraEnv) {
  return spawnNode(scriptPath, args, extraEnv, {
    detached: false,
    stdio: ["pipe", "pipe", "ignore"],
  });
}

// A liveness probe, not a data timeout: a healthy sidecar answers /health in
// single-digit milliseconds, and a wedged one must not hold a hook open.
export async function sidecarAlive(port, timeoutMs = HTTP_TIMEOUT_MS) {
  if (!port) return false;
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal });
    return response.ok;
  } catch {
    return false;
  }
}

// Attach an error listener so a child that cannot start is visible instead of
// being reported as "running". Returns the child unchanged.
function onSpawnError(child, onError) {
  if (!child || !onError) return child;
  child.on("error", onError);
  return child;
}
