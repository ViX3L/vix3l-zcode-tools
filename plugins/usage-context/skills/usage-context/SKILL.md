---
name: usage-context
description: Per-turn token usage and elapsed time for ZCode, shown in each assistant turn's footer as chips ("Usage N tok", "Ran for Ns") with hover panels for the full breakdown. Use when the user asks how many tokens a turn used, the token/cache breakdown, how long a turn ran, or about the usage chips beside the timestamp.
---

# usage-context — per-turn usage beside the timestamp

Every assistant turn in ZCode gets two chips to the right of its timestamp, separated by a thin transparent rule:

```
04:46 AM  |  [ 🗄 Usage 729K tok ]  [ ⏱ Ran for 43s ]
```

Hovering the **Usage** chip opens a **Turn usage** panel (the turn's total, provider/model, uncached input, output). Hovering the **Ran for** chip opens a **Turn time and speed** panel (total run time). These mirror the panels ZCode's own usage UI shows.

## Where the data comes from

This plugin owns **no server and never opens the usage DB**. It reads per-turn figures over HTTP from the **stats-composer** sidecar's `/turn` endpoint (`~/.zcode/cli/db/db.sqlite`, table `turn_usage`). One shared server, one DB reader — installing this plugin adds only a small CDP client, not a second process on a port.

Consequence: **stats-composer must be installed and running** for the chips to show. Without it, the chips stay hidden and this plugin says nothing else.

## Figures and their exact definitions

| Shown as | Comes from |
|---|---|
| Usage (chip) | `computed_total_tokens` for the turn — cached + uncached + output |
| Ran for (chip) | `turn_usage.duration_ms` — full wall-clock, including idle gaps within the turn |
| Uncached input | `input_tokens − cache_read_input_tokens` |
| Cached input | `cache_read_input_tokens` |
| Output | `output_tokens + reasoning_tokens` |
| Provider / model | provider display name (from ZCode's provider config) + model id |

## Reading it without hovering

```bash
PORT=$(cat ~/.zcode/stats-composer/port 2>/dev/null || echo 7427)
curl -s "http://127.0.0.1:$PORT/turn?session=$ZCODE_SESSION_ID" | jq        # all turns + totals
curl -s "http://127.0.0.1:$PORT/turn?session=$ZCODE_SESSION_ID&msg=<msg_id>" | jq .turn  # one turn
```

## Notes

- Turn ids join the rendered conversation to the DB: each assistant turn carries `data-turn-id`, whose value equals `turn_usage.user_message_id`.
- The chips update on a 2 s poll; a turn only changes the table when it completes.
- If nothing appears, first confirm the stats-composer sidecar answers on its port (`curl -s http://127.0.0.1:7427/health`).
