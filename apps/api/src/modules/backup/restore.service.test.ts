import type { AppDatabase } from "@/db";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { createDb } from "@/db";
import { accountBackupContribution } from "@/modules/account/account.backup";
import { fileBackupContribution } from "@/modules/file/file.backup";
import { __setLocalDriverRootForTests } from "@/modules/file/storage/local";
import { __resetDriverRegistryForTests, setActiveDriver } from "@/modules/file/storage/registry";
import { settingsBackupContribution } from "@/modules/settings/settings.backup";
import { streamJsonBackup } from "./export.service";
import { __resetBackupRegistryForTests, registerBackupContribution } from "./registry";
import { importJsonBackup, reconcileRestoredFiles, validateBackupData } from "./restore.service";

// The restore service relies on the global backup registry. Each test
// resets and re-registers exactly the contributions it needs so cases
// cannot leak state across the file.
let db: AppDatabase;
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(resolve(tmpdir(), "restore-service-"));
  db = await createDb(resolve(dir, "app.db"));
  __resetBackupRegistryForTests();
  registerBackupContribution(accountBackupContribution);
  registerBackupContribution(settingsBackupContribution);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  __resetBackupRegistryForTests();
});

async function readStreamToString(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done)
      break;
    if (value)
      out += dec.decode(value);
  }
  return out;
}

describe("validateBackupData", () => {
  test("rejects non-object payloads", () => {
    expect(() => validateBackupData(null)).toThrow(/Invalid backup file format/);
    expect(() => validateBackupData("a string")).toThrow(/Invalid backup file format/);
  });

  test("rejects unsupported version numbers", () => {
    expect(() => validateBackupData({ version: 0, modules: ["users"], tables: {} })).toThrow(/Invalid backup version/);
    expect(() => validateBackupData({ version: 999, modules: ["users"], tables: {} })).toThrow(/newer than this build supports/);
  });

  test("rejects empty module list", () => {
    expect(() => validateBackupData({ version: 1, modules: [], tables: {} })).toThrow(/no modules/);
  });

  test("rejects missing tables block", () => {
    expect(() => validateBackupData({ version: 1, modules: ["users"], tables: null })).toThrow(/no table data/);
  });

  test("returns the parsed object on a well-formed payload", () => {
    const ok = validateBackupData({ version: 1, exportedAt: "2026-05-14T00:00:00Z", modules: ["users"], tables: { users: [] } });
    // v1 input is migrated forward to the current format.
    expect(ok.version).toBe(3);
    expect(ok.modules).toEqual(["users"]);
  });
});

describe("importJsonBackup — happy path round-trip", () => {
  test("export → drop tables → restore replays the original rows", async () => {
    // Seed minimal data: one user, one settings row.
    await db.run(sql`INSERT INTO users (id, oauth_sub, username, name, email, role, status, created_at, updated_at) VALUES ('u_1', 'sub_1', 'alice', 'Alice', 'alice@example.com', 'admin', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
    await db.run(sql`INSERT INTO settings (key, value, updated_at) VALUES ('session.max_age', '86400', '2026-01-01T00:00:00Z')`);

    // Export to JSON string.
    const { body } = streamJsonBackup(db, ["users", "settings"]);
    const exported = await readStreamToString(body);
    const parsed = validateBackupData(JSON.parse(exported));

    // Sanity: the export captured what we inserted.
    expect(parsed.tables.users?.length).toBe(1);
    expect(parsed.tables.settings?.length).toBe(1);

    // The import service rewrites every row inside a transaction. Delete
    // first to prove the restore brought them back.
    await db.run(sql`DELETE FROM settings`);
    await db.run(sql`DELETE FROM users`);

    const result = await importJsonBackup(db, parsed);
    expect(result.rowsImported).toBeGreaterThanOrEqual(2);

    const users = await db.all(sql`SELECT id, username FROM users`);
    expect(users).toEqual([{ id: "u_1", username: "alice" }]);
    const settings = await db.all(sql`SELECT key, value FROM settings`);
    expect(settings).toEqual([{ key: "session.max_age", value: "86400" }]);
  });
});

describe("validateBackupData — v1 → v2 migrator", () => {
  test("coerces a null subjectRelation to the sentinel and lifts __meta__ tuples into resource_groups", () => {
    const v2 = validateBackupData({
      version: 1,
      exportedAt: "2026-05-14T00:00:00Z",
      modules: ["policies"],
      tables: {
        relation_tuples: [
          { id: "t1", namespace: "item", objectId: "o1", relation: "viewer", subjectNamespace: "user", subjectId: "u1", subjectRelation: null, createdBy: null, createdAt: "2026-01-01T00:00:00Z" },
          { id: "t2", namespace: "item", objectId: "o1", relation: "viewer", subjectNamespace: "group", subjectId: "g1", subjectRelation: "member", createdBy: null, createdAt: "2026-01-01T00:00:00Z" },
          { id: "m1", namespace: "resource_group", objectId: "rg1", relation: "__meta__", subjectNamespace: "resource_group", subjectId: "Ops", subjectRelation: "the ops group", createdBy: "u1", createdAt: "2026-01-02T00:00:00Z" },
        ],
      },
    });
    expect(v2.version).toBe(3);
    expect(v2.tables.relation_tuples!.map(r => r.subjectRelation)).toEqual(["", "member"]);
    expect(v2.tables.resource_groups).toEqual([
      { id: "rg1", name: "Ops", description: "the ops group", createdBy: "u1", createdAt: "2026-01-02T00:00:00Z" },
    ]);
  });
});

describe("importJsonBackup — error surfaces", () => {
  test("unknown module name is silently skipped (registry resolver ignores missing entries)", async () => {
    const result = await importJsonBackup(db, {
      version: 1,
      exportedAt: "2026-05-14T00:00:00Z",
      modules: ["definitely-not-a-real-module"],
      tables: {},
    });
    expect(result.tablesImported).toBe(0);
    expect(result.rowsImported).toBe(0);
  });

  test("unknown column on a registered table is rejected with INVALID_BACKUP_ROW", async () => {
    let captured: { code?: unknown; statusCode?: unknown } | null = null;
    try {
      await importJsonBackup(db, {
        version: 1,
        exportedAt: "2026-05-14T00:00:00Z",
        modules: ["settings"],
        tables: {
          settings: [
            { key: "x", value: "y", updated_at: "2026-01-01T00:00:00Z", surprise_column: "boom" },
          ],
        },
      });
    }
    catch (err) {
      captured = err as { code?: unknown; statusCode?: unknown };
    }
    expect(captured).not.toBeNull();
    expect(captured?.code).toBe("INVALID_BACKUP_ROW");
    expect(captured?.statusCode).toBe(400);
  });

  test("malformed id field is rejected with INVALID_BACKUP_ROW", async () => {
    // The `id` shape guard refuses characters outside the URL-safe alphabet
    // to keep crafted backup payloads from smuggling SQL meta-chars.
    let captured: { code?: unknown } | null = null;
    try {
      await importJsonBackup(db, {
        version: 1,
        exportedAt: "2026-05-14T00:00:00Z",
        modules: ["users"],
        tables: {
          users: [
            {
              id: "bad id with spaces",
              oauthSub: "sub",
              username: "u",
              name: "u",
              email: "u@x",
              role: "user",
              status: "active",
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
            },
          ],
          groups: [],
          user_preferences: [],
        },
      });
    }
    catch (err) {
      captured = err as { code?: unknown };
    }
    expect(captured?.code).toBe("INVALID_BACKUP_ROW");
  });

  test("transaction rolls back: a bad row in the second table leaves the first table empty too", async () => {
    // The import opens a single transaction across every module/table.
    // When the second insert blows up the first must roll back as well —
    // otherwise a partial restore could leave the system in a state the
    // operator cannot easily diff against the backup file.
    let captured: { code?: unknown } | null = null;
    try {
      await importJsonBackup(db, {
        version: 1,
        exportedAt: "2026-05-14T00:00:00Z",
        modules: ["users", "settings"],
        tables: {
          users: [
            {
              id: "u_ok",
              oauthSub: "sub_ok",
              username: "ok",
              name: "OK",
              email: "ok@example.com",
              role: "user",
              status: "active",
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
            },
          ],
          groups: [],
          user_preferences: [],
          settings: [
            { key: "x", value: "y", updated_at: "2026-01-01T00:00:00Z", ghost_column: "boom" },
          ],
        },
      });
    }
    catch (err) {
      captured = err as { code?: unknown };
    }
    expect(captured?.code).toBe("INVALID_BACKUP_ROW");

    // The transaction must have rolled back the users insert too.
    const rows = await db.all(sql`SELECT id FROM users`);
    expect(rows).toEqual([]);
  });
});

describe("reconcileRestoredFiles — blobs are out of backup scope", () => {
  const present = "a".repeat(64);
  const missing = "b".repeat(64);
  const presentKey = `${present.slice(0, 2)}/${present.slice(2, 4)}/${present}`;
  const missingKey = `${missing.slice(0, 2)}/${missing.slice(2, 4)}/${missing}`;

  beforeEach(async () => {
    registerBackupContribution(fileBackupContribution);
    __resetDriverRegistryForTests();
    const { getActiveDriver } = await import("@/modules/file/storage/registry");
    __setLocalDriverRootForTests(resolve(dir, "blobs"));
    setActiveDriver("local");
    // The "present" blob is physically on disk; the "missing" one is not —
    // simulating a backup restored onto a backend that lacks the bytes.
    await getActiveDriver().put(presentKey, new TextEncoder().encode("real-bytes").buffer);
  });

  afterEach(() => {
    __resetDriverRegistryForTests();
  });

  test("restore quarantines files rows whose backing blob is absent, keeps ones present", async () => {
    await db.run(sql`INSERT INTO users (id, oauth_sub, username, name, email, role, status, created_at, updated_at) VALUES ('u_f', 'sub_f', 'fuser', 'F', 'f@example.com', 'admin', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);

    const result = await importJsonBackup(db, {
      version: 1,
      exportedAt: "2026-05-14T00:00:00Z",
      modules: ["files"],
      tables: {
        users: [
          { id: "u_f", oauthSub: "sub_f", username: "fuser", name: "F", email: "f@example.com", role: "admin", status: "active", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
        ],
        files: [
          { id: "file_present", sha256: present, size: 10, mimetype: "text/plain", storageDriver: "local", storageKey: presentKey, refCount: 1, uploadedBy: "u_f" },
          { id: "file_missing", sha256: missing, size: 10, mimetype: "text/plain", storageDriver: "local", storageKey: missingKey, refCount: 1, uploadedBy: "u_f" },
        ],
        file_references: [],
      },
    });
    expect(result.rowsImported).toBeGreaterThanOrEqual(2);

    const present_ = await db.all<{ id: string; storage_driver: string; ref_count: number }>(
      sql`SELECT id, storage_driver, ref_count FROM files WHERE id = 'file_present'`,
    );
    expect(present_[0]?.storage_driver).toBe("local");
    expect(present_[0]?.ref_count).toBe(1);

    const missing_ = await db.all<{ id: string; storage_driver: string; ref_count: number }>(
      sql`SELECT id, storage_driver, ref_count FROM files WHERE id = 'file_missing'`,
    );
    // Quarantined: row kept (not hard-deleted) but driver flipped to the
    // sentinel + ref_count zeroed so downloads 404 cleanly and the GC skips it.
    expect(missing_).toHaveLength(1);
    expect(missing_[0]?.storage_driver).not.toBe("local");
    expect(missing_[0]?.storage_driver).toContain("quarantined");
    expect(missing_[0]?.ref_count).toBe(0);
  });

  test("reconcileRestoredFiles is a safe no-op when there are no files rows", async () => {
    const r = await reconcileRestoredFiles(db);
    expect(r).toEqual({ checked: 0, quarantined: 0 });
  });
});
