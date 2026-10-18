// Running a tool that is EXPECTED to fail.
//
// Returns the failure text, or null when the tool exited 0. Keeping this in one
// place means every "must fail loudly" test asserts the same thing: a non-zero
// exit with a message, never silence.
import { execFileSync } from "node:child_process";
import { REPO_ROOT } from "./paths.mjs";

export function execFailure(script, args = [], opts = {}) {
  try {
    execFileSync(process.execPath, [script, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: "pipe",
      ...opts,
    });
    return null;
  } catch (e) {
    return String(e.stderr || e.stdout || e.message);
  }
}
