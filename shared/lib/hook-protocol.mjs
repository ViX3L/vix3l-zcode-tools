// The ZCode hook protocol, in one module.
//
// A hook's stdout IS the protocol: it must contain one JSON envelope and
// nothing else. A hook that throws before writing its envelope is silently
// dropped by the host, so callers write in a finally block and use
// writeEnvelope, which exits only after the write is on its way.
import { STDIN_TIMEOUT_MS } from "./constants.mjs";

export function readStdin(timeoutMs = STDIN_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let raw = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(raw);
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (raw += chunk));
    process.stdin.on("end", finish);
    setTimeout(finish, timeoutMs);
  });
}

export function sessionIdFrom(payload, env = process.env) {
  return (
    payload?.session_id ||
    env.ZCODE_SESSION_ID ||
    env.CLAUDE_SESSION_ID ||
    ""
  );
}

export function envelope(eventName, additionalContext) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: additionalContext ?? "",
    },
  });
}

// process.exit() does not flush a pending stdout write. On Linux the pipe
// buffer absorbs a small payload, but a smaller buffer would truncate the JSON
// and the host would reject the hook, so wait for drain when needed.
export function writeAndExit(payload) {
  if (process.stdout.write(payload)) {
    process.exit(0);
    return;
  }
  process.stdout.once("drain", () => process.exit(0));
}

export function writeEnvelope(eventName, additionalContext) {
  writeAndExit(envelope(eventName, additionalContext));
}
