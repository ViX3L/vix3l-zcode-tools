# Quality baseline and how to verify it

This repository treats code quality as a build artifact, not a review opinion.
This file is the enforced contract: the commands that certify it, the audit
baseline, and the exemption rule.

## Run the gates

```sh
npm run quality        # sync + clones + dead code + lint rules
npm run quality:score  # the 20-point DRY/clean-code scorecard
```

Both are dependency-free: they run on the stock Node toolchain, so CI does not
install anything for them. `npm test` covers behaviour; the gates cover shape.

## Commands behind the scorecard

| Gate | Command | What it rejects |
|---|---|---|
| Shared-source sync | `npm run quality:sync` | a generated plugin copy that drifted from `shared/lib/` |
| Clone detection | `npm run quality:dupes` | ≥10-line normalized clones outside declared exemptions |
| Dead code | `npm run quality:dead` | unused imports and exports in first-party source |
| Lint rules | `npm run quality:lint` | modules >400 lines, entrypoints >150, functions >60, empty `catch`, prefix CORS |
| Scorecard | `npm run quality:score` | any of the 20 DRY/clean-code points failing |

## Audit baseline → current

| Measure | Audit (2026-10-18) | Current |
|---|---:|---:|
| DRY score | 4.3 / 10 | 10 / 10 |
| Clean-code score | 5.8 / 10 | 10 / 10 |
| Known high-severity defects | 9 | 0 |
| Unjustified duplicated lines | ~500–600 | 0 |
| Dead exports / unused imports | 30+ | 0 |

The score is only meaningful together with the test suite: the mechanical gates
cannot see behaviour. CI runs `npm test` in the pinned container and the gates
on the runner, so a change must satisfy both.

## Exemptions

`.qualityignore` holds every exemption as `<glob> # <reason>`. An exemption
without a reason makes the gate fail to load, deliberately: silent suppression
is the failure mode this system exists to prevent.
