import type { RegistryCommit } from "./commit.service";
import type { AppEnv } from "@/shared/lib/types";
import { Hono } from "hono";
import { z } from "zod";
import { describeRoute, errors, jsonCreated, jsonOk, SECURITY, TAGS, validator } from "@/shared/lib/openapi";
import { requirePackageAccess } from "./access";
import { commitBase, commitBodySchema, commitSummary, headCommit, listCommits, uploadCommit } from "./commit.service";
import { auditRelease } from "./release.routes";

const COMMIT_LIST_LIMIT = 100;

const packageParamSchema = z.object({ ns: z.string(), pkg: z.string() });

const commitSchema = z.object({
  id: z.string(),
  parent: z.string().nullable(),
  generation: z.number(),
  created: z.string(),
  key_id: z.string(),
  channels: z.record(z.string(), z.string()),
  versions: z.array(z.string()),
  added: z.array(z.string()),
  dropped: z.array(z.string()),
  uploaded_at: z.string(),
  head: z.boolean(),
});

function commitView(commit: RegistryCommit, head: boolean): z.infer<typeof commitSchema> {
  return {
    id: commit.id,
    parent: commit.parent,
    generation: commit.generation,
    created: commit.created,
    key_id: commit.keyId,
    ...commitSummary(commit),
    uploaded_at: commit.uploadedAt,
    head,
  };
}

/**
 * The manifest commits of a package: the publisher-signed manifests the feed
 * serves. Mounted by `registryRoutes` behind its `authRequired`.
 */
export function registryCommitRoutes() {
  const router = new Hono<AppEnv>();

  router.get(
    "/registry/packages/:ns/:pkg/commits",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "List the manifest commits of a package",
      description: `The package's commits, newest first (at most ${COMMIT_LIST_LIMIT}): each with its parent, \`generation\`, the \`created\` date its publisher signed, the signing key, the channels with the versions they point at, its versions, and the versions it adds and drops against its parent. \`head\` marks the one the feed serves. Empty for a package without commits. A token needs a \`read\` grant on the package.`,
      security: SECURITY.session,
      responses: { ...jsonOk(z.object({ commits: z.array(commitSchema) })), ...errors(401, 403, 404) },
    }),
    validator("param", packageParamSchema),
    async (c) => {
      const { package: pkg } = await requirePackageAccess(c, "read");
      const commits = await listCommits(c.get("db"), pkg.id, COMMIT_LIST_LIMIT);
      return c.json({ success: true, data: { commits: commits.map((commit, i) => commitView(commit, i === 0)) } });
    },
  );

  router.get(
    "/registry/packages/:ns/:pkg/commits/head",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "The manifest to build the next commit on",
      description: "The head commit's id, `generation` and manifest (asset `url`s empty). A package without commits answers `commit: null`, `generation: 0` and the manifest the registry generates, which the first commit takes over. A token needs a `read` grant on the package.",
      security: SECURITY.session,
      responses: { ...jsonOk(z.object({ commit: z.string().nullable(), generation: z.number(), manifest: z.record(z.string(), z.unknown()) })), ...errors(401, 403, 404) },
    }),
    validator("param", packageParamSchema),
    async (c) => {
      const { package: pkg } = await requirePackageAccess(c, "read");
      const base = await commitBase(c.get("db"), pkg, c.get("config").REGISTRY_MANIFEST_MAX_VERSIONS);
      return c.json({ success: true, data: base });
    },
  );

  router.post(
    "/registry/packages/:ns/:pkg/commits",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "Upload a manifest commit",
      description: [
        "Stores a complete `lode/v1` manifest its publisher signed and makes it the head the feed serves: `sig` over the catalog and `commit_sig` over the commit message (`lode.manifest-commit.v1`), whose sha256 is the commit id. `lode-cli publish --key`, `yank` and `channel` make these.",
        "`parent` must be the head's id and `generation` the head's plus one (the first commit: generation 1, no parent); otherwise 409 `COMMIT_CONFLICT`, and the publisher builds again on the new head. Both signatures must verify under an active registered key or the sub-key of the live delegation (400 `INVALID_SIGNATURE`). Every version must have been uploaded, with exactly the listed assets, each with its stored `sha256`, `run`, `exec` and runtime (400 `INVALID_COMMIT`); asset `sig` / `key_id` / `alg` are taken from the stored assets, which the catalog does not cover. Drafts the commit names are published, and the channel pointers follow it.",
        "A commit stored already answers 200 with it; a new one 201. Once a package has a commit, publishing a draft, moving a channel and signing the generated manifest are refused (409 `PACKAGE_USES_COMMITS`). Needs `write` access.",
      ].join("\n\n"),
      security: SECURITY.session,
      responses: { ...jsonOk(commitSchema, "The commit was stored already"), ...jsonCreated(commitSchema), ...errors(400, 401, 403, 404, 409, 422) },
    }),
    validator("param", packageParamSchema),
    validator("json", commitBodySchema),
    async (c) => {
      const access = await requirePackageAccess(c, "write");
      const db = c.get("db");
      const { commit, created } = await uploadCommit(db, access.package, c.req.valid("json"));
      if (created) {
        await auditRelease(c, access, "registry.commit.created", { type: "registry_commit", id: commit.id, name: `#${commit.generation}` }, {
          generation: commit.generation,
          parent: commit.parent,
          key_id: commit.keyId,
        });
      }
      const head = await headCommit(db, access.package.id);
      return c.json({ success: true, data: commitView(commit, head?.id === commit.id) }, created ? 201 : 200);
    },
  );

  return router;
}
