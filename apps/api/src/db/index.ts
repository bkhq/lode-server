import type { AppDatabase } from "./types";
import { getPlatform } from "@/platform";

export type { AppDatabase } from "./types";
export { validateEncryptionKey } from "./validate";

/**
 * Open the application database and run migrations.
 *
 * The active platform decides the engine: Bun falls through to the local
 * libsql file (`db/bun.ts`), while a runtime that cannot host one —
 * Cloudflare Workers, which runs on Durable Object SQLite — supplies its
 * own `openDatabase` through the platform seam.
 *
 * `path` and `encryptionKey` are honoured only by engines that have a
 * filesystem and at-rest encryption; see `platform.capabilities`.
 */
export async function createDb(path: string, encryptionKey?: string): Promise<AppDatabase> {
  const open = getPlatform().openDatabase;
  if (open) {
    return open(path, encryptionKey);
  }
  const { createLibsqlDb } = await import("./bun");
  return createLibsqlDb(path, encryptionKey);
}
