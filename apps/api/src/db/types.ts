import type { LibSQLDatabase } from "drizzle-orm/libsql";
import type * as schema from "./schema";

/**
 * The canonical database handle used across the API.
 *
 * It is spelled in the libsql (Bun) flavour because Bun is the primary
 * runtime. The Durable Object adapter in `db/workers.ts` presents the same
 * surface and casts once, at the seam — see the note there for why the
 * two drizzle dialects ("async" vs "sync") are interchangeable for this
 * codebase's `await`-style call sites.
 */
export type AppDatabase = LibSQLDatabase<typeof schema> & {
  /** Release the underlying connection. No-op on runtimes without one. */
  close: () => void;
  /**
   * Flush the write-ahead log. Used by `encryption.service.rotateDek`
   * before a copy-client opens the same file; a no-op where the host owns
   * durability.
   */
  checkpoint: () => Promise<unknown>;
};
