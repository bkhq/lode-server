import type { SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

const LIKE_SPECIAL_RE = /[%_\\]/g;

/** Escape `%`, `_` and `\` for a pattern passed to {@link likeEscaped}. */
export function escapeLike(v: string): string {
  return v.replace(LIKE_SPECIAL_RE, "\\$&");
}

/**
 * `column LIKE pattern ESCAPE '\'`. SQLite's LIKE has no escape character
 * unless the query names one, so without the clause an escaped `\%` would
 * look for a literal backslash and match nothing.
 */
export function likeEscaped(column: SQLiteColumn, pattern: string): SQL {
  return sql`${column} LIKE ${pattern} ESCAPE '\\'`;
}
