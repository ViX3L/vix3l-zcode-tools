// GENERATED FROM shared/lib/paths.mjs — DO NOT EDIT.
// Edits belong in shared/lib/paths.mjs; run `node scripts/sync-shared.mjs`.

// Canonical on-disk locations.
//
// os.homedir() is read at call time, not import time, so a test that swaps HOME
// for an isolated machine cannot capture the real user's directories by
// accident.
import os from "node:os";
import path from "node:path";

function zcodeDir() {
  return path.join(os.homedir(), ".zcode");
}

export function appConfigFile() {
  return path.join(zcodeDir(), "cli", "config.json");
}

export function pluginStateDir(plugin) {
  return path.join(zcodeDir(), plugin);
}

export function pluginConfigFile(plugin) {
  return path.join(pluginStateDir(plugin), "config.json");
}

export function statsComposerDir() {
  return pluginStateDir("stats-composer");
}

export function statsComposerPortFile() {
  return path.join(statsComposerDir(), "port");
}

export function statsComposerPillFile() {
  return path.join(statsComposerDir(), "pill.json");
}

export function activeSessionFile() {
  return (
    process.env.TPS_MONITOR_STATE_FILE ||
    path.join(zcodeDir(), "tps-monitor.last-session.json")
  );
}
