// A real CDP endpoint, backed by a real page.
//
// The injector is a CDP client: it reads /json/version and /json/list from the
// port, opens the browser websocket, attaches to each app page and evaluates
// the page script in it. Testing it against a hand-written fake would only
// prove my fake agrees with itself. So this launches a real Chromium with
// --remote-debugging-port and serves the fake composer/conversation DOM from a
// file:// URL whose path deliberately looks like the app's renderer path
// (/out/renderer/index.html), which is the shape the injector's own target
// filter requires. The renderer is also given a `window.zcode` bridge, which is
// the injector's runtime proof that a page is the app.
//
// What results is a genuine end-to-end path: inject.mjs process -> CDP over
// loopback -> real page -> the real page script -> the real sidecar. Every
// layer is the shipping code.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

let _exe;
async function chromiumExe() {
  if (!_exe) {
    const { chromium } = await import("playwright");
    _exe = chromium.executablePath();
  }
  return _exe;
}

export async function freePort() {
  const { createServer } = await import("node:net");
  return await new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

// Write a page under a path that matches the injector's app-renderer filter.
export function writeAppPage(dir, name, html) {
  const rendererDir = path.join(dir, "out", "renderer");
  fs.mkdirSync(rendererDir, { recursive: true });
  const file = path.join(rendererDir, name);
  fs.writeFileSync(file, html);
  return "file://" + file;
}

// Launch Chromium with a debugging port and open `url`. Returns a handle with
// the port, the child, and a close().
export async function launchCdpBrowser({ url, port, headless = true, extraArgs = [] } = {}) {
  const exe = await chromiumExe();
  const p = port || (await freePort());
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "zstats-chrome-"));
  const args = [
    `--remote-debugging-port=${p}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--no-sandbox",
    ...(headless ? ["--headless=new"] : []),
    ...extraArgs,
    url,
  ];
  const child = spawn(exe, args, { stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  child.stderr.on("data", (c) => (err += c.toString()));
  const deadline = Date.now() + 15_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/json/version`, { signal: AbortSignal.timeout(500) });
      if (r.ok) { ready = true; break; }
    } catch {}
    await new Promise((r) => setTimeout(r, 80));
  }
  if (!ready) throw new Error("chromium did not expose a CDP port: " + err.slice(-400));
  return {
    port: p,
    child,
    async targets() {
     	const r = await fetch(`http://127.0.0.1:${p}/json/list`);
      return await r.json();
    },
    async close() {
      try { child.kill("SIGKILL"); } catch {}
      await new Promise((r) => setTimeout(r, 150));
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
    },
  };
}

// Read a value out of the page through CDP, the way a test inspects results.
// `match` selects which page target to read; the default prefers a page under
// out/renderer (the app shape), because headless Chromium also exposes chrome://
// and extension pages and /json/list does not order them usefully — reading the
// wrong one would make a test assert against a blank document.
export async function evaluateInPage(port, expr, match) {
  // A tiny CDP client over the browser endpoint, attaching to the chosen page.
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const pages = list.filter((t) => t.type === "page");
  const prefer = match || ((u) => /\/out\/renderer\/[^/]*\.html/.test(u));
  const page = pages.find((t) => prefer(t.url || "")) || pages[0];
  if (!page) throw new Error("no page target");
  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  let id = 0;
  const send = (method, params, sessionId) =>
    new Promise((resolve, reject) => {
      const myId = ++id;
      const onMsg = (raw) => {
        let m;
        try { m = JSON.parse(raw.data); } catch { return; }
        if (m.id === myId) {
          ws.removeEventListener("message", onMsg);
          m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
        }
      };
      ws.addEventListener("message", onMsg);
      ws.send(JSON.stringify({ id: myId, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const att = await send("Target.attachToTarget", { targetId: page.id, flatten: true });
  const sid = att.sessionId;
  const res = await send(
    "Runtime.evaluate",
    { expression: expr, returnByValue: true, awaitPromise: true },
    sid
  );
  ws.close();
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || "evaluate failed");
  return res.result?.value;
}
