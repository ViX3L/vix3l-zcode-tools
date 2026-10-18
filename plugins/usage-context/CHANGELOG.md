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

## [0.1.5] - 2026-10-18

### Changed

- **Chip settings now apply live.** The injector re-reads `showChips` and
  `showRanFor` on each sweep. Turning the chips off removes them within one
  interval, and turning them back on remounts them, without a re-install or an
  app restart.
- **The unused `port` option was removed** from the plugin manifest. It had no
  reader — the plugin binds no port, because it reads stats-composer's sidecar —
  so a user could set a value that did nothing. `sidecarPort` remains the one
  port setting.
- Internals only: the injector's sweep and socket handling are split into
  named helpers shared with the test harness. Behaviour is unchanged.

## [0.1.4] - 2026-10-18

### Fixed

- **The chips now come up when ZCode resumes a chat.** The SessionStart matcher
  was `startup|clear`; a restored chat reports `resume`, so the hook never ran
  and the injector was never started.
- **The hook no longer loses the startup race.** stats-composer spawns the
  shared sidecar without waiting, so a single probe could conclude the sidecar
  was absent while it was still binding. The hook now polls for up to 2 s and
  re-reads the port file on each attempt.

## [0.1.3] - 2026-10-17

### Fixed

- **The chips no longer blink out and come back.** A generation that took the
  page over deleted every chip and rebuilt it, so the chips blanked until the
  new generation's first fetch landed; and an injector whose sidecar port was
  dead would still take the page, leaving `—` chips behind while it polled a
  port nothing answers on. Measured live on this machine: ten injector
  processes left behind by earlier runs of the hook unit test — each with its
  own baked-in sidecar port — traded the page with the real injector every
  ~10 s, and the chips went `3 → 0 → 3` on every trade. Two fixes, because
  there were two faults: an injector whose own sidecar is not answering now
  stands down instead of claiming the page, and a takeover now ADOPTS the
  existing chips (keeping the figures already on screen) instead of deleting
  them. Injected generation marker is now `10`.
- **A chip survives a footer the app is re-rendering.** The chip was dropped
  whenever one DOM snapshot could not find its turn's timestamp row — which the
  app drops for a frame while streaming — and rebuilt on the next 2 s poll, a
  blink of its own. A chip now goes only when the turn itself leaves the DOM.
- **The hook's unit test no longer leaks a live injector.** Running the
  session-start hook with a reachable sidecar starts a real, detached injector —
  that is the behaviour under test — and `detached` means it outlives the test.
  The ten orphans above were exactly that. The test now reaps the process it
  caused, and the malformed-stdin case pins a closed port so it neither depends
  on nor disturbs whatever the developer is running.

### Changed

- The sidecar-liveness probe is defined once, in `scripts/lib/runtime.mjs`, and
  used by this plugin's hook and injector and by stats-composer's two hooks
  (three copies of it had drifted apart, differing only in their timeout).

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
