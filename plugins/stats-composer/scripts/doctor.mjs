#!/usr/bin/env node
// doctor.mjs — health checks for stats-composer: node version, usage DB and
// schema, state file, sidecar health, CDP availability (for the composer
// pill), config sanity. Exit 0 = healthy; 1 = degraded; 2 = broken.
import { runDoctor } from "./lib/doctor.mjs";

const wantJson = process.argv.includes("--json");
const results = await runDoctor();
const OPTIONAL = ["sidecar", "cdp", "pill", "platform"];
const failed = results.filter((r) => !r.ok);
const degraded = results.filter((r) => !r.ok && OPTIONAL.includes(r.name));

if (wantJson) {
  console.log(JSON.stringify({ ok: failed.length === 0, results }, null, 2));
} else {
  console.log("stats-composer doctor");
  console.log("=".repeat(50));
  for (const r of results) {
    console.log(`${r.ok ? "✓" : "✗"} ${r.name.padEnd(12)} ${r.detail}`);
  }
  console.log("=".repeat(50));
  const required = failed.filter((r) => !OPTIONAL.includes(r.name));
  if (required.length) {
    console.log(`BROKEN: ${required.map((r) => r.name).join(", ")}`);
    process.exitCode = 2;
  } else if (degraded.length) {
    console.log(`DEGRADED (optional channels): ${degraded.map((r) => r.name).join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log("HEALTHY");
  }
}
