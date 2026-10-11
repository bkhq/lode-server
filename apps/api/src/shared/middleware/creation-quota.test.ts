import type { AppDatabase } from "@/db";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { createDb } from "@/db";
import { rateLimits } from "@/shared/schema";
import { __resetCreationQuotaForTests, consumeCreationQuota } from "./creation-quota";

let db: AppDatabase;
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(resolve(tmpdir(), "creation-quota-"));
  db = await createDb(resolve(dir, "app.db"));
  __resetCreationQuotaForTests();
});

afterEach(() => {
  __resetCreationQuotaForTests();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const KEY = "issue:minute:user-1";

function req(max: number, key = KEY) {
  return [{ key, windowMs: 60_000, max }];
}

async function stored(key = KEY) {
  return await db.select().from(rateLimits).where(eq(rateLimits.key, key)).get();
}

async function consume(max: number, times: number, key = KEY) {
  let last;
  for (let i = 0; i < times; i++)
    last = await consumeCreationQuota(db, req(max, key));
  return last![0]!;
}

describe("consumeCreationQuota — counting", () => {
  test("counts every request in memory", async () => {
    const result = await consume(100, 5);
    expect(result.count).toBe(5);
  });

  test("windows are independent", async () => {
    const [minute, hour] = await consumeCreationQuota(db, [
      { key: "issue:minute:u", windowMs: 60_000, max: 10 },
      { key: "issue:hour:u", windowMs: 3_600_000, max: 100 },
    ]);
    expect(minute!.count).toBe(1);
    expect(hour!.count).toBe(1);
    expect(minute!.resetAt).toBeLessThan(hour!.resetAt);
  });

  test("an expired window starts over", async () => {
    await consume(100, 3);
    await db.update(rateLimits).set({ resetAt: Date.now() - 1 }).where(eq(rateLimits.key, KEY));
    __resetCreationQuotaForTests();
    expect((await consume(100, 1)).count).toBe(1);
  });
});

describe("consumeCreationQuota — write policy", () => {
  test("holds writes back while the counter is far from its cap", async () => {
    // Under the drift allowance nothing has been written yet.
    await consume(100, 5);
    expect(await stored()).toBeUndefined();
  });

  test("checkpoints once the drift allowance is spent", async () => {
    await consume(100, 8);
    expect((await stored())?.count).toBe(8);
  });

  test("writes on the request that crosses the cap, so the refusal is durable", async () => {
    // A cap below the drift allowance would otherwise never be written.
    const result = await consume(3, 4);
    expect(result.count).toBe(4);
    const row = await stored();
    expect(row?.count).toBe(4);
    expect(row!.count).toBeGreaterThan(3);
  });

  test("stops writing once over the cap — a flood costs a bounded number of writes", async () => {
    await consume(3, 4);
    const afterCrossing = (await stored())!.count;

    // 200 refusals must not move the row: the limiter cannot be turned into
    // a write amplifier by the flood it exists to stop.
    await consume(3, 200);
    expect((await stored())?.count).toBe(afterCrossing);
  });
});

describe("consumeCreationQuota — durability", () => {
  test("a restart keeps refusing, because the crossing write survived it", async () => {
    await consume(3, 4);
    // Dropping the cache is what a process restart or a Durable Object
    // eviction does.
    __resetCreationQuotaForTests();
    expect((await consume(3, 1)).count).toBeGreaterThan(3);
  });

  test("a restart resumes from the checkpoint, not from zero", async () => {
    await consume(100, 8);
    __resetCreationQuotaForTests();
    expect((await consume(100, 1)).count).toBe(9);
  });

  test("a restart forgets at most the drift allowance", async () => {
    await consume(100, 13);
    __resetCreationQuotaForTests();
    // 13 counted, 8 checkpointed: the 5 since the checkpoint are the
    // documented loss.
    expect((await consume(100, 1)).count).toBe(9);
  });

  test("an expired row is not adopted on a cold read", async () => {
    await db.insert(rateLimits).values({ key: KEY, count: 99, resetAt: Date.now() - 1 });
    expect((await consume(100, 1)).count).toBe(1);
  });
});
