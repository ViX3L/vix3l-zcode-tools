// The environment a plugin child process should see under test.
//
// Every child is isolated from the developer's real ~/.zcode and usage DB, so
// a test can assert exact numbers and can never disturb a running app. `machine`
// is either a fixture's { dir, dbPath } or a plain HOME path.
import path from "node:path";

export function childEnv(machine, extra = {}) {
  const home = typeof machine === "string" ? machine : machine.dir;
  const dbPath = typeof machine === "string" ? path.join(home, "absent.sqlite") : machine.dbPath;
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    ZCODE_USAGE_DB: dbPath,
    TPS_MONITOR_STATE_FILE: path.join(home, "tps-monitor.last-session.json"),
    NODE_NO_WARNINGS: "1",
    ...extra,
  };
}
