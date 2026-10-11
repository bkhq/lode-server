# Lode Server - Task List

> Updated: 2026-10-09

## Usage

Each task is a single line linking to its detail file. All detailed information lives in `docs/task/<timestamp>-<feature-slug>.md`.

### Format

- [ ] [**20260907-1428-add-endpoint Add endpoint**](20260907-1428-add-endpoint.md) `P1`

### Status Markers

| Marker | Meaning |
|--------|---------|
| `[ ]`  | Pending |
| `[-]`  | In progress |
| `[x]`  | Completed |
| `[~]`  | Closed / Won't do |
| `[d]`  | Deleted detail file; index entry retained |

### Priority: P0 (blocking) > P1 (high) > P2 (medium) > P3 (low)

### Rules

- Only update the checkbox marker; never delete the line or change its other content. If the detail file is deleted, mark the entry `[d]`.
- Record change history and deletion reasons in `docs/changelog.md`; update affected dependency and plan references.
- New tasks append to the end.
- See each `<timestamp>-<feature-slug>.md` for full details, except `[d]` entries whose files have been deleted; consult `docs/changelog.md` for their history.

---

## Tasks

- [x] [**20261009-2241-lode-registry-server Multi-user lode package registry on Cloudflare Workers**](20261009-2241-lode-registry-server.md) `P1`
- [x] [**20261010-2100-manifest-signature Serve a publisher-signed manifest**](20261010-2100-manifest-signature.md) `P1`
- [x] [**20261011-1305-audit-fixes Fix the 2026-10-11 security audit findings**](20261011-1305-audit-fixes.md) `P1`
- [x] [**20261011-1355-retired-versions Keep the id of a deleted published version retired**](20261011-1355-retired-versions.md) `P2`
- [x] [**20261011-1443-artifact-signature-v2 Verify lode's app-bound asset signature**](20261011-1443-artifact-signature-v2.md) `P1`
- [x] [**20261011-2134-ci-and-dependency-updates Repair the CI workflow and take the pending dependency updates**](20261011-2134-ci-and-dependency-updates.md) `P2`
