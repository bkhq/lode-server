import type { AppDatabase } from "@/db";
import { eq, sql } from "drizzle-orm";
import { settings } from "@/modules/settings/schema";

export interface SettingRow {
  readonly key: string;
  readonly value: string;
  readonly updatedBy: string | null;
  readonly updatedAt: string;
}

const SENSITIVE_SUFFIXES = [".secret", ".api_key", ".password", ".client_secret", ".token"];
export const MASKED_VALUE = "******";

export function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_SUFFIXES.some(suffix => lower.endsWith(suffix));
}

export async function getSetting(db: AppDatabase, key: string): Promise<string | null> {
  const row = await db.select().from(settings).where(eq(settings.key, key)).get();
  if (!row)
    return null;
  return row.value;
}

export async function getSettings(db: AppDatabase, prefix?: string): Promise<SettingRow[]> {
  const rows = prefix
    ? await db.select().from(settings).where(sql`${settings.key} LIKE ${`${prefix}%`} ESCAPE '\\'`).all()
    : await db.select().from(settings).all();
  return rows;
}

export function maskSensitiveValue(row: SettingRow): SettingRow {
  if (isSensitiveKey(row.key)) {
    return { ...row, value: MASKED_VALUE };
  }
  return row;
}

export function maskValue(key: string, value: string): string {
  return isSensitiveKey(key) ? MASKED_VALUE : value;
}

export async function setSetting(
  db: AppDatabase,
  key: string,
  value: string,
  options?: { updatedBy?: string },
): Promise<void> {
  const now = new Date().toISOString();

  await db.insert(settings).values({
    key,
    value,
    updatedBy: options?.updatedBy ?? null,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: settings.key,
    set: {
      value,
      updatedBy: options?.updatedBy ?? null,
      updatedAt: now,
    },
  }).run();
}

export async function deleteSetting(db: AppDatabase, key: string): Promise<boolean> {
  const existing = await db.select().from(settings).where(eq(settings.key, key)).get();
  if (!existing)
    return false;
  await db.delete(settings).where(eq(settings.key, key)).run();
  return true;
}
