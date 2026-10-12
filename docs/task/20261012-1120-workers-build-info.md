# 20261012-1120-workers-build-info Report the real build identifiers on the Workers deployment

- **status**: completed
- **priority**: P2
- **owner**: agent/workers-build-info-20261012
- **createdAt**: 2026-10-12 11:20

## Description

Settings → About on the Workers deployment shows version `0.0.0-dev`, commit
`dev`, and a build time that is the moment the isolate started. Those are the
fallbacks of `apps/api/src/build-info.ts`: `scripts/package.ts` injects
`BUILD_COMMIT`, `BUILD_TIME` and `BUILD_VERSION` for the lode release asset,
but the `deploy` job of `.github/workflows/workers.yml` ran a plain
`wrangler deploy`.

Acceptance: a deployment made by the workflow reports the root
`package.json` version, the deployed commit, and that commit's time.

## ActiveForm

Passing build identifiers to the Workers deploy

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

- 2026-10-12 11:20: the owner asked for the fix directly.
- complete: the `deploy` step passes the three values with `--define`. Checked with `wrangler deploy --dry-run` and the same flags: the bundle carries the commit, the commit time and `0.1.0`. Not yet deployed.
