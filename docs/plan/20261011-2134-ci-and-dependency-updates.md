# 20261011-2134-ci-and-dependency-updates Repair the CI workflow and take the pending dependency updates

- **status**: completed
- **createdAt**: 2026-10-11 21:34
- **approvedAt**: 2026-10-11 21:34
- **relatedTask**: 20261011-2134-ci-and-dependency-updates

## Context

The first `ci` run on the squashed history failed in two jobs. `docker build`
and `e2e` both need `docker.io/bkhq/lode:v0.0.1`, which is not published yet
(lode's 0.0.1 release is pending). In `docker build` the failed build also
failed `Upload Trivy results`, because the step runs with `if: always()` and
the SARIF file it uploads only exists after a successful scan. Dependabot
opened five pull requests against the new history: three action bumps and the
`runtime` and `tooling` groups.

Every job already runs on `ubuntu-26.04`; no runner label needed changing.

## Proposal

- `Upload Trivy results` runs only when `trivy-image.sarif` exists.
- Actions: `actions/setup-node` v7 (`release.yml` pinned to the v7.1.0
  commit), `trufflesecurity/trufflehog` v3.99.2,
  `google/osv-scanner-action` v2.6.0.
- Dependencies: the patch and minor updates of the `runtime` and `tooling`
  groups, plus `vitest` 5.0.3 in the catalog so it matches
  `@vitest/coverage-v8` 5.0.3.
- Drop two `eslint-disable` directives in `shared/lib/logger.ts` that the
  newer `@eslint-react/eslint-plugin` reports as unused.

## Risks

- `docker build` and `e2e` are red whenever the pinned `bkhq/lode` image is
  not on Docker Hub. That is a missing release, not a workflow defect, and the
  jobs are left to fail loudly rather than skip.

## Scope

`.github/workflows/`, the three `package.json` manifests, `bun.lock`, one
source file, docs.

## Alternatives

- Merge the five Dependabot pull requests: each would be red for the same
  missing image, and the two grouped ones conflict on `bun.lock`.
- Skip the lode-dependent jobs while the image is missing: hides the real
  client suites exactly when the pin is wrong.

## Annotations
