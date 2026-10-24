import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT_DIR } from "../root";

/**
 * Locate the Drizzle migrations folder for both layouts: a packaged lode
 * artifact ships `drizzle/` at ROOT_DIR (next to index.js); the dev/source
 * tree keeps it under `apps/api/drizzle`.
 */
export function resolveMigrationsFolder(): string {
  const packaged = resolve(ROOT_DIR, "drizzle");
  if (existsSync(resolve(packaged, "meta/_journal.json")))
    return packaged;
  return resolve(ROOT_DIR, "apps/api/drizzle");
}
