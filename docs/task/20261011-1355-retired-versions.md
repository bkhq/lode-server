# 20261011-1355-retired-versions Keep the id of a deleted published version retired

- **status**: completed
- **priority**: P2
- **owner**: agent/audit-fixes-20261011
- **createdAt**: 2026-10-11 13:55

## Description

Finding 8 of the 2026-10-11 audit: a published version can be deleted and
its id published again with other bytes, while the feed served the old asset
as `immutable` for a year. Hosts behind a cache then fail the digest check,
and hosts that installed the first bytes never get the second.

Plan: [20261011-1355-retired-versions](../plan/20261011-1355-retired-versions.md).

Acceptance: once a version that was published is deleted — alone or with its
package — creating that version id in the same `<namespace>/<slug>` answers
409 `VERSION_RETIRED`; a deleted draft's id stays free.

## ActiveForm

Retiring the ids of deleted published versions

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

- 2026-10-11 13:55: approved by the owner, who also allows the database to be reset; the change is an additive migration and needs no reset.

- complete: Unit suite 1064 pass, e2e 113 pass / 7 pre-existing skips, lint, typecheck and i18n check clean.
