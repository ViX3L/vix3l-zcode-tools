// One CDP sweep: find the app's renderer pages and evaluate the chips script.
import {
  evaluate,
  getJson,
  hasAppBridge,
  listPages,
  makeTimed,
  withTargetSession,
  wsClient,
} from "../../scripts/lib/cdp.mjs";

// Only the ZCode app's own renderer pages. Foreign pages (devtools, embedded
// browsers) never receive the script.
const APP_TARGET_RE = (url) =>
  /^file:\/\/.*app\.asar.*renderer\/index\.html/.test(url) ||
  /^file:\/\/.*index\.html/.test(url);

async function injectIntoTarget(timed, target, expression) {
  return withTargetSession(timed, target.id, async (sessionId) => {
    if (!(await hasAppBridge(timed, sessionId))) return false;
    await evaluate(timed, sessionId, expression, 20_000);
    return true;
  });
}

export async function sweepOnce({ cdpPort, expression, log }) {
  const version = await getJson(`http://127.0.0.1:${cdpPort}/json/version`);
  const browserWsUrl = version?.webSocketDebuggerUrl;
  if (!browserWsUrl) throw new Error("no browser websocket url");

  const targets = (await listPages(cdpPort)).filter((target) =>
    APP_TARGET_RE(target.url || "")
  );
  if (!targets.length) return "no app targets";

  const ws = await wsClient(browserWsUrl);
  const timed = makeTimed(ws);
  let mounted = 0;
  try {
    for (const target of targets) {
      try {
        if (await injectIntoTarget(timed, target, expression)) mounted++;
      } catch (error) {
        log("target failed:", String(error.message || error));
      }
    }
  } finally {
    try { ws.close(); } catch {}
  }
  return mounted ? `mounted on ${mounted} target(s)` : "no matching target";
}
