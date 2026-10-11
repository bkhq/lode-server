# Runtime image for lode-managed releases.
#
# The application is no longer baked into this image. lode downloads a
# versioned release asset (built by `scripts/package.ts`), verifies its
# checksum/signature per lode.toml, runs `bun index.js`, and supervises
# update / rollback. The app's writable state lives on the /srv/lode volume,
# separate from the swappable version directories.
ARG BUN_IMAGE=docker.io/oven/bun:1.4.2-debian
ARG LODE_IMAGE=docker.io/bkhq/lode:v0.0.1

FROM ${LODE_IMAGE} AS lode

FROM ${BUN_IMAGE}
WORKDIR /srv/lode

COPY --from=lode /usr/bin/lode /usr/local/bin/lode
RUN apt-get update \
 && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends ca-certificates libcap2 \
 && rm -rf /var/lib/apt/lists/* \
 && ln -sf /usr/local/bin/lode /usr/local/bin/lode-cli \
 && mkdir -p /srv/lode/data \
 && chown -R bun:bun /srv/lode

EXPOSE 3000
VOLUME ["/srv/lode"]

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
# Containerised deploys hand stdout/stderr to the runtime (docker logs, k8s).
ENV LOG_TO_STDOUT=true
# lode supervisor wiring. `LODE_DIR` is lode's base dir (holds lode.toml,
# versions/, state.json); lode injects it (+ LODE_WORKDIR/LODE_INSTANCE) into the
# app. lode.toml is the operator's file — mount a real one at /srv/lode/lode.toml
# (deploy/lode.toml is a template); lode also scaffolds a starter on first run.
ENV LODE_DIR=/srv/lode
ENV LODE_CONFIG=/srv/lode/lode.toml
# App data anchors at ${LODE_DIR}/data = /srv/lode/data automatically — its own
# subdir of the volume, separate from lode's state.json / versions/ / runtime/.
# Override with DATA_DIR (e.g. a separate volume) if needed.

USER bun

# lode's own healthcheck inspects the supervised app's state.json (app-agnostic,
# no curl in the image required).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["lode", "healthcheck"]

STOPSIGNAL SIGTERM

ENTRYPOINT ["lode"]
