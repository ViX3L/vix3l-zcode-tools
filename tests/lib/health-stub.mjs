// A loopback HTTP responder standing in for a sidecar.
//
// The hooks only need "something answers /health" (or deliberately does not),
// so this stub keeps that setup in one place instead of five inline servers
// with slightly different content types and status rules.
import { createServer } from "node:http";
import { delay } from "./poll.mjs";

// `respond(req)` returns { status?, body?, headers?, json? }. The default
// answers 200 with "{}" for every path.
export async function startHttpStub({
  port = 0,
  delayMs = 0,
  respond = () => ({ status: 200, json: {} }),
} = {}) {
  if (delayMs) await delay(delayMs);
  const server = createServer((req, res) => {
    const reply = respond(req) || {};
    const body = reply.body ?? JSON.stringify(reply.json ?? {});
    res.writeHead(reply.status ?? 200, { "Content-Type": "application/json", ...(reply.headers || {}) });
    res.end(body);
  });
  let error;
  await new Promise((resolve) => {
    server.once("error", (e) => { error = e; resolve(); });
    server.listen(port, "127.0.0.1", resolve);
  });
  const actual = server.address()?.port ?? port;
  return {
    server,
    port: actual,
    base: `http://127.0.0.1:${actual}`,
    error,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
