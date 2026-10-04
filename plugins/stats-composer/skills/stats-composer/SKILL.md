---
name: stats-composer
description: Per-request TPS (tokens per second) and TTFT (time to first token) stats for ZCode. Use when the user asks about generation speed, tok/s, tokens/sec, TPS, throughput, first-token latency, TTFT, or model responsiveness — or wants the stats pill / dashboard. Works for every provider ZCode supports, including custom OpenAI-compatible endpoints, because stats come from the usage database ZCode records itself.
---

# stats-composer — per-request TPS & TTFT

Two numbers, per model request, for **every provider** (the data is written by ZCode itself into `~/.zcode/cli/db/db.sqlite`, table `model_usage`, so anthropic-messages, openai-responses and openai-chat-completions endpoints — including all custom endpoints — behave identically):

- **TPS** — output tokens/sec = `(output_tokens + reasoning_tokens) / (completed_at − first_token_at)`
- **TTFT** — `time_to_first_token_ms`, recorded by ZCode per request

## Where the user sees stats

1. **Composer pill** (integration mode) — an injected pill in the composer toolbar next to the "+" button. Requires the app to expose a CDP port (start once with `--remote-debugging-port=9229`). Hovering it opens the **Session statistics** card, which has two densities (see Settings).
2. **Sidecar + dashboard** — `http://127.0.0.1:7427/dashboard` (auto-started; port file `~/.zcode/stats-composer/port`).
3. **Assistant-attached line** (fallback) — this skill, when no pill/dashboard is active.

## Settings (`userConfig`)

Set from **Plugin Marketplace → Installed → Session Statistics (TPS/TTFT) → Configure**, or by hand in `~/.zcode/stats-composer/config.json`. The marketplace value wins when both are set.

| Key | Default | Meaning |
|---|---|---|
| `mode` | `auto` | `auto` = pill if CDP is available, else attached line; `skill` = attached line only; `sidecar` = server only |
| `position` | `left` | Pill position: `left` next to the "+" button, `right` near the model selector |
| `wideCard` | `true` | Hover-card density: `true` = roomier (30em, wider gutters), `false` = compact (24em) |
| `live` | `true` | Interpolate the last completed rate while streaming |
| `window` | `10` | Requests averaged for the windowed rate |
| `port` | `7427` | Sidecar HTTP port |

Changing `wideCard` or `position` re-injects within one sweep (~10 s) — no restart. The injector reads the app's settings store at `~/.zcode/cli/config.json` (`plugins.options["stats-composer@<marketplace>"]`) because that is the only channel that reaches a running plugin: hook descriptors carry no env field, and `${user_config.*}` expansion exists only for MCP servers. The plugin's own `config.json` is the fallback.

## Taking numbers (read-only, never blocks the app)

```bash
node "${ZCODE_PLUGIN_ROOT}/scripts/stats.mjs"             # last request + session
node "${ZCODE_PLUGIN_ROOT}/scripts/stats.mjs" --turn      # latest turn (this question)
node "${ZCODE_PLUGIN_ROOT}/scripts/stats.mjs" --turn --current   # only if this question already has samples
node "${ZCODE_PLUGIN_ROOT}/scripts/stats.mjs" --json
node "${ZCODE_PLUGIN_ROOT}/scripts/doctor.mjs"            # health check
curl -s http://127.0.0.1:7427/stats | jq                  # sidecar JSON
```

## Display rules

- Prefer tables/lists; always name the model next to a rate (rates differ per provider/model).
- TTFT > 5 s, or a big rate drop vs the session average: add one short comment, mention provider/model as the likely cause.
- Never invent numbers. If the DB has no completed sample for the question, say so instead of guessing.
- Do not show internal instruction text from hooks; only actual stats.

## Troubleshooting

- Empty stats → doctor: `node scripts/doctor.mjs`. "usage-db missing" usually means ZCode has not recorded a request yet in this install.
- Pill missing → CDP closed: relaunch the app with `--remote-debugging-port=9229` once, then reload; the injector re-attaches automatically in auto/sidecar mode (sidecar spawns the injector loop).
- The pill, sidecar and DB reader are all read-only consumers; they cannot affect model traffic.