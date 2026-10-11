# 20261011-1355-retired-versions Keep the id of a deleted published version retired

- **status**: completed
- **createdAt**: 2026-10-11 13:55
- **approvedAt**: 2026-10-11 13:55
- **relatedTask**: 20261011-1355-retired-versions

## Context

`deleteVersion` (`modules/registry/release.service.ts`) removes a published
or yanked version outright and `createDraft` only checks the unique index
`(package_id, version)`, so the id is free again. `deletePackage` frees every
id of the package the same way, and the package can be created again under
the same slug. Asset responses of public packages are
`Cache-Control: public, max-age=31536000, immutable`.

## Proposal

- New table `registry_retired_versions` (`namespace_id`, `package_slug`,
  `version`, `retired_at`; primary key on the first three). Keyed by
  namespace and slug, not by package id, so it outlives the package.
- `deleteVersion` writes the row in its transaction when the version is not
  a draft; `deletePackage` writes one per non-draft version.
- `createDraft` answers 409 `VERSION_RETIRED` when the row exists.
- Migration `0002`, backup contribution, console error text, docs.

## Risks

- A publisher who deleted a published version by mistake cannot reuse its id;
  that is the point, and the error says so.
- Rows are never removed; one small row per deleted published version.

## Scope

`apps/api` registry schema, release and registry services with tests, one
migration, two locale files, docs.

## Alternatives

- Forbid deleting published versions: loses the takedown path.
- Key the row by package id: a package deleted and created again would free
  every id.

## Annotations

(none)
