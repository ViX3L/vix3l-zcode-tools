# Repository metadata

The GitHub sidebar (**About**) fields, kept here so they are reviewable in
version control rather than only in the web UI. Paste each value into the
matching field under the repository's **About** panel (the gear icon).

## Description

> Local performance and usage stats for ZCode Desktop: per-request TPS/TTFT in
> the composer, per-turn token chips beside each reply, and a self-hosted
> dashboard — read straight from ZCode's own usage database, on your machine.

A shorter alternative if the 350-character field feels crowded:

> Per-request TPS/TTFT and per-turn token usage for ZCode Desktop, read locally
> from ZCode's own usage database. No telemetry, no network egress.

(The GitHub description field allows 350 characters; both fit.)

## Website

Leave **empty**, or point it at the marketplace catalog file, which is what a
user actually pastes into ZCode:

```
https://github.com/ViX3L/vix3l-zcode-tools
```

There is no separate project site. Setting the website to the repository URL is
the least surprising choice, since the install instructions begin there.

## Topics

Add each of these under **Topics** (lowercase, hyphenated):

```
zcode
zcode-plugin
zcode-desktop
plugin-marketplace
tokens-per-second
tps
ttft
token-usage
observability
developer-tools
local-first
privacy
nodejs
```

`zcode`, `zcode-plugin` and `plugin-marketplace` are the ones that make the repo
discoverable to someone already using ZCode; `tps`, `ttft`, `token-usage` and
`observability` describe what it measures; `local-first` and `privacy` state the
one guarantee that distinguishes it.

## Releases

Releases are produced by `.github/workflows/release.yml`, triggered by a version
tag. Two tag shapes are supported:

| Tag | Releases |
|---|---|
| `v0.1.17` | every plugin, each at its current manifest version |
| `stats-composer-v0.1.17` | only `stats-composer` |
| `usage-context-v0.1.2` | only `usage-context` |

The tag's version must equal the version in the plugin's
`.zcode-plugin/plugin.json`, and the three places a version is declared (the
plugin manifest, the root `marketplace.json`, and `plugins/marketplace.json`)
must agree — the CI suite enforces the latter. Each Release carries the plugin's
own source tree as a `.zip` and a `.tar.gz`, plus a `.sha256` checksums file.

To cut a release: bump the version in all three declarations, commit, then push
the tag. For example, for `stats-composer`:

```sh
# edit plugins/stats-composer/.zcode-plugin/plugin.json,
#      marketplace.json, plugins/marketplace.json  → 0.1.17
git add -A && git commit -m "release: stats-composer 0.1.17"
git push
git tag stats-composer-v0.1.17
git push origin stats-composer-v0.1.17
```

The workflow runs the full test suite first, so a tag cannot publish a build
that fails its own tests.
