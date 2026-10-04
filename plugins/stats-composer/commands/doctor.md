---
description: Diagnose stats-composer health (DB schema, sidecar, CDP pill channel)
---

Run `node "${ZCODE_PLUGIN_ROOT}/scripts/doctor.mjs"` and present the check table as-is. If anything is BROKEN, give the fix: missing usage DB → send one message in ZCode first; node too old → ZCode bundles its own node, run commands via the app; if only sidecar/CDP are degraded, explain those channels are optional (composer pill needs the app relaunched once with `--remote-debugging-port=9229`).