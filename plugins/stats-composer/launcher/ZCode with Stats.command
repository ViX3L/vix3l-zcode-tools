#!/bin/bash
# ZCode with Stats (macOS)
#
# Double-clickable launcher: starts ZCode with a local CDP (remote-debugging)
# port so the stats-composer composer pill can attach. Optional — the plugin
# works without it (assistant-attached stats line, or the sidecar + /dashboard).
#
# How it finds Node: a normal `node` on PATH first; if there is none (common on
# a plain desktop install), it falls back to the Node that ZCode itself embeds,
# by running the app binary with ELECTRON_RUN_AS_NODE=1.

set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/launch-with-stats.mjs"

if command -v node >/dev/null 2>&1; then
  exec node "$SCRIPT" "$@"
fi

# Fall back to ZCode's embedded Node runtime.
for APP in \
  "/Applications/ZCode.app/Contents/MacOS/ZCode" \
  "$HOME/Applications/ZCode.app/Contents/MacOS/ZCode"
do
  if [ -x "$APP" ]; then
    export ELECTRON_RUN_AS_NODE=1
    exec "$APP" "$SCRIPT" "$@"
  fi
done

echo "[stats-composer] Neither 'node' nor ZCode itself was found." >&2
echo "  Install Node, or set ZCODE_APP_BINARY to your ZCode binary and retry." >&2
exit 1
