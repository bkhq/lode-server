# Lode Server - Plan Index

> Updated: 2026-10-09

## Usage

Each plan is a single line linking to its detail file. All detailed information lives in `docs/plan/<timestamp>-<feature-slug>.md`.

### Format

- [ ] [**20260907-1440-add-endpoint Add endpoint**](20260907-1440-add-endpoint.md) `YYYY-MM-DD`

### Status Markers

| Marker | Meaning |
|--------|---------|
| `[ ]`  | Draft / Pending review |
| `[-]`  | Approved / Implementing |
| `[x]`  | Completed |
| `[~]`  | Rejected / Abandoned |
| `[d]`  | Deleted detail file; index entry retained |

### Rules

- Only update the checkbox marker; never delete the line or change its other content. If the detail file is deleted, mark the entry `[d]`.
- Record change history and deletion reasons in `docs/changelog.md`; update affected task and plan references.
- New plans append to the end.
- See each `<timestamp>-<feature-slug>.md` for full details, except `[d]` entries whose files have been deleted; consult `docs/changelog.md` for their history.

---

## Plans

- [x] [**20261009-2241-lode-registry-server Multi-user lode package registry on Cloudflare Workers**](20261009-2241-lode-registry-server.md) `2026-10-09`
- [x] [**20261010-2100-manifest-signature Serve a publisher-signed manifest**](20261010-2100-manifest-signature.md) `2026-10-10`
- [x] [**20261011-1305-audit-fixes Fix the 2026-10-11 security audit findings**](20261011-1305-audit-fixes.md) `2026-10-11`
- [x] [**20261011-1355-retired-versions Keep the id of a deleted published version retired**](20261011-1355-retired-versions.md) `2026-10-11`
- [x] [**20261011-1443-artifact-signature-v2 Verify lode's app-bound asset signature**](20261011-1443-artifact-signature-v2.md) `2026-10-11`
- [x] [**20261011-2134-ci-and-dependency-updates Repair the CI workflow and take the pending dependency updates**](20261011-2134-ci-and-dependency-updates.md) `2026-10-11`
- [x] [**20261012-1852-lode-mini-pin Pin lode to v0.0.3-mini and document the publish workflow**](20261012-1852-lode-mini-pin.md) `2026-10-12`
