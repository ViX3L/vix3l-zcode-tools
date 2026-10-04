#!/usr/bin/env bash
# Package one plugin as a release asset: a zip, a tar.gz, and their checksums.
#
# The archive content is the plugin's own source tree (its directory under
# plugins/, with the plugin at the archive root), which is exactly what a user
# unpacks into their ZCode plugins directory or points a local marketplace at.
# No build step: the plugins are plain Node ESM with no dependencies, so the
# source tree IS the artifact.
#
# Usage: package-plugin.sh <plugin> <version>
# Writes: dist/<plugin>-<version>.zip, .tar.gz, .sha256
set -euo pipefail

plugin="${1:?usage: package-plugin.sh <plugin> <version>}"
version="${2:?usage: package-plugin.sh <plugin> <version>}"

root="$(cd "$(dirname "$0")/../.." && pwd)"
src="$root/plugins/$plugin"
[ -d "$src" ] || { echo "no such plugin directory: $src" >&2; exit 1; }

manifest="$src/.zcode-plugin/plugin.json"
[ -f "$manifest" ] || { echo "plugin has no .zcode-plugin/plugin.json: $src" >&2; exit 1; }

# The manifest version must equal the tag's, or the archive lies about itself.
manifest_version="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$manifest','utf8')).version)")"
if [ "$manifest_version" != "$version" ]; then
  echo "version mismatch: tag wants $version, $manifest says $manifest_version" >&2
  exit 1
fi

dist="$root/dist"
mkdir -p "$dist"
name="$plugin-$version"
zip_path="$dist/$name.zip"
tar_path="$dist/$name.tar.gz"
sha_path="$dist/$name.sha256"
rm -f "$zip_path" "$tar_path" "$sha_path"

# Archive from plugins/ so the top-level entry is the plugin directory, and
# exclude anything a checkout may carry that is not part of the plugin (a stray
# node_modules, editor backups, the OS's dotfiles).
( cd "$root/plugins" && zip -rq "$zip_path" "$plugin" \
    -x "*/node_modules/*" -x "*/.git/*" -x "*.DS_Store" -x "*~" )
( cd "$root/plugins" && tar --exclude="*/node_modules/*" --exclude="*/.git/*" \
    --exclude="*.DS_Store" --exclude="*~" -czf "$tar_path" "$plugin" )

# A single checksums file covering both archives, in `sha256sum -c` format so it
# verifies with the standard tool.
( cd "$dist" && sha256sum "$name.zip" "$name.tar.gz" > "$name.sha256" )

echo "packaged $plugin@$version:"
ls -l "$zip_path" "$tar_path" "$sha_path"
