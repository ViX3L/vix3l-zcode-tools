## Checklist

- [ ] `npm run quality` is green (sync, clones, dead code, lint).
- [ ] `npm run quality:score` reports 10/10 on both axes.
- [ ] `npm test` passes; run it twice if the change touches timing or the injectors.
- [ ] A plugin behaviour change bumps its version and adds a `CHANGELOG.md` section.
- [ ] Any new `.qualityignore` entry has a written reason.
