import type { Context } from "hono";
import type { RegistryPackage } from "./access";
import type { AppEnv } from "@/shared/lib/types";
import { Hono } from "hono";
import { deriveOrigin } from "@/shared/lib/app-config";
import { AppError } from "@/shared/lib/errors";
import { describeRoute, errors, raw, TAGS } from "@/shared/lib/openapi";
import { findPackage, resolveReadToken } from "./access";
import { getActiveBlobStore } from "./blob";
import { findRevocationList, revocationListDocument, withDelegation } from "./delegation.service";
import { buildManifest, findPublishedAsset } from "./feed.service";
import { withManifestSignature } from "./manifest-signature.service";
import { registryOtlpRoutes } from "./observe.routes";

/** Mount point of the read feed, at the origin root whatever BASE_PATH is. Part of every manifest URL an operator configures: permanent. */
export const READ_FEED_PREFIX = "/r";

const PRIVATE_CACHE = "private, no-store";
const MANIFEST_CACHE = "public, max-age=60";
const ASSET_CACHE = "public, max-age=31536000, immutable";

// One answer for everything the feed does not serve, the same body the raw
// app gives an unknown path: whether a package exists must not show.
function notFound(): AppError {
  return new AppError("Not found", 404, "NOT_FOUND");
}

/**
 * The package the request names, when the caller may read it: a public
 * package anonymously, a private one with a token holding a read grant on it.
 * Nothing in a suspended namespace is served.
 */
async function readablePackage(c: Context<AppEnv>): Promise<RegistryPackage> {
  const db = c.get("db");
  const resolved = await findPackage(db, c.req.param("ns") ?? "", c.req.param("pkg") ?? "");
  if (!resolved || resolved.namespace.status !== "active")
    throw notFound();
  if (resolved.package.visibility !== "public" && !(await resolveReadToken(db, c.req.header("authorization"), resolved.package.id)))
    throw notFound();
  return resolved.package;
}

function cacheControl(pkg: RegistryPackage, whenPublic: string): string {
  return pkg.visibility === "public" ? whenPublic : PRIVATE_CACHE;
}

async function strongEtag(body: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)));
  return `"${Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")}"`;
}

/** `If-None-Match`, by the weak comparison a GET uses. */
function matchesEtag(header: string | undefined, etag: string): boolean {
  if (header === undefined)
    return false;
  return header.split(",").some((candidate) => {
    const tag = candidate.trim();
    return tag === "*" || tag === etag || tag === `W/${etag}`;
  });
}

const ACCESS_NOTE = "A public package is served anonymously. A private one needs `Authorization: Bearer pat_…`, a personal API token holding a `read` grant on the package; without it the answer is the same 404 an unknown package gets. Nothing in a suspended namespace is served. No session, cookie or CSRF header is involved.";

/**
 * The read feed lode polls and downloads from, served at
 * `/r` through the raw-app builder (see `buildRawApp`): no
 * session, CSRF, CORS or policy middleware, the per-client raw rate limit
 * only. Access is checked here, per request.
 */
export function registryFeedRoutes() {
  const router = new Hono<AppEnv>();

  // What hosts report: `/r/otlp/v1/metrics` and `/r/otlp/v1/logs`.
  router.route("/otlp", registryOtlpRoutes());

  router.get(
    "/:ns/:pkg/manifest.json",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "Package manifest (lode/v1)",
      description: [
        `Served at \`${READ_FEED_PREFIX}/:ns/:pkg/manifest.json\`, outside \`/api\`: the URL an operator sets as \`[update].manifest\`. The generated \`lode/v1\` manifest of the package: \`name\` is the package slug, \`channels.<c>.latest\` the channel pointers, \`versions.<v>.assets[]\` the assets with \`name\`, an absolute same-host \`url\`, \`sha256\`, \`size\`, and \`sig\` / \`key_id\` / \`alg\` / \`run\` / \`exec\` where the asset has them.`,
        "Published versions only, newest first, capped at `REGISTRY_MANIFEST_MAX_VERSIONS` plus the target of every channel.",
        "The top-level `key_id` / `sig`, and `expires` / `expires_sig`, are present while the package has a live publisher signature over this catalog (`PUT /api/registry/packages/:ns/:pkg/manifest-signature`). A signature whose catalog has changed, whose expiry has passed or whose key was revoked is left out, and the manifest is served unsigned.",
        "The top-level `delegation` is present while the package's delegation is live (`PUT /api/registry/packages/:ns/:pkg/delegation`): within its window, its root key active and its sub-key not revoked.",
        ACCESS_NOTE,
        "A public manifest carries a strong `ETag` and `Cache-Control: public, max-age=60`, and answers a matching `If-None-Match` with 304. A private one is `private, no-store`.",
      ].join("\n\n"),
      responses: {
        ...raw(200, "application/json", "The lode/v1 manifest"),
        304: { description: "Not modified" },
        ...errors(404, 429),
      },
    }),
    async (c) => {
      const pkg = await readablePackage(c);
      const config = c.get("config");
      const manifest = await withDelegation(c.get("db"), pkg, await withManifestSignature(c.get("db"), pkg, await buildManifest(c.get("db"), pkg, {
        maxVersions: config.REGISTRY_MANIFEST_MAX_VERSIONS,
        assetBase: `${deriveOrigin(c.req.raw, config)}${READ_FEED_PREFIX}/${c.req.param("ns")}/${pkg.slug}`,
      })));
      const body = JSON.stringify(manifest);
      c.header("Cache-Control", cacheControl(pkg, MANIFEST_CACHE));
      c.header("Content-Type", "application/json");
      if (pkg.visibility !== "public")
        return c.body(body);

      const etag = await strongEtag(body);
      c.header("ETag", etag);
      if (matchesEtag(c.req.header("if-none-match"), etag))
        return c.body(null, 304);
      return c.body(body);
    },
  );

  router.get(
    "/:ns/:pkg/revocations.json",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "Package revocation list (lode-revocations/v1)",
      description: [
        `Served at \`${READ_FEED_PREFIX}/:ns/:pkg/revocations.json\`, outside \`/api\`: the URL an operator sets as \`[trust].revocation_url\`. The signed list of revoked sub-key ids the publisher stored with \`PUT /api/registry/packages/:ns/:pkg/revocations\`, as \`lode-cli revoke\` wrote it. 404 while the package has none.`,
        ACCESS_NOTE,
        "Caching as for the manifest: a public list is `Cache-Control: public, max-age=60`, a private one `private, no-store`.",
      ].join("\n\n"),
      responses: {
        ...raw(200, "application/json", "The lode-revocations/v1 list"),
        ...errors(404, 429),
      },
    }),
    async (c) => {
      const pkg = await readablePackage(c);
      const list = await findRevocationList(c.get("db"), pkg.id);
      if (!list)
        throw notFound();
      c.header("Cache-Control", cacheControl(pkg, MANIFEST_CACHE));
      return c.json(revocationListDocument(list));
    },
  );

  router.get(
    "/:ns/:pkg/:ver/:asset",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "Download an asset",
      description: [
        `Served at \`${READ_FEED_PREFIX}/:ns/:pkg/:ver/:asset\`, outside \`/api\`: the \`url\` a manifest gives for the asset. The bytes are streamed from the blob store with their \`Content-Length\`. Only assets of published versions are served: a draft's or a yanked version's answer 404.`,
        ACCESS_NOTE,
        "An asset of a public package is `Cache-Control: public, max-age=31536000, immutable` — a published asset never changes. A private one is `private, no-store`.",
      ].join("\n\n"),
      responses: {
        ...raw(200, "application/octet-stream", "The asset bytes"),
        ...errors(404, 429),
      },
    }),
    async (c) => {
      const pkg = await readablePackage(c);
      const asset = await findPublishedAsset(c.get("db"), pkg.id, c.req.param("ver"), c.req.param("asset"));
      if (!asset)
        throw notFound();
      const headers = {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(asset.size),
        "Cache-Control": cacheControl(pkg, ASSET_CACHE),
      };
      // Hono answers HEAD from this handler; do not open a stream nobody reads.
      if (c.req.method === "HEAD")
        return new Response(null, { headers });

      const blob = await getActiveBlobStore(c.get("config")).get(asset.blobKey);
      if (!blob) {
        c.get("logger").error({ assetId: asset.id, blobKey: asset.blobKey }, "registry asset has no object in the blob store");
        throw notFound();
      }
      // Straight from the store to the client: nothing is buffered.
      return new Response(blob.body, { headers });
    },
  );

  return router;
}
