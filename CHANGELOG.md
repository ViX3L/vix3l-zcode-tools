# Changelog

The plugins in this marketplace are versioned independently, so each one keeps
its own changelog:

| Plugin | Changelog |
|---|---|
| **stats-composer** — *Session Statistics (TPS/TTFT)* | [plugins/stats-composer/CHANGELOG.md](plugins/stats-composer/CHANGELOG.md) |
| **usage-context** — *Turn Usage Context* | [plugins/usage-context/CHANGELOG.md](plugins/usage-context/CHANGELOG.md) |

## How this feeds the GitHub Releases

A GitHub Release's body is **not** GitHub's auto-generated commit list. When a
version tag is pushed, `.github/workflows/release.yml` extracts the section for
that exact version from the plugin's changelog and uses it as the Release
notes — so a release announces what actually changed, in the same words the
changelog records.

The extraction is done by `.github/scripts/changelog-notes.mjs`. If a version has
no section in its changelog, the release run **fails** rather than publishing a
release with no description or one that silently redirects to a commit list.
That is deliberate: a release whose notes do not say what changed is exactly the
problem this file exists to prevent.

## Writing an entry

Add the new version's section at the top of the plugin's changelog, below the
`## [Unreleased]` heading, following the shape the existing entries use:

```markdown
## [0.1.19] - 2026-10-05

### Added
- …

### Fixed
- …
```

`Keep a Changelog` categories — `Added`, `Changed`, `Deprecated`, `Removed`,
`Fixed`, `Security` — are conventional but not enforced; the extractor takes
whatever prose sits under the version heading.

The heading must be exactly `## [<version>] - <date>` so the extractor can find
it. Keep the version in sync with the three declarations the `versions` CI job
checks (`.zcode-plugin/plugin.json` and both catalogues); the release plan
refuses a tag whose version disagrees with the manifest.
