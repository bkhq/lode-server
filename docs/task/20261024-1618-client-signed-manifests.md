# 20261024-1618-client-signed-manifests Store publisher-signed manifests as commits

- **status**: completed
- **priority**: P2
- **owner**: agent/commit-manifests-20261024
- **createdAt**: 2026-10-24 16:18

## Description

The registry builds each package's catalog itself, so the publisher's manifest
signature goes stale on every publish, channel move, yank or restore, and the
manifest is served unsigned until it is signed again. Let the publishing client
build and sign the whole manifest, as it does for assets; the registry stores
each manifest as an immutable commit, serves the head, and lets the web move the
head between signed commits.

## ActiveForm

Storing publisher-signed manifests as commits

## Notes

- Plan: [20261024-1618-client-signed-manifests](../plan/20261024-1618-client-signed-manifests.md)

- complete: commits API, feed, web Commits tab, lode-cli publish/yank/channel, lode commit floor; e2e green with old and new lode
