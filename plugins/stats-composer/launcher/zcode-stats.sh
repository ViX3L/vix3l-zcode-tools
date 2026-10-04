#!/bin/sh
# zcode-stats.sh — Linux entry point for "ZCode with stats".
#
# Starts ZCode with a local CDP (remote-debugging) port so the stats-composer
# composer pill can attach. Optional: the plugin works without it
# (assistant-attached stats line, or the sidecar + /dashboard).
#
# Node resolution ladder (the launcher itself is a Node script):
#   1. a normal `node` on PATH;
#   2. otherwise the Node embedded in ZCode, via ELECTRON_RUN_AS_NODE=1.
# This is why the launcher works on a machine with no system Node installed.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SCRIPT="$HERE/launch-with-stats.mjs"

if command -v node >/dev/null 2>&1; then
  exec node "$SCRIPT" "$@"
fi

for APP in /opt/ZCode/zcode /usr/lib/zcode/zcode /usr/bin/zcode "$HOME/.local/bin/zcode"; do
  if [ -x "$APP" ]; then
    ELECTRON_RUN_AS_NODE=1 exec "$APP" "$SCRIPT" "$@"
  fi
done

echo "[stats-composer] Neither 'node' nor ZCode itself was found." >&2
echo "  Install Node, or set ZCODE_APP_BINARY to your ZCode binary and retry." >&2
exit 1
