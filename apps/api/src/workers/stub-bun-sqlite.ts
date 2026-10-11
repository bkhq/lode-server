/**
 * Build-time stand-in for `bun:sqlite`, wired up through `alias` in
 * `wrangler.jsonc`.
 *
 * The only importer is the encryption module's `meta.db` reader, which
 * backs `DB_ENCRYPTION=true`. That mode is rejected at boot on Workers
 * (`capabilities.encryptionAtRest` is false), so the code path is
 * unreachable — but the import is static and the bundler still has to
 * resolve it. Constructing one anyway is a wiring bug, so it throws.
 */
export class Database {
  constructor() {
    throw new Error("bun:sqlite is not available on this runtime; DB_ENCRYPTION must be false");
  }
}

export default { Database };
