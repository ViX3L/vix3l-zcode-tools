// The dashboard page, served from a file.
//
// It is static HTML with inline CSS/JS, so it lives as an asset rather than a
// 380-line template literal: the same rule that keeps the injected page
// scripts reviewable applies here.
import fs from "node:fs";

const HTML_URL = new URL("../page/dashboard.html", import.meta.url);
let cached;

export function dashboardHtml() {
  cached ??= fs.readFileSync(HTML_URL, "utf8");
  return cached;
}
