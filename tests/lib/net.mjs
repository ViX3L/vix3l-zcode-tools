// One way to obtain a free loopback port.
//
// A port is claimed by binding and releasing it. The gap between release and
// the real listener is unavoidable on POSIX, so callers treat a collision as a
// loud failure rather than trying to make reservation airtight.
import { createServer } from "node:net";

export async function ephemeralPort() {
  return await new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}
