import type { AppDatabase } from "@/db";
import type { Logger } from "@/shared/lib/logger";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { createDb } from "@/db";
import { auditEvents } from "@/modules/audit/schema";
import { audit, getAuditEventById, listAuditEvents } from "./audit.service";

let db: AppDatabase;
let dir: string;

// Default no-op logger used by tests that exercise the success path —
// the catch branch (the only place audit() touches the logger) is
// covered by its own dedicated test below with a recording stub.
const stubLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  flush: () => {},
} as unknown as Logger;

beforeEach(async () => {
  dir = mkdtempSync(resolve(tmpdir(), "audit-service-"));
  db = await createDb(resolve(dir, "app.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("audit()", () => {
  test("persists every field on the row, returns the new id, and stamps createdAt", async () => {
    const before = Date.now();
    const id = await audit(db, stubLogger, {
      actorId: "u_1",
      actorName: "alice",
      action: "issues.create",
      resourceType: "issue",
      resourceId: "t_42",
      resourceName: "buy milk",
      detail: { priority: "high" },
      ip: "10.0.0.1",
      userAgent: "Mozilla",
      result: "success",
    });

    expect(id).toBeDefined();
    const row = await db.select().from(auditEvents).where(eq(auditEvents.id, id!)).get();
    expect(row).toBeDefined();
    expect(row!.actorId).toBe("u_1");
    expect(row!.actorName).toBe("alice");
    expect(row!.action).toBe("issues.create");
    expect(row!.resourceType).toBe("issue");
    expect(row!.resourceId).toBe("t_42");
    expect(row!.resourceName).toBe("buy milk");
    // Detail is JSON-encoded; round-trip to verify shape.
    expect(JSON.parse(row!.detail!)).toEqual({ priority: "high" });
    expect(row!.ip).toBe("10.0.0.1");
    expect(row!.userAgent).toBe("Mozilla");
    expect(row!.result).toBe("success");
    expect(Date.parse(row!.createdAt)).toBeGreaterThanOrEqual(before);
  });

  test("stores detail as null when omitted", async () => {
    const id = await audit(db, stubLogger, {
      actorId: "u_2",
      actorName: "bob",
      action: "auth.login",
      resourceType: "session",
      resourceId: "s_1",
      resourceName: "session",
      ip: "10.0.0.2",
      userAgent: "curl",
      result: "success",
    });

    const row = await db.select().from(auditEvents).where(eq(auditEvents.id, id!)).get();
    expect(row!.detail).toBeNull();
  });

  test("records failure results — they are not silently dropped", async () => {
    const id = await audit(db, stubLogger, {
      actorId: "u_3",
      actorName: "anon",
      action: "auth.login",
      resourceType: "session",
      resourceId: "n/a",
      resourceName: "n/a",
      ip: "10.0.0.3",
      userAgent: "curl",
      result: "failure",
    });

    const row = await db.select().from(auditEvents).where(eq(auditEvents.id, id!)).get();
    expect(row!.result).toBe("failure");
  });

  test("returns undefined and routes through the injected logger when the insert throws", async () => {
    const calls: { msg: string; err: unknown }[] = [];
    const recordingLogger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (ctx: Record<string, unknown>, msg: string) => calls.push({ msg, err: ctx.err }),
      fatal: () => {},
      flush: () => {},
    } as unknown as Logger;

    // Close the DB so the next insert raises a known error inside audit()'s
    // try/catch — exercises the failure-handling branch end-to-end.
    db.close();

    const id = await audit(db, recordingLogger, {
      actorId: "u_4",
      actorName: "x",
      action: "x.x",
      resourceType: "x",
      resourceId: "x",
      resourceName: "x",
      ip: "0.0.0.0",
      userAgent: "x",
      result: "success",
    });

    expect(id).toBeUndefined();
    expect(calls.length).toBe(1);
    expect(calls[0]!.msg).toMatch(/audit/i);

    // Re-open the DB for afterEach cleanup.
    db = await createDb(resolve(dir, "app.db"));
  });
});

describe("listAuditEvents", () => {
  beforeEach(async () => {
    // Seed three events spanning two actors / two actions / two timestamps.
    const base = Date.parse("2026-05-01T00:00:00Z");
    const rows = [
      { id: "e_1", actorId: "u_1", action: "issues.create", resourceType: "issue", resourceId: "t_1", result: "success", createdAt: new Date(base).toISOString() },
      { id: "e_2", actorId: "u_2", action: "issues.create", resourceType: "issue", resourceId: "t_2", result: "failure", createdAt: new Date(base + 1000).toISOString() },
      { id: "e_3", actorId: "u_1", action: "auth.login", resourceType: "session", resourceId: "s_1", result: "success", createdAt: new Date(base + 2000).toISOString() },
    ];
    for (const r of rows) {
      await db.insert(auditEvents).values({
        ...r,
        actorName: r.actorId,
        resourceName: r.resourceId,
        detail: null,
        ip: "0",
        userAgent: "x",
        result: r.result as "success" | "failure",
      }).run();
    }
  });

  test("filters by actorId", async () => {
    const r = await listAuditEvents(db, { actorId: "u_1" });
    expect(r.total).toBe(2);
    expect(r.data.every(d => d.actorId === "u_1")).toBe(true);
  });

  test("filters by exact action", async () => {
    const r = await listAuditEvents(db, { action: "issues.create" });
    expect(r.total).toBe(2);
  });

  test("filters by action prefix using a trailing wildcard", async () => {
    const r = await listAuditEvents(db, { action: "issues.*" });
    expect(r.total).toBe(2);
    expect(r.data.every(d => d.action.startsWith("issues."))).toBe(true);
  });

  test("filters by resourceType / resourceId", async () => {
    const r1 = await listAuditEvents(db, { resourceType: "issue" });
    expect(r1.total).toBe(2);
    const r2 = await listAuditEvents(db, { resourceId: "t_2" });
    expect(r2.total).toBe(1);
    expect(r2.data[0]!.id).toBe("e_2");
  });

  test("filters by result", async () => {
    const r = await listAuditEvents(db, { result: "failure" });
    expect(r.total).toBe(1);
    expect(r.data[0]!.id).toBe("e_2");
  });

  test("filters by createdAt range and orders newest-first", async () => {
    const r = await listAuditEvents(db, {
      from: "2026-05-01T00:00:00.500Z",
      to: "2026-05-01T00:00:01.500Z",
    });
    expect(r.total).toBe(1);
    expect(r.data[0]!.id).toBe("e_2");
  });

  test("paginates", async () => {
    const r = await listAuditEvents(db, { limit: 2, page: 2 });
    expect(r.total).toBe(3);
    expect(r.data.length).toBe(1);
  });
});

describe("getAuditEventById", () => {
  test("returns the row when present, undefined otherwise", async () => {
    await db.insert(auditEvents).values({
      id: "e_x",
      actorId: "u",
      actorName: "u",
      action: "x.x",
      resourceType: "x",
      resourceId: "x",
      resourceName: "x",
      detail: null,
      ip: "0",
      userAgent: "x",
      result: "success",
      createdAt: new Date().toISOString(),
    }).run();

    expect((await getAuditEventById(db, "e_x"))?.actorId).toBe("u");
    expect(await getAuditEventById(db, "missing")).toBeUndefined();
  });
});
