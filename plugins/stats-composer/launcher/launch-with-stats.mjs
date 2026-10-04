#!/usr/bin/env node
// launch-with-stats.mjs — start ZCode with a local CDP (remote-debugging) port
// so the stats-composer composer pill can attach.
//
// This is OPTIONAL. The plugin works without it (assistant-attached stats line,
// or the sidecar + /dashboard). Only the inline composer pill needs the app to
// expose a debugging port, and packaged ZCode installs do not open one by
// default. This launcher opens it for you.
//
// One implementation for Linux, macOS and Windows: it locates the app binary
// through scripts/lib/runtime.mjs (env-derived app root, then the conventional
// install locations per platform) and passes the port through. Nothing here is
// shell-specific, so it behaves identically on all three platforms.
//
// Usage:
//   node launcher/launch-with-stats.mjs [--port 9229] [-- <extra ZCode args>]
//
// The per-platform wrappers in this directory just call this script:
//   Linux   : zcode-stats.desktop
//   macOS   : ZCode with Stats.command
//   Windows : ZCode with Stats.cmd

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { candidateAppBinaries, appRootFromEnv, appBinaryFor } from "../scripts/lib/runtime.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function argOf(name, dflt) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : dflt;
}
const PORT = argOf("--port", "9229");
// Everything after "--" is forwarded to ZCode untouched, so a deep link or a
// file argument still works.
const sep = args.indexOf("--");
const extra = sep >= 0 ? args.slice(sep + 1) : [];

// Prefer an explicit override, then the env-derived install, then the
// conventional locations. ZCODE_APP_BINARY lets a user point at a portable or
// relocated install.
function resolveBinary() {
  const explicit = process.env.ZCODE_APP_BINARY;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const derived = appBinaryFor(appRootFromEnv());
  if (derived && fs.existsSync(derived)) return derived;
  for (const c of candidateAppBinaries()) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

const binary = resolveBinary();
if (!binary) {
  console.error(
    "[stats-composer] Could not find the ZCode application binary.\n" +
      "  Set ZCODE_APP_BINARY to its full path and run this again, e.g.\n" +
      "    Linux/macOS : ZCODE_APP_BINARY=/path/to/zcode node launcher/launch-with-stats.mjs\n" +
      "    Windows     : set ZCODE_APP_BINARY=C:\\path\\to\\ZCode.exe && node launcher\\launch-with-stats.mjs"
  );
  process.exit(1);
}

console.log(`[stats-composer] launching ${binary} with --remote-debugging-port=${PORT}`);
const flag = `--remote-debugging-port=${PORT}`;
const child = spawn(binary, [flag, ...extra], {
  stdio: "inherit",
  // The app is a GUI process: do not let this wrapper's lifetime define its
  // own, and do not open a console window for it on Windows.
  detached: process.platform !== "win32",
  windowsHide: true,
});
child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (e) => {
  console.error(`[stats-composer] failed to launch: ${e.message}`);
  process.exit(1);
});
