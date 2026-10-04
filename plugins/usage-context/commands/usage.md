---
description: Show the per-turn usage figures (tokens, run time) for the current session
---

Report the per-turn usage that the usage-context chips show in the composer. Steps:

1. Read the stats-composer sidecar port from `~/.zcode/stats-composer/port` (default 7427).
2. Query the per-turn endpoint for the current session:
   `curl -s "http://127.0.0.1:<port>/turn?session=${ZCODE_SESSION_ID}"`
3. Present the session totals (turns, steps, total tokens, cache hit %) and the most recent turns as a small table (time, tokens, run time, provider/model).
4. If the request fails, run `node "${ZCODE_PLUGIN_ROOT}/../stats-composer/scripts/doctor.mjs"` if that plugin is present, and otherwise explain that usage-context reads its data from the stats-composer sidecar, which must be installed and running.
