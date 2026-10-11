# 20261009-2241-lode-registry-server Multi-user lode package registry on Cloudflare Workers

- **status**: completed
- **priority**: P1
- **owner**: agent/plan-20261009
- **createdAt**: 2026-10-09 22:41

## Description

Build a hosted, multi-user release registry for lode on top of `zzci/bun-tpl`, running on Cloudflare Workers. Each user owns a namespace and publishes signed packages; operators consume them through lode's native manifest source.

Acceptance: a real `lode` binary bootstraps and auto-updates an app from a package published through the API by a second user account, against the Workers build — a signed package under `require_signature = "enforce"` and an unsigned one under `off`. A platform admin can list and take down that package; the publishing user cannot reach another user's.

Plan: [20261009-2241-lode-registry-server](../plan/20261009-2241-lode-registry-server.md). Milestones M0–M5 become their own tasks once the plan is approved.

## ActiveForm

Planning the lode registry server

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

- 2026-10-09: investigated `dotns/lode` v0.3.3 (manifest, signing, HTTP limits) and `zzci/bun-tpl` (Workers runtime, tokens, policy, file storage). Plan drafted; waiting for approval and answers to the open questions in its Annotations.
- 2026-10-09: user feedback folded into the plan — platform admin over users and all packages, open publishing with quotas, assets up to 500 MiB via multipart, signing optional, private repo `dotns/lode-server`, IdP supplied by the user. Waiting for approval.
- 2026-10-09: added the per-package CI publish token to the plan.
- 2026-10-09: replaced the per-package CI token with per-package read/write grants on personal API tokens, plus a token page.
- 2026-10-09: added the `admin` grant level (package management through a token).
- 2026-10-09: plan approved; execution coordinated through BKD three-tier (L1 = session issue in project `f7izwiu9`).
- 2026-10-09: BKD campaign `l1-3pmtxd57-20261009-2315` started in auto mode, base branch `main`. L2 issues: A foundation `51cij5hy` (M0), B backend `bkdpocw6` (M1–M3), C web UI `2linidts` (M4), D deployment and tooling `lh4nk2i8` (M5). Merge order A → B → C, D. L1 watchdog cron `b1aewltu`.
- 2026-10-10: workstream A merged into main (`ef59f08`). Naming changed by the user: namespaces are system-assigned 8-character ids; packages get a per-namespace slug plus a free-text display name. Sent to workstream B as a scope change.
- 2026-10-10: workstream B merged into main (`a2cd909`): M1–M3 done, verified with the real lode 0.3.3 binary. Workstreams C and D started in parallel. The user lifted the round budget and chose to keep presigned direct-to-R2 upload deferred.

- complete: M0-M5 merged into main (ef59f08, a2cd909, 1e3f10f, c7d4fe8); Cloudflare deployment and on-edge checks remain as owner steps in docs/develop/deployment.md
