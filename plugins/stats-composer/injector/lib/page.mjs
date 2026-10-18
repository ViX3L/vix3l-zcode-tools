// Pill page assets, materialized for one generation.
//
// The layout and position settings are part of the script (and therefore of
// its VERSION), so changing either produces a different script that supersedes
// the running generation instead of being dismissed as 'already'.
import fs from "node:fs";

const CORE_URL = new URL("../page/pill-core.js", import.meta.url);
const SCRIPT_URL = new URL("../page/pill.js", import.meta.url);
const STYLE_URL = new URL("../page/pill.css", import.meta.url);

function pillStyle() {
  return fs.readFileSync(STYLE_URL, "utf8");
}

export function pillScript({ sidecarPort, layout, position }) {
  const css = JSON.stringify(pillStyle());
  return (
    `var __SC_CSS__ = ${css};\n` +
    fs.readFileSync(CORE_URL, "utf8") + "\n" +
    fs
      .readFileSync(SCRIPT_URL, "utf8")
      .replace(/__SIDECAR_PORT__/g, String(sidecarPort))
      .replace(/__CARD_LAYOUT__/g, layout)
      .replace(/__PILL_POSITION__/g, position)
  );
}
