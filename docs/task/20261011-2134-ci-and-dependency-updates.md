# 20261011-2134-ci-and-dependency-updates Repair the CI workflow and take the pending dependency updates

- **status**: completed
- **priority**: P2
- **owner**: agent/ci-updates-20261011
- **createdAt**: 2026-10-11 21:34

## Description

The `ci` run on the squashed history failed, and Dependabot opened five
update pull requests. Fix what is wrong in the workflow itself, take the
updates, and confirm the Ubuntu runner pin.

Plan: [20261011-2134-ci-and-dependency-updates](../plan/20261011-2134-ci-and-dependency-updates.md).

Acceptance: `bun run check` passes with the updated lockfile; the Trivy
upload no longer fails on its own when the image build fails; every job runs
on a pinned `ubuntu-26.04` runner.

## ActiveForm

Repairing CI and updating dependencies

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

- 2026-10-11 21:34: the owner asked for the fix, the updates and the runner pin directly.
- complete: lint, typecheck, unit suites (api 1070 pass / 1 skip, web 190, shared 13), build, i18n, env-docs and api-docs checks pass locally; `bun install --frozen-lockfile` accepts the lockfile. e2e and Workers smoke not run locally.
- `docker build` and `e2e` failed in CI while `docker.io/bkhq/lode:v0.0.1` was missing; the image was published before this change was pushed.
