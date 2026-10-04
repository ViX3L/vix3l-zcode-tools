# The test harness

Everything here exists to run the **shipping** code and see what it does — not a
reimplementation of it, and not a mock in the shape of the thing being tested.

## Running it

Nothing needs to be installed locally. The whole suite runs in a container:

```sh
docker compose -f tests/docker/compose.yml run --rm tests
```

One tier, by passing a command (`node --test` takes a quoted glob; a bare
directory argument is rejected with `MODULE_NOT_FOUND`):

```sh
docker compose -f tests/docker/compose.yml run --rm tests \
  node --test --test-concurrency=1 "tests/unit/**/*.test.mjs"
```

The run uses the image's baked copy of the repository and `node_modules`, so it
writes nothing to your working tree and needs no host `node_modules`. To test an
edit, rebuild first: `run --rm --build tests`.

If you already have Node ≥ 22.5 and a Chromium for Playwright, the same suite
runs directly, via `package.json` scripts: `npm test`, `npm run test:unit`,
`test:integration`, `test:ui`, `test:e2e`.

## Tiers

| Directory | Subject | Depends on |
|---|---|---|
| `unit/` | Logic with no process boundary: metrics arithmetic, hook contracts, MCP framing, runtime path resolution, manifests, release tooling, workflow shape. | A fixture database; child processes for hooks and MCP. |
| `integration/` | The sidecar's HTTP surface, against the real server. | The real `sidecar/server.mjs` and a fixture database. |
| `ui/` | The rendered surfaces, in a real Chromium. | Playwright's Chromium, the real page scripts, a mock sidecar (pill/chips) or the real one (dashboard). |
| `e2e/` | The real injector processes against a real CDP endpoint. | Chromium launched with `--remote-debugging-port`, the real injectors. |

## The one rule: extract, never copy

The plugins' visible behaviour lives in large page scripts embedded as template
literals inside the injectors (`PILL_JS_TEMPLATE`, `PAGE_JS`, `CSS`). A test that
carried its own copy of those strings would keep passing after someone edited the
real script — the worst possible outcome for a suite whose subject is exactly
that rendering.

So `lib/extract.mjs` reads the injector source and slices those literals out with
a small JS-aware scanner (it understands quoted strings, template literals, and
line/block comments, so the CSS comments containing apostrophes do not derail
it). It performs the same substitutions the injector's own launch path performs
(`__SIDECAR_PORT__` → a test port, `__CARD_LAYOUT__` → `wide`/`compact`), and
evaluates the result the way the injector does — so escapes resolve identically.
What the browser then runs is what the plugin would inject, differing only in
those placeholders.

That is what makes an assertion like "the card sits above the pill" a
measurement of real geometry rather than an opinion about a fixture.

## The drivers (`lib/`)

| Module | What it is |
|---|---|
| `paths.mjs` | Every absolute path, so a moved or renamed file fails in one place with a clear message. |
| `fixtures.mjs` | A throwaway ZCode usage database in a temp dir, with the exact live table shapes. Every test points `ZCODE_USAGE_DB` and `HOME` at one, so a run never reads or writes the developer's real database, and every number is one the test chose. |
| `extract.mjs` | The page scripts and CSS, sliced from the injectors' source (see above). |
| `browser.mjs` | A real Chromium via Playwright, plus the fake composer and conversation DOM the scripts probe, and helpers that read text/boxes through shadow roots. |
| `mock-sidecar.mjs` | A controllable stand-in for the sidecar, for the UI tests: given a snapshot, does the pill render it? The real contract is covered separately in `integration/`. |
| `sidecar.mjs` | Launches the real sidecar against a fixture database, with a child-process reaper so a failing test cannot leak a process and stall the runner. |
| `cdp.mjs` | Launches a real Chromium with a debugging port and writes the fake app page under a path (`out/renderer/`) that the injectors' own target filter accepts. |

## Isolation

- **A fixture database, always.** `HOME`, `ZCODE_USAGE_DB` and the state file
  paths are redirected to a temp dir, so a run cannot disturb a running ZCode or
  see the developer's real figures.
- **No leaked processes.** Every spawned child is tracked and killed on exit, so
  a failure before a test's own cleanup cannot keep the event loop alive and hang
  the runner until its timeout.
- **No port collisions with the real thing.** Where a test must prove that the
  plugin finds *nothing* (the hook with no sidecar), it points at a freshly
  bound-and-released port rather than the default `7427`, so a developer's own
  running sidecar cannot make the test pass for the wrong reason.
