# Changelog

All notable changes to **stats-composer** — *Session Statistics (TPS/TTFT)*.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the versions match the ones declared in `.zcode-plugin/plugin.json` and both
catalogues. The GitHub Release body for a version is taken from the matching
section here, so what a release announces is what this file records.

A released version is immutable in this repo: a change to the plugin's behavior
gets a **new** version, because an archive whose contents changed under an
unchanged version number would never reach anyone who had already installed it.

Entries for `0.1.0`–`0.1.3` are condensed from the project's own engineering
wiki (`wiki/log.md`), which is where the pre-git history of the plugin lives.

## [Unreleased]

## [0.1.18] - 2026-10-04

### Fixed

- **The pill no longer stays empty after a stale-port injector has run.** The
  sidecar port is now part of the injected script's generation identity. A
  generation left polling a stale or absent port (a manual or test injector
  started with a different `--sidecar-port`) can now be superseded by a correct
  one; previously the idempotence check answered `already`, the broken
  generation kept requesting the dead port, and the pill showed `—` until the
  page was reloaded by hand. The injected generation marker is now `40`.

## [0.1.17] - 2026-10-04

### Added

- **The hover card reports recent subagent activity** as its own block, shown
  only when there is any. Subagent model requests are written to their own
  session (`sess_subagent_agent_<uuid>`), never the parent conversation's, so
  they were invisible to the pill. They are reported as a time window
  ("subagents in the last 15 minutes", machine-wide, grouped by agent) rather
  than fabricated into a per-turn link — verified against the live database, a
  subagent row's `turn_id` never matches a parent `main_turn` `turn_id`.
  Kept strictly out of the session figures, because subagents spawn parallel
  streams and merging them would make the session average jump.

## [0.1.16] - 2026-10-04

### Fixed

- **The doctor's MCP handshake probe now runs through `runtime.mjs`.** It had
  called `node:child_process.spawn(process.execPath, …)` directly; under
  ZCode's embedded Node, `process.execPath` is the GUI app binary, so a bare
  spawn without `ELECTRON_RUN_AS_NODE=1` would launch a second copy of ZCode
  instead of the MCP server. Every child spawn in the plugin now goes through
  the one cross-platform runtime module.

### Documentation

- Cross-platform audit of the whole surface, answering "will this work on macOS,
  Linux and Windows?": the app's hook runner resolves `process` hooks as an argv
  vector (no shell quoting hazard), hooks use only `node:` builtins, and
  per-platform launchers ship. Recorded caveat: macOS/Windows paths follow the
  platform conventions but were verified on Linux only.

## [0.1.15] - 2026-10-04

### Fixed

- **The dashboard's model-mix donut no longer overlaps.** The centre labels had
  been absolutely positioned inside the ring; at a 138 px ring the caption
  measured 83.5 px against an 85 px hole, so it sat on the stroke. The figures
  now sit **below** the ring, so there is room at every size, and the panel's
  height matches the card block beside it exactly (0 px difference, measured).

### Changed

- Dashboard information design: the centre figure is now stateful (the session
  total for a single-model session, the leading model's share otherwise); the
  legend became a grid with the percentage promoted to a bolder column; the
  empty state is a plain track ring with one sentence, not the same thing twice.
- Page polish: emoji in the heading replaced with an inline SVG bolt, ~40 px hit
  areas, `:active` press feedback, `:focus-visible` rings, explicit
  transition properties, `cubic-bezier(0.16,1,0.3,1)` easing, and a
  `prefers-reduced-motion` block.

## [0.1.14] - 2026-10-04

### Added

- **Model-mix donut on the dashboard**, showing which models the session used
  and each one's share of generated tokens (output + reasoning), with a legend
  of token count, request count and percentage. Derived from rows the snapshot
  already scans, so it costs no extra query.
- **Dark/light theme switch** on the dashboard, saved to `localStorage` and
  restored before first paint so a light-theme reader never sees a dark flash.
  Dark stays the default, matching the app.
- **An unbounded, server-side-paginated request table.** `GET /requests?offset=
  &limit=&sort=&dir=` sorts and slices the whole session server-side, so
  browsing a long session no longer caps at 500 rows and depth no longer grows
  the payload. `page 1 of N` now counts the session's entire history.

### Fixed

- **The MCP server row no longer goes red with "connection timed out".** The
  root cause was the wire framing, not a path or timeout problem: ZCode's stdio
  client reads **newline-delimited JSON** and skips `SyntaxError`s, while the
  server wrote LSP-style `Content-Length` headers, so the `initialize` reply
  never parsed. `writeMessage` now writes `JSON.stringify(message) + "\n"`; the
  reader stays permissive so manual smoke tests still work.

## [0.1.13] - 2026-10-04

### Added

- **The session-statistics hover card's density is user-selectable** from the
  plugin settings: a roomier layout (the new default) or the earlier compact
  one, via the `wideCard` boolean. A running plugin cannot read `user_config`
  directly, so the injector reads the file the settings page writes
  (`~/.zcode/cli/config.json` → `plugins.options[…]`) on every sweep, so a
  change applies within one sweep without a restart.

### Documentation

- README and `docs/README.md` gained functional screenshots of each plugin
  captured from the running app, a Settings table, and the card-layout section.

## [0.1.12] - 2026-10-04

### Changed

- **Every card row now carries a graded bullet opacity** instead of one pale
  default, and the card is roomier overall: larger row rhythm, wider gutters and
  a wider minimum width. This deliberately diverges from the app's own context
  panel, which grades only headline vs secondary rows — the divergence is
  intentional and user-directed.

### Added

- **Plugin icons** (48×48 SVG) for both plugins, referenced from the catalogues
  by absolute `https://` URL, because the app's icon resolver rejects relative
  paths and `data:` URIs and falls back to a generic glyph.

## [0.1.11] - 2026-10-04

### Added

- **The hover card is now two columns**, joined by a thin transparent rule:
  rates and times on the left, turns/steps/tool-calls on the right, with a token
  usage block below (total, cache hit %, uncached input, cached input, output).
- The sidecar gained a **`/turn` endpoint** (`/turn?session=<sid>`, and
  `&msg=<id>` for a single turn), and the `/stats` snapshot now carries
  `snap.turns`.

### Fixed

- The session-statistics card's rate rows now span the full card width, with the
  time/turn block split by a vertical rule; labels no longer wrap inside the
  narrower columns.

## [0.1.10] - 2026-10-04

### Added

- **The pill follows the chat you are looking at.** It reads the app's
  `data-session-id` attribute on every poll and passes `?session=<id>`, so
  opening a different chat shows that chat's numbers immediately instead of the
  previous chat's until the next message. An unsent chat is stamped `draft`,
  which the pill treats as "no data yet" rather than inheriting the last chat.
- **The pill collapses to `⚡`** when the composer is narrow, so it can never
  collide with the model selector; the full numbers stay one hover away.
- **Dashboard pagination**: 10 rows per page with prev/next, the page counter,
  and arrow-key navigation; paging and sorting pause auto-refresh.

## [0.1.9] - 2026-10-04

### Added

- **Cross-platform support.** A new `scripts/lib/runtime.mjs` centralises every
  child spawn and re-asserts `ELECTRON_RUN_AS_NODE=1` (without it, a child spawn
  under ZCode's embedded Node relaunches the GUI), passes `windowsHide` on
  Windows, and resolves the app binary per platform. Per-platform launchers
  ship for Linux, macOS and Windows.
- **Resource guarantees made checkable**: `/health` publishes `refreshMsLast`,
  `refreshMsAvg`, `rssKb` and `demandAge`, so the lightweight claim can be
  verified on your own machine.
- Documentation under `docs/`: `metrics.md`, `architecture.md`,
  `resource-usage.md`, `security-audit.md`, `cross-platform.md`,
  `publishing-to-github.md`.

### Fixed

- **Two real resource defects found by auditing the live sidecar.** Dashboard
  extras re-ran forever after the dashboard had been opened once (fixed with a
  30 s idle cutoff: 80 ms → 4.2 ms warm); and the SQLite planner was choosing
  the single-column `query_source` index for session-scoped queries, reading
  ~24k rows globally instead of this session's ~1.5k (fixed by pinning
  `model_usage_session_turn_idx`: the per-request table went 33 → 1.8 ms).
- **Typography now follows ZCode's own settings.** The pill and card read the
  app's `--ui-font-size` / `--font-*` custom properties (which inherit through
  the shadow boundary) instead of hardcoding a size and stack, so the pill
  equals the app's own composer controls at every font-size setting and cannot
  drift from the app's scale under zoom.
- **The hover card is centred on the pill**, matching the app's own panel rule
  (centre on the trigger, 2 px gap), instead of left-aligned to it.

## [0.1.8] - 2026-10-04

### Added

- **Real tool time**, measured from ZCode's own `tool_usage` table, replacing a
  `session span − LLM time` estimate that reported nearly double the truth
  (174.3 min against a measured 91.3 min) because it also swallowed idle gaps.

### Changed

- The card now labels exactly which window each rate covers — "Latest request"
  (identical to the pill) versus "Last N" (the average) — resolving the
  confusion where the pill and the card legitimately showed different numbers
  from the same data.
- Bullet opacity is graded as in the app's own panel.

## [0.1.7] - 2026-10-04

### Changed

- **The hover card's surface now matches ZCode's own context panel
  field-for-field**, measured from the live app rather than eyeballed: neutral
  `#2b2b2b` surface, hairline border, 12 px radius and padding, monospace
  values, 60%-white labels, 8 px rounded-square blue bullets, and a top-bordered
  footer.

## [0.1.6] - 2026-10-04

### Fixed

- **The injector no longer hangs.** A page target's own `webSocketDebuggerUrl`
  admits one debugger client; the sidecar's long-lived injector held it, so a
  second client blocked forever. Attach now goes through the browser-level
  endpoint with `Target.attachToTarget {flatten:true}`, and every CDP call is
  time-boxed.
- **The pill no longer shows dashes or detaches.** The app strips composer nodes
  carrying an unknown `id`, so the host and marker are class-based with no id; a
  persistent host is re-appended by a `MutationObserver`.
- **Ownership is the document singleton** (`window.__tpsStats`, version + epoch)
  rather than a DOM expando, which React's reconciliation copies away.
- **The hover card opens above the pill** with every row populated, and
  superseded generations stand down and **exit** instead of idling forever
  (orphaned injectors used to accumulate).
- **Sidecar CPU dropped from ~20% of a core to ~2%** through a background
  refresher serving from memory, a single-scan snapshot, database-change
  detection to skip idle ticks, and lazy dashboard extras.

## [0.1.5] - 2026-10-04

### Added

- **The dashboard never reloads.** The `meta refresh` was removed; updates are
  keyed per-row DOM patches, so an idle session causes zero reflow. An
  auto-refresh toggle, a manual refresh button and an "updated HH:MM:SS" stamp
  were added; sorting pauses auto-refresh automatically.
- **The "Session statistics" hover card**, opened on hover over the pill, with
  LLM time / tool time / average TTFT / TPS and the session note. The pill and
  tooltip were renamed to "Session statistics".

## [0.1.4] - 2026-10-04

### Added

- **Sortable dashboard columns**: every column header toggles ascending or
  descending, and the choice survives the auto-refresh; the table defaults to
  newest-first. The `/stats` payload grew from 20 to 60 recent rows.

## [0.1.0] – [0.1.3] - 2026-10-03 → 2026-10-04

*Condensed from `wiki/log.md`; the pre-0.1.4 history was not recorded per
version.*

### Added

- The plugin's core: per-request TPS (tok/s) and TTFT read read-only from
  ZCode's own usage database, so every provider — builtin, account plans and
  custom endpoints — is measured identically.
- The inline composer pill, the local sidecar with a dashboard, the `tps`
  command and the CLI, and the MCP tools (`request_stats`, `history_stats`).
- The `--turn --current` scope fix: a resumed session chains one DB `turn_id`
  across prompt submissions, so the turn's rows are now scoped to requests
  started at or after the prompt instead of going silent.
