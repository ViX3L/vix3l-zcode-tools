# Changelog

All notable changes to **usage-context** — *Turn Usage Context*.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the versions match the ones declared in `.zcode-plugin/plugin.json` and both
catalogues. The GitHub Release body for a version is taken from the matching
section here, so what a release announces is what this file records.

A released version is immutable in this repo: a change to the plugin's behavior
gets a **new** version, because an archive whose contents changed under an
unchanged version number would never reach anyone who had already installed it.

Entries for `0.1.0` are condensed from the project's own engineering wiki
(`wiki/log.md`), which is where the pre-git history of the plugin lives.

## [Unreleased]

## [0.1.2] - 2026-10-04

### Fixed

- **The chips no longer stay at `—` after a stale-port injector has run.** The
  sidecar port is now part of the injected script's generation identity. A
  generation left polling a stale or absent port (a manual or test injector
  started with a different `--sidecar-port`) can now be superseded by a correct
  one; previously the idempotence check answered `already`, so the broken
  generation kept requesting the dead port and every chip rendered its empty
  state until the page was reloaded by hand. The injected generation marker is
  now `9`.

## [0.1.1] - 2026-10-04

### Fixed

- **The "Turn time and speed" panel no longer prints its duration twice.** In a
  two-line panel the header repeated the figure its only row already carried;
  the header now renders the title alone, and the total stays in the header of
  the "Turn usage" panel, where it is the only place it appears.

## [0.1.0] - 2026-10-04

*Condensed from `wiki/log.md`.*

### Added

- **Per-turn usage chips** beside each assistant turn's timestamp: `Usage N tok`
  and `Ran for Ns`, separated by a hairline rule, with a hover panel for each —
  **Turn usage** (total, provider/model, uncached input, output) on the token
  chip and **Turn time and speed** (total run time) on the clock chip.
- The plugin follows the marketplace's reuse rule literally: it **owns no server
  and opens no database** — it reads per-turn figures from stats-composer's
  `/turn` endpoint, so enabling it adds only a second injector process (a small
  CDP client), no port bind and no second database reader. The honest cost is a
  dependency on stats-composer; the session-start hook says so once instead of
  failing silently.
- The join that makes the chips renderable was discovered and recorded:
  `data-turn-id` on each assistant turn equals `turn_usage.user_message_id`.

### Fixed

- The chip value text (`Usage 26.14M tok`, `Ran for 18m 12s`) rendered `—` for
  every turn because `PAGE_JS` embedded the literal `__SIDECAR_PORT__` and never
  substituted it, so every in-page fetch threw; the stylesheet had landed and
  the chips were correctly placed, which is why it looked like a data problem.
- The hover panel had no stylesheet, so it rendered with zero width and no
  surface; the full card stylesheet was added, and a long provider/model value
  that squeezed its label into a two-line overlap was fixed to wrap.
- Values that painted outside the card were fixed: the card now grows to its
  content (`width: max-content`) with a viewport guard, and the value cell wraps
  explicitly, because it inherited `white-space: nowrap` from the app, which
  made `overflow-wrap` inert.
