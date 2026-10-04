---
description: Show per-request TPS and TTFT stats now (optionally watch live for N seconds)
---

Run the stats CLI and show the result. Steps:

1. Run `node "${ZCODE_PLUGIN_ROOT}/scripts/stats.mjs" $ARGUMENTS` (argument may be a number of seconds to watch, e.g. `10` → pass `--watch 10`).
2. Present the output verbatim in a fenced code block, then one short sentence interpreting it (name the model; comment only if TTFT > 5 s or the rate is far off the session average).
3. If the output is empty, run `node "${ZCODE_PLUGIN_ROOT}/scripts/doctor.mjs"` and report the failing check instead of guessing numbers.