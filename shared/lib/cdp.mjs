// Minimal CDP transport shared by both injectors.
//
// A page's own webSocketDebuggerUrl admits exactly one debugger client, so two
// plugins talking to page sockets would block each other. The BROWSER endpoint
// multiplexes many flattened sessions over one connection, which is what lets
// these plugins coexist with each other and with the app's own devtools.
import {
  CDP_ATTACH_TIMEOUT_MS,
  CDP_DETACH_TIMEOUT_MS,
  CDP_INJECT_TIMEOUT_MS,
  CDP_PROBE_TIMEOUT_MS,
  HTTP_TIMEOUT_MS,
  WS_OPEN_TIMEOUT_MS,
} from "./constants.mjs";

let WS_IMPL;
export async function wsClient(url, timeoutMs = WS_OPEN_TIMEOUT_MS) {
  if (!WS_IMPL) {
    try {
      WS_IMPL = (await import("ws")).WebSocket;
    } catch {
      WS_IMPL = globalThis.WebSocket; // Node >= 22 ships a stable WebSocket
    }
  }
  if (!WS_IMPL) throw new Error("no WebSocket implementation available");
  const ws = new WS_IMPL(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ws open timeout")), timeoutMs);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("ws error")); }, { once: true });
  });
  return ws;
}

export async function getJson(url, timeoutMs = HTTP_TIMEOUT_MS) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${url} -> ${response.status}`);
  return response.json();
}

export async function listPages(port) {
  const list = await getJson(`http://127.0.0.1:${port}/json/list`);
  return (Array.isArray(list) ? list : []).filter((target) => target.type === "page");
}

function wsSend(ws, method, params, msgId, sessionId) {
  return new Promise((resolve, reject) => {
    const onMessage = (raw) => {
      let message;
      try { message = JSON.parse(raw.data); } catch { return; }
      if (message.id !== msgId) return;
      ws.removeEventListener("message", onMessage);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify(sessionId ? { id: msgId, method, params, sessionId } : { id: msgId, method, params }));
  });
}

// Every command is time-boxed, and the timer is cleared as soon as it settles:
// a leaked timer would hold the event loop open for the whole budget.
export function makeTimed(ws) {
  let id = 0;
  return (method, params, sessionId, budgetMs = 4000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`cdp timeout: ${method}`)), budgetMs);
      wsSend(ws, method, params, ++id, sessionId).then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); }
      );
    });
}

export async function withTargetSession(timed, targetId, fn) {
  const attach = await timed(
    "Target.attachToTarget",
    { targetId, flatten: true },
    null,
    CDP_ATTACH_TIMEOUT_MS
  );
  const sessionId = attach?.sessionId;
  if (!sessionId) throw new Error("attach returned no sessionId");
  try {
    return await fn(sessionId);
  } finally {
    try {
      await timed("Target.detachFromTarget", { sessionId }, null, CDP_DETACH_TIMEOUT_MS);
    } catch { /* detach is best effort after the work is done */ }
  }
}

export async function evaluate(timed, sessionId, expression, budgetMs = CDP_INJECT_TIMEOUT_MS) {
  const result = await timed(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
    budgetMs
  );
  if (result?.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.text ||
      result.exceptionDetails.exception?.description ||
      "evaluate failed"
    );
  }
  return result;
}

// The app's preload exposes window.zcode; foreign pages (devtools, embedded
// browsers) do not. Guarding on it keeps both injectors off pages they cannot
// help.
function bridgeProbeExpression() {
  return `(() => { try { return JSON.stringify({ bridge: typeof window.zcode === 'object' && window.zcode !== null }); } catch { return JSON.stringify({ bridge: false }); } })()`;
}

export async function hasAppBridge(timed, sessionId) {
  const probe = await evaluate(timed, sessionId, bridgeProbeExpression(), CDP_PROBE_TIMEOUT_MS);
  try {
    return !!JSON.parse(probe?.result?.value ?? probe?.value ?? "{}").bridge;
  } catch {
    return false;
  }
}
