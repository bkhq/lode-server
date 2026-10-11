import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface EncryptionMeta {
  readonly masterPublicKey: string;
  readonly encryptedDek: string;
  readonly dekVersion: number;
  readonly initializedAt: string;
  /** Hex-encoded PBKDF2 salt for password-based key derivation. */
  readonly kdfSalt: string | null;
}

/** Derive the meta.db path from the main database path. */
export function metaDbPath(dbPath: string): string {
  return `${dirname(dbPath)}/meta.db`;
}

/** Open (or create) the unencrypted meta database. */
function openMetaDb(dbPath: string): Database {
  const path = metaDbPath(dbPath);
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const db = new Database(path, { create: true });
  chmodSync(path, 0o600);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS encryption_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);
  return db;
}

/** Read the encryption metadata from meta.db. Returns null if not initialized. */
export function readEncryptionMeta(dbPath: string): EncryptionMeta | null {
  const db = openMetaDb(dbPath);
  try {
    const rows = db.prepare("SELECT key, value FROM encryption_meta").all() as { key: string; value: string }[];
    if (rows.length === 0)
      return null;

    const map = new Map(rows.map(r => [r.key, r.value]));
    const masterPublicKey = map.get("master_public_key");
    const encryptedDek = map.get("encrypted_dek");
    if (!masterPublicKey || !encryptedDek)
      return null;

    return {
      masterPublicKey,
      encryptedDek,
      dekVersion: Number(map.get("dek_version") ?? 1),
      initializedAt: map.get("initialized_at") ?? "",
      kdfSalt: map.get("kdf_salt") ?? null,
    };
  }
  finally {
    db.close();
  }
}

/** Write encryption metadata to meta.db. */
export function writeEncryptionMeta(dbPath: string, meta: EncryptionMeta): void {
  const db = openMetaDb(dbPath);
  try {
    const upsert = db.prepare(
      "INSERT INTO encryption_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    const tx = db.transaction(() => {
      upsert.run("master_public_key", meta.masterPublicKey);
      upsert.run("encrypted_dek", meta.encryptedDek);
      upsert.run("dek_version", String(meta.dekVersion));
      upsert.run("initialized_at", meta.initializedAt);
      if (meta.kdfSalt) {
        upsert.run("kdf_salt", meta.kdfSalt);
      }
    });
    tx();
  }
  finally {
    db.close();
  }
}
