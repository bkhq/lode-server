import type { AppDatabase } from "./types";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { findAppError } from "@/shared/lib/errors";
import { __setWriteWaitLimitForTests } from "./bun";
import { createDb } from "./index";

let db: AppDatabase;
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(resolve(tmpdir(), "db-concurrency-"));
  db = await createDb(resolve(dir, "app.db"));
  await db.run(sql`CREATE TABLE probe (x INTEGER)`);
});

afterEach(() => {
  __setWriteWaitLimitForTests(undefined);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function causeMessages(err: unknown): string[] {
  const out: string[] = [];
  for (let cur = err; cur instanceof Error; cur = cur.cause)
    out.push(cur.message);
  return out;
}

async function count(): Promise<number> {
  const rows = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM probe`);
  return rows[0]!.n;
}

describe("libsql writes under concurrency", () => {
  test("a write while a transaction is open waits for it instead of failing", async () => {
    // libsql runs statements synchronously, so a write that waited on SQLite's
    // busy handler would block the event loop — and the open transaction,
    // which needs that loop to commit, could never finish. The write has to
    // wait in JavaScript instead.
    const order: string[] = [];
    const tx = db.transaction(async (t) => {
      await t.run(sql`INSERT INTO probe VALUES (1)`);
      await sleep(150);
      order.push("tx committed");
    });
    await sleep(20);
    const write = db.run(sql`INSERT INTO probe VALUES (2)`).then(() => {
      order.push("write done");
    });

    await Promise.all([tx, write]);
    expect(order).toEqual(["tx committed", "write done"]);
    expect(await count()).toBe(2);
  });

  test("overlapping transactions both commit", async () => {
    const a = db.transaction(async (t) => {
      await t.run(sql`INSERT INTO probe VALUES (1)`);
      await sleep(80);
    });
    const b = db.transaction(async (t) => {
      await t.run(sql`INSERT INTO probe VALUES (2)`);
    });
    await Promise.all([a, b]);
    expect(await count()).toBe(2);
  });

  test("many interleaved writes and transactions lose nothing", async () => {
    const work: Promise<unknown>[] = [];
    for (let i = 0; i < 20; i++) {
      work.push(i % 3 === 0
        ? db.transaction(async (t) => {
            await t.run(sql`INSERT INTO probe VALUES (${i})`);
            await sleep(5);
          })
        : db.run(sql`INSERT INTO probe VALUES (${i})`));
    }
    await Promise.all(work);
    expect(await count()).toBe(20);
  });

  test("reads are not held up by an open transaction", async () => {
    let readFinished = false;
    const tx = db.transaction(async (t) => {
      await t.run(sql`INSERT INTO probe VALUES (1)`);
      await sleep(150);
      // WAL lets readers proceed while the write lock is held.
      expect(readFinished).toBe(true);
    });
    await sleep(20);
    await db.all(sql`SELECT * FROM probe`);
    readFinished = true;
    await tx;
  });

  test("a write through the outer handle inside a transaction fails fast and says why", async () => {
    // That write can never succeed — the transaction it runs inside holds the
    // lock it needs. Waiting would hang forever; say so immediately.
    const started = performance.now();
    const err = await db.transaction(async () => {
      await db.run(sql`INSERT INTO probe VALUES (1)`);
    }).then(() => undefined, (e: unknown) => e);
    expect(performance.now() - started).toBeLessThan(1000);
    // drizzle wraps it; the explanation is on the cause.
    expect(causeMessages(err).some(m => m.includes("inside a transaction"))).toBe(true);
  });

  test("a read through the outer handle inside a transaction still works", async () => {
    await db.transaction(async (t) => {
      await t.run(sql`INSERT INTO probe VALUES (1)`);
      await db.all(sql`SELECT * FROM probe`);
    });
    expect(await count()).toBe(1);
  });

  test("waiting past the limit answers DB_BUSY rather than queueing forever", async () => {
    __setWriteWaitLimitForTests(50);
    const tx = db.transaction(async (t) => {
      await t.run(sql`INSERT INTO probe VALUES (1)`);
      await sleep(300);
    });
    await sleep(10);
    const err = await (async () => db.run(sql`INSERT INTO probe VALUES (2)`))().then(() => undefined, (e: unknown) => e);
    // Wrapped by drizzle; the error handler finds it on the cause chain.
    expect(findAppError(err)).toMatchObject({ statusCode: 503, code: "DB_BUSY" });
    await tx;

    // A waiter that gave up must not strand the ones behind it.
    __setWriteWaitLimitForTests(undefined);
    await db.run(sql`INSERT INTO probe VALUES (3)`);
    expect(await count()).toBe(2);
  });
});
