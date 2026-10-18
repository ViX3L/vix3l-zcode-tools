// One CDP sweep: find the app's renderer pages and inject the pill script.
import {
  evaluate,
  getJson,
  hasAppBridge,
  listPages,
  makeTimed,
  withTargetSession,
  wsClient,
} from "../../scripts/lib/cdp.mjs";

// Only the ZCode app's own renderer windows. The app loads its UI via
// loadFile(.../out/renderer/<page>.html) when packaged (file://) or
// ELECTRON_RENDERER_URL when run from source. Never inject into a foreign
// Chromium that happens to expose a CDP port — such a pill renders nowhere.
const APP_TARGET_RE = (url) => {
  if (!url) return false;
  if (/^file:/.test(url)) {
    return /\/out\/renderer\/[^/]*\.html(\?|$)/.test(url) ||
      /\.zcode\//.test(url) ||
      /\/ZCode\//.test(url);
  }
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(url)) {
    return /\/(index|login)\.html(\?|$)/.test(url) ||
      url.replace(/^https?:\/\/[^/]+/, "").replace(/\/$/, "") === "";
  }
  return false;
};

// Electron's /json/version reports a plain Chromium identity, so the product
// name cannot identify the app. The real app always serves its UI from a page
// target under its install dir; a foreign browser has no such target, and the
// preload-bridge probe below is the final proof.
function isAppCdp(targets) {
  return targets.some((target) => APP_TARGET_RE(target.url || ""));
}

async function injectIntoTarget(timed, target, script) {
  return withTargetSession(timed, target.id, async (sessionId) => {
    if (!(await hasAppBridge(timed, sessionId))) return false;
    await evaluate(timed, sessionId, script, 30_000);
    return true; // "already" still counts: the pill is present
  });
}

function unavailable(log, writeAttachState, message) {
  log(message);
  writeAttachState(false, "no-app-cdp");
  return { attached: false, reason: "no-app-cdp" };
}

// The app's renderer targets, or null when this CDP port is not the app.
async function discoverTargets(cdpPort, log, writeAttachState) {
  let pages;
  try {
    pages = await listPages(cdpPort);
  } catch {
    return { error: unavailable(log, writeAttachState, `CDP not reachable on ${cdpPort} — composer pill unavailable (fallback channels stay active)`) };
  }
  if (!isAppCdp(pages)) {
    return { error: unavailable(log, writeAttachState, `no ZCode app renderer on :${cdpPort} — pill channel off (this port belongs to another browser or the app has no debugging port; fallback channels stay active)`) };
  }
  let targets = pages.filter((target) => APP_TARGET_RE(target.url || ""));
  if (!targets.length) {
    // App CDP is up but no page URL matched the known shapes: fail open across
    // app updates, but log what was seen.
    log("app CDP up; no page URL matched known renderer shapes — attaching to app pages generically");
    targets = pages;
  }
  if (!targets.length) return { error: unavailable(log, writeAttachState, "no page targets; is the app running with --remote-debugging-port?") };
  return { targets };
}

async function openTimedSocket(cdpPort, log, writeAttachState) {
  let browserWsUrl;
  try {
    browserWsUrl = (await getJson(`http://127.0.0.1:${cdpPort}/json/version`))?.webSocketDebuggerUrl;
  } catch { /* no CDP: reported below as an unavailable channel */ }
  if (!browserWsUrl) return { error: unavailable(log, writeAttachState, "CDP has no browser endpoint; pill unavailable") };
  try {
    const ws = await wsClient(browserWsUrl);
    return { ws, timed: makeTimed(ws) };
  } catch (error) {
    return { error: unavailable(log, writeAttachState, `could not open browser CDP socket: ${String(error.message || error)}`) };
  }
}

async function injectIntoAll(targets, timed, script, log) {
  let okCount = 0;
  for (const target of targets) {
    try {
      if (await injectIntoTarget(timed, target, script)) okCount++;
    } catch (error) {
      log("inject failed:", (target.url || "").slice(0, 60), String(error.message || error));
    }
  }
  return okCount;
}

export async function runSweep({ cdpPort, script, log, writeAttachState }) {
  const found = await discoverTargets(cdpPort, log, writeAttachState);
  if (found.error) return found.error;
  const socket = await openTimedSocket(cdpPort, log, writeAttachState);
  if (socket.error) return socket.error;

  let okCount = 0;
  try {
    okCount = await injectIntoAll(found.targets, socket.timed, script, log);
  } finally {
    try { socket.ws.close(); } catch { /* socket teardown is best effort */ }
  }
  log(`injected into ${okCount}/${found.targets.length} target(s)`);
  const attached = okCount > 0;
  writeAttachState(attached, attached ? "attached" : "inject-failed");
  return { attached, reason: attached ? "attached" : "inject-failed" };
}
