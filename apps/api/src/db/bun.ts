import type { Client, InStatement } from "@libsql/client";
import type { AppDatabase } from "./types";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle, LibSQLPreparedQuery } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { AppError } from "@/shared/lib/errors";
import { ROOT_DIR } from "../root";
import * as schema from "./schema";
import { validateEncryptionKey } from "./validate";

// ─── Write serialization ───
//
// libsql's `transaction()` holds one pooled connection — and SQLite's write
// lock, since drizzle opens it with BEGIN IMMEDIATE — across every `await` in
// the transaction body. A write from another request meanwhile lands on a
// second connection and meets that lock. Two things can then happen, and
// both are wrong:
//
//  - with no busy timeout it fails at once with SQLITE_BUSY, so any two
//    modules that happen to write together produce a 500;
//  - with a busy timeout it waits inside SQLite, and libsql executes
//    synchronously, so the wait blocks the event loop. The transaction it is
//    waiting for needs that same loop to commit, so it never does, and the
//    write fails anyway once the timeout has frozen the whole server.
//
// So contention inside this process is resolved before SQLite sees it: a
// transaction holds an async lock for its whole life, and a write outside a
// transaction takes the same lock for its one statement. Reads skip it — in
// WAL mode they never block on a writer.

/** Longest a write waits for the lock before answering 503 DB_BUSY. */
const WRITE_WAIT_LIMIT_MS = 15_000;

/** For another process writing the same file; see `createLibsqlDb`. */
const CROSS_PROCESS_BUSY_TIMEOUT_MS = 5_000;

let writeWaitLimitOverride: number | undefined;

/** Test-only: shorten the lock wait so the DB_BUSY path is reachable. */
export function __setWriteWaitLimitForTests(ms: number | undefined): void {
  writeWaitLimitOverride = ms;
}

class WriteLock {
  #held = false;
  #queue: Array<() => void> = [];

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#held)
      await this.#wait();
    this.#held = true;
    try {
      return await fn();
    }
    finally {
      this.#release();
    }
  }

  #release(): void {
    // Hand ownership straight to the next waiter, so a caller arriving in
    // between cannot jump the queue.
    const next = this.#queue.shift();
    if (next)
      next();
    else
      this.#held = false;
  }

  /** Only a caller that actually has to queue pays for a timer. */
  #wait(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const turn = () => {
        clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(() => {
        // Leave the queue, so the lock is never handed to a caller that has
        // already given up and would strand everyone behind it.
        const i = this.#queue.indexOf(turn);
        if (i !== -1)
          this.#queue.splice(i, 1);
        reject(new AppError("The database is busy. Try again shortly.", 503, "DB_BUSY"));
      }, writeWaitLimitOverride ?? WRITE_WAIT_LIMIT_MS);
      this.#queue.push(turn);
    });
  }
}

/**
 * One lock per database file, not per client: anything in this process that
 * opens the same file competes for the same SQLite write lock.
 */
const writeLocks = new Map<string, WriteLock>();

function writeLockFor(path: string): WriteLock {
  let lock = writeLocks.get(path);
  if (!lock) {
    lock = new WriteLock();
    writeLocks.set(path, lock);
  }
  return lock;
}

/**
 * Set while a transaction body runs. A mutable flag rather than a plain
 * marker, so work the body started without awaiting — which keeps this
 * context after the transaction ends — is not mistaken for part of it.
 */
const transactionScope = new AsyncLocalStorage<{ open: boolean }>();

const RE_LEADING_COMMENTS = /^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/;
const RE_READ = /^(?:SELECT|EXPLAIN|PRAGMA)\b/i;
const RE_CHECKPOINT = /wal_checkpoint/i;
const RE_DEFINITE_WRITE = /^(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|VACUUM|REINDEX)\b/i;

function sqlOf(stmt: InStatement): string {
  return (typeof stmt === "string" ? stmt : stmt.sql).replace(RE_LEADING_COMMENTS, "");
}

/** Anything not plainly a read takes the lock. Waiting is never wrong, only slower. */
function takesLock(text: string): boolean {
  return !RE_READ.test(text) || RE_CHECKPOINT.test(text);
}

function escapedWrite(): Error {
  return new Error(
    "A write reached the database through the outer handle while running inside a transaction. "
    + "The transaction holds the write lock, so this can never succeed — use the transaction handle (`tx`) instead.",
  );
}

/**
 * Wrap the libsql client so statements that write wait their turn. Statements
 * a transaction runs go through its own handle, not this client, so they are
 * not gated again.
 */
function gateWrites(client: Client, lock: WriteLock): Client {
  const inOpenTransaction = () => transactionScope.getStore()?.open === true;

  const execute: Client["execute"] = (async (stmtOrSql: InStatement | string, args?: unknown) => {
    const run = () => (args === undefined
      ? client.execute(stmtOrSql as InStatement)
      : client.execute(stmtOrSql as string, args as never));
    const text = sqlOf(stmtOrSql as InStatement);
    if (!takesLock(text))
      return run();
    if (inOpenTransaction()) {
      // Only a definite write is refused. Something merely not recognized as
      // a read — a `WITH … SELECT`, say — passes through as it did before.
      if (RE_DEFINITE_WRITE.test(text))
        throw escapedWrite();
      return run();
    }
    return lock.run(run);
  }) as Client["execute"];

  // Each of these opens a transaction of its own inside libsql.
  const exclusive = <K extends "batch" | "executeMultiple" | "migrate">(name: K): Client[K] =>
    (async (...args: unknown[]) => {
      if (inOpenTransaction())
        throw escapedWrite();
      return lock.run(() => (client[name] as (...a: unknown[]) => Promise<unknown>)(...args));
    }) as Client[K];

  const overrides: Partial<Client> = {
    execute,
    batch: exclusive("batch"),
    executeMultiple: exclusive("executeMultiple"),
    migrate: exclusive("migrate"),
  };

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop in overrides)
        return overrides[prop as keyof Client];
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// ─── Empty raw get ───

// drizzle's libsql driver maps a raw `db.get(sql)` result by calling
// Object.keys on the first row, so a query matching nothing threw "Failed
// query" instead of returning undefined, as the builder `.get()` and the
// Durable Object driver do. Patched on the prototype so transactions, which
// build their own session and prepared queries, are covered too.
interface MapGetResult {
  mapGetResult: (rows: unknown, isFromBatch?: boolean) => unknown;
}
const libsqlQuery = LibSQLPreparedQuery.prototype as unknown as MapGetResult & { fields?: unknown; customResultMapper?: unknown };
const mapGetResult = libsqlQuery.mapGetResult;
libsqlQuery.mapGetResult = function (this: typeof libsqlQuery, rows, isFromBatch) {
  const list = (isFromBatch === true ? (rows as { rows: unknown[] }).rows : rows) as unknown[];
  if (list[0] === undefined && this.fields === undefined && this.customResultMapper === undefined)
    return undefined;
  return mapGetResult.call(this, rows, isFromBatch);
};

/**
 * Open the local libsql database. Bun-only: it needs a filesystem, a
 * native binding, and PRAGMA-level tuning. Reached through
 * `createDb()` in `db/index.ts` when the active platform does not
 * override `openDatabase`.
 */
export async function createLibsqlDb(path: string, encryptionKey?: string): Promise<AppDatabase> {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  if (encryptionKey) {
    validateEncryptionKey(encryptionKey);
  }

  // `timeout` is applied to every connection the client's pool opens. A
  // `PRAGMA busy_timeout` would reach only the one connection that ran it,
  // leaving the rest to fail on the first lock they meet. It only matters
  // for another *process* writing the same file — within this one, writes
  // are serialized before they reach SQLite (see `gateWrites`).
  const client = createClient({
    url: `file:${path}`,
    timeout: CROSS_PROCESS_BUSY_TIMEOUT_MS,
    ...(encryptionKey ? { encryptionKey } : {}),
  });

  await client.execute("PRAGMA journal_mode = WAL");
  await client.execute("PRAGMA foreign_keys = ON");

  // Performance / footprint tuning. Some PRAGMAs are no-ops on libsql with
  // encryption enabled — swallow the error and continue rather than aborting
  // the whole bootstrap.
  for (const pragma of [
    "PRAGMA synchronous = NORMAL",
    "PRAGMA cache_size = -65536",
    // Never memory-map an encrypted database. libsql's page-level
    // encryption and mmap I/O do not mix: with mmap on, a long-lived
    // encrypted WAL was observed to become "database disk image is
    // malformed" after an ordinary fresh-page append (reproduced end-to-end
    // by the e2e suite; deterministic per write sequence; clean with mmap
    // off). Plaintext databases keep the mapping.
    ...(encryptionKey ? [] : ["PRAGMA mmap_size = 268435456"]),
    "PRAGMA temp_store = MEMORY",
  ]) {
    try {
      await client.execute(pragma);
    }
    catch (err) {
      // eslint-disable-next-line no-console
      console.debug(`[db] ${pragma} skipped:`, err);
    }
  }

  const lock = writeLockFor(path);
  const gated = gateWrites(client, lock);
  const db = drizzle(gated, { schema });

  await runMigrations(db);

  const transaction = db.transaction.bind(db);

  return Object.assign(db, {
    // The whole transaction holds the write lock, from BEGIN to COMMIT, and
    // marks its async context so a write that escapes it through this outer
    // handle is caught instead of waiting on a lock it can never get.
    transaction: (async (fn: Parameters<typeof transaction>[0], config?: Parameters<typeof transaction>[1]) =>
      lock.run(async () => {
        const scope = { open: true };
        try {
          return await transactionScope.run(scope, () => transaction(fn, config));
        }
        finally {
          scope.open = false;
        }
      })) as typeof transaction,
    close: () => client.close(),
    // Used by encryption.service.rotateDek to flush WAL before the libsql
    // copy-client opens the same file. Goes through the gate so it waits for
    // an open transaction rather than blocking on it.
    checkpoint: () => gated.execute("PRAGMA wal_checkpoint(TRUNCATE)"),
  }) as AppDatabase;
}

async function runMigrations(db: ReturnType<typeof drizzle>) {
  const fsMigrationsFolder = resolveMigrationsFolder();
  const journalPath = resolve(fsMigrationsFolder, "meta/_journal.json");

  if (!existsSync(journalPath)) {
    throw new Error(
      `No migrations available: expected ${journalPath}. `
      + "Packaged releases must ship drizzle/ alongside index.js. "
      + "Run `bun run package` to rebuild the lode artifact.",
    );
  }

  await migrate(db, { migrationsFolder: fsMigrationsFolder });
}

/**
 * Locate the Drizzle migrations folder for both layouts: a packaged lode
 * artifact ships `drizzle/` at ROOT_DIR (next to index.js); the dev/source
 * tree keeps it under `apps/api/drizzle`.
 */
function resolveMigrationsFolder(): string {
  const packaged = resolve(ROOT_DIR, "drizzle");
  if (existsSync(resolve(packaged, "meta/_journal.json")))
    return packaged;
  return resolve(ROOT_DIR, "apps/api/drizzle");
}
