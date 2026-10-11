import { describe, expect, it } from "bun:test";
import { getClient } from "../../lib/oidc";

// The generic file routes are the read door into every attachment blob:
// `/api/files/:fileId/{metadata,content}?ref=<referenceId>`. They authorise
// through the owner type's permission hook. No remaining module mounts an
// upload route, so only the refusal paths are reachable here; the registry
// module is the next consumer and restores the upload/download/delete round
// trip.
describe("/api/files/:id — generic download path", () => {
  it("never serves a file without a reference that belongs to it", async () => {
    const user = await getClient("user@example.com", "admin");

    // No ref → the route cannot authorise → rejected, never served.
    expect((await user.raw("/api/files/does-not-exist/metadata")).status).not.toBe(200);
    expect((await user.raw("/api/files/does-not-exist/content")).status).not.toBe(200);
    // A ref that does not belong to this file → 404 (no existence leak).
    expect((await user.raw("/api/files/does-not-exist/metadata?ref=does-not-exist")).status).toBe(404);
    expect((await user.raw("/api/files/does-not-exist/content?ref=does-not-exist")).status).toBe(404);
  });
});
