// Injector supervision for the sidecar.
//
// The injector is best-effort: if the app has no CDP port it exits and is
// retried on a long interval. A mode change takes effect on the next tick, not
// after a restart.
import path from "node:path";
import { spawnAttachedNode } from "../../scripts/lib/runtime.mjs";
import { readOptions } from "../../scripts/lib/options.mjs";
import { INJECTOR_RESTART_MS } from "../../scripts/lib/constants.mjs";

export function createInjectorSupervisor({ pluginRoot, port, log }) {
  let child = null;

  function spawn() {
    if (readOptions().mode === "skill") return; // pill deliberately off
    // spawnAttachedNode re-asserts ELECTRON_RUN_AS_NODE (this sidecar may itself
    // run under ZCode's embedded Node) and sets windowsHide, so the injector
    // never relaunches the GUI and never flashes a console on Windows.
    child = spawnAttachedNode(
      path.join(pluginRoot, "injector", "inject.mjs"),
      ["--sidecar-port", String(port)],
      { STATS_SIDECAR_PLUGIN_ROOT: pluginRoot }
    );
    if (!child) {
      log("could not spawn the injector");
      return;
    }
    child.on("error", (error) => log("injector error:", String(error.message || error)));
    child.on("exit", () => { child = null; });
  }

  const timer = setInterval(() => {
    const mode = readOptions().mode;
    if (mode === "skill") {
      if (child) {
        try { child.kill(); } catch {}
        child = null;
      }
      return;
    }
    if (!child) spawn();
  }, INJECTOR_RESTART_MS);
  timer.unref?.();

  return {
    start() { spawn(); },
    stop() {
      clearInterval(timer);
      if (child) {
        try { child.kill(); } catch {}
        child = null;
      }
    },
  };
}
