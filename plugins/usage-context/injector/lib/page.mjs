// Page assets, materialized for one generation.
//
// The page script and stylesheet are files, not template strings, so tests can
// read exactly what ships and the host module stays small. Only the numeric
// sidecar port and the two display switches are substituted.
import fs from "node:fs";

const SCRIPT_URL = new URL("../page/chips.js", import.meta.url);
const STYLE_URL = new URL("../page/chips.css", import.meta.url);

export function chipsStyle() {
  return fs.readFileSync(STYLE_URL, "utf8");
}

export function chipsScript({ sidecarPort, showChips, showRanFor }) {
  return fs
    .readFileSync(SCRIPT_URL, "utf8")
    .replace(/__SIDECAR_PORT__/g, String(sidecarPort))
    .replace(/__SHOW_CHIPS__/g, showChips ? "true" : "false")
    .replace(/__SHOW_RANFOR__/g, showRanFor ? "true" : "false");
}

// The style element is created at most once. The previous implementation
// appended a fresh <style> on every 10-second sweep, so a long-lived page
// accumulated hundreds of copies.
export function styleBootstrap(css) {
  return (
    "if(!document.getElementById('usage-context-style')){" +
    "var __ucStyle=document.createElement('style');" +
    "__ucStyle.id='usage-context-style';" +
    "__ucStyle.textContent=" + JSON.stringify(css) + ";" +
    "(document.head||document.documentElement).appendChild(__ucStyle);" +
    "}"
  );
}
