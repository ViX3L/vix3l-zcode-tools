// Condition-based waiting, so a test never depends on how fast the machine is.
//
// `fn` may be sync or async and returns a truthy value to stop. The last value
// or error is kept for the timeout message, because "condition never became
// true" on its own says nothing about what the page or process was showing.

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pollUntil(fn, { timeout = 8000, interval = 50, label = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  let lastError;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
      lastError = null;
    } catch (e) {
      lastError = e;
    }
    await delay(interval);
  }
  const detail = lastError
    ? `last error: ${lastError.message}`
    : `last value: ${JSON.stringify(last)?.slice(0, 300)}`;
  throw new Error(`timed out waiting for ${label}; ${detail}`);
}
