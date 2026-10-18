// Exact-origin CORS policy.
//
// The composer pill runs inside app pages (file:// sends Origin: null) and the
// dashboard's own test pages are local, so those origins must be allowed. A
// public origin must not be. Prefix matching accepted http://localhost.evil.com
// — parse the URL and compare the exact hostname instead.
export function isLocalOrigin(origin) {
  if (!origin || origin === "null") return true;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol === "file:" || parsed.protocol === "chrome:") return true;
  return (
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost")
  );
}

// file:// pages send an opaque origin, which no web page can be served from,
// so they are answered with a wildcard. Every other allowed origin is echoed
// exactly and varied, which keeps caches honest.
export function allowOriginHeader(origin) {
  return origin && origin !== "null" ? origin : "*";
}

export function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": allowOriginHeader(origin),
    Vary: "Origin",
  };
}
