import type { Attributes, LogEvent, MetricPoint } from "./observe.otlp";
import type { AppDatabase } from "@/db";
import { and, count, desc, eq, lt, sql } from "drizzle-orm";
import { nanoid } from "@/shared/lib/id";
import { registryInstanceEvents, registryInstances } from "./schema";

/** Report interval assumed for an instance that does not state one (`lode.report.interval`). */
export const DEFAULT_INTERVAL_SECONDS = 300;
/** An instance is offline once it has been silent for this many intervals. */
const OFFLINE_AFTER_INTERVALS = 3;
const MAX_ID_LENGTH = 128;
const MAX_TEXT_LENGTH = 256;
const MAX_ATTRIBUTES_BYTES = 4096;
const MAX_METRICS_BYTES = 16 * 1024;
const MAX_BODY_LENGTH = 4096;
/** Events kept from one resource of one export; the rest are rejected. */
const MAX_EVENTS_PER_RESOURCE = 100;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DELETE_BATCH = 5000;

/** The identity of a reported resource: `service.instance.id`, else `host.name`. */
export function instanceIdOf(resource: Attributes): string | undefined {
  const id = resource["service.instance.id"] ?? resource["host.name"];
  if (id === undefined || id === "")
    return undefined;
  return String(id).slice(0, MAX_ID_LENGTH);
}

function text(value: unknown): string | null {
  return value === undefined || value === "" ? null : String(value).slice(0, MAX_TEXT_LENGTH);
}

/** `value` as JSON, dropping keys from the end until it fits `max` bytes. */
function boundedJson(value: Record<string, unknown>, max: number): string {
  const entries = Object.entries(value);
  while (entries.length > 0) {
    const json = JSON.stringify(Object.fromEntries(entries));
    if (new TextEncoder().encode(json).length <= max)
      return json;
    entries.pop();
  }
  return "{}";
}

/** The status a `lode.app.status` gauge names: the point whose value is 1. */
function statusOf(metrics: Record<string, MetricPoint[]>): string | null {
  const point = metrics["lode.app.status"]?.find(p => p.value === 1);
  return text(point?.attributes.status);
}

function intervalOf(resource: Attributes): number | null {
  const n = Number(resource["lode.report.interval"]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

interface InstanceUpdate {
  readonly metrics?: Record<string, MetricPoint[]>;
}

/**
 * Create or refresh the instance `resource` describes. False when it names no
 * instance, or is a new instance of a package already at `maxInstances`.
 */
async function touchInstance(db: AppDatabase, packageId: string, resource: Attributes, now: string, maxInstances: number, update: InstanceUpdate): Promise<string | undefined> {
  const instanceId = instanceIdOf(resource);
  if (instanceId === undefined)
    return undefined;
  const known = await db.select({ id: registryInstances.instanceId }).from(registryInstances).where(and(eq(registryInstances.packageId, packageId), eq(registryInstances.instanceId, instanceId))).get();
  if (!known) {
    const row = await db.select({ n: count() }).from(registryInstances).where(eq(registryInstances.packageId, packageId)).get();
    if ((row?.n ?? 0) >= maxInstances)
      return undefined;
  }
  const fields = {
    version: text(resource["service.version"]),
    hostName: text(resource["host.name"]),
    osType: text(resource["os.type"]),
    hostArch: text(resource["host.arch"]),
    lodeVersion: text(resource["lode.version"]),
    intervalSeconds: intervalOf(resource),
    attributes: boundedJson(resource, MAX_ATTRIBUTES_BYTES),
    lastSeenAt: now,
    ...(update.metrics && { metrics: boundedJson(update.metrics, MAX_METRICS_BYTES), status: statusOf(update.metrics) }),
  };
  await db.insert(registryInstances)
    .values({ packageId, instanceId, firstSeenAt: now, ...fields })
    .onConflictDoUpdate({ target: [registryInstances.packageId, registryInstances.instanceId], set: fields })
    .run();
  return instanceId;
}

/** Record one resource's metrics. False when the resource is refused (see `touchInstance`). */
export async function recordMetrics(db: AppDatabase, packageId: string, resource: Attributes, metrics: Record<string, MetricPoint[]>, now: string, maxInstances: number): Promise<boolean> {
  return await touchInstance(db, packageId, resource, now, maxInstances, { metrics }) !== undefined;
}

/**
 * Record one resource's log records as events, the first
 * `MAX_EVENTS_PER_RESOURCE` of them. Returns how many were stored, or
 * undefined when the resource is refused (see `touchInstance`).
 */
export async function recordEvents(db: AppDatabase, packageId: string, resource: Attributes, events: readonly LogEvent[], now: string, maxInstances: number): Promise<number | undefined> {
  const instanceId = await touchInstance(db, packageId, resource, now, maxInstances, {});
  if (instanceId === undefined)
    return undefined;
  const kept = events.slice(0, MAX_EVENTS_PER_RESOURCE);
  if (kept.length === 0)
    return 0;
  const version = text(resource["service.version"]);
  await db.insert(registryInstanceEvents).values(kept.map(e => ({
    id: nanoid(),
    packageId,
    instanceId,
    name: e.name.slice(0, MAX_TEXT_LENGTH),
    version,
    body: e.body === null ? null : e.body.slice(0, MAX_BODY_LENGTH),
    attributes: boundedJson(e.attributes, MAX_ATTRIBUTES_BYTES),
    at: e.at ?? now,
  }))).run();
  return kept.length;
}

export interface InstanceView {
  readonly instance_id: string;
  readonly version: string | null;
  readonly status: string | null;
  readonly host_name: string | null;
  readonly os_type: string | null;
  readonly host_arch: string | null;
  readonly lode_version: string | null;
  readonly interval_seconds: number;
  readonly online: boolean;
  readonly attributes: Record<string, unknown>;
  readonly metrics: Record<string, unknown>;
  readonly first_seen_at: string;
  readonly last_seen_at: string;
}

/** A package's instances, most recently seen first. */
export async function listInstances(db: AppDatabase, packageId: string, now = Date.now()): Promise<InstanceView[]> {
  const rows = await db.select().from(registryInstances).where(eq(registryInstances.packageId, packageId)).orderBy(desc(registryInstances.lastSeenAt)).all();
  return rows.map((row) => {
    const interval = row.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS;
    return {
      instance_id: row.instanceId,
      version: row.version,
      status: row.status,
      host_name: row.hostName,
      os_type: row.osType,
      host_arch: row.hostArch,
      lode_version: row.lodeVersion,
      interval_seconds: interval,
      online: row.status !== "stopped" && now - Date.parse(row.lastSeenAt) <= OFFLINE_AFTER_INTERVALS * interval * 1000,
      attributes: JSON.parse(row.attributes) as Record<string, unknown>,
      metrics: JSON.parse(row.metrics) as Record<string, unknown>,
      first_seen_at: row.firstSeenAt,
      last_seen_at: row.lastSeenAt,
    };
  });
}

export interface EventView {
  readonly id: string;
  readonly instance_id: string;
  readonly name: string;
  readonly version: string | null;
  readonly body: string | null;
  readonly attributes: Record<string, unknown>;
  readonly at: string;
}

/** A package's events, newest first, strictly before `before` when given. */
export async function listEvents(db: AppDatabase, packageId: string, opts: { before?: string | undefined; limit: number }): Promise<EventView[]> {
  const rows = await db.select().from(registryInstanceEvents).where(and(eq(registryInstanceEvents.packageId, packageId), opts.before === undefined ? undefined : lt(registryInstanceEvents.at, opts.before))).orderBy(desc(registryInstanceEvents.at)).limit(opts.limit).all();
  return rows.map(row => ({
    id: row.id,
    instance_id: row.instanceId,
    name: row.name,
    version: row.version,
    body: row.body,
    attributes: JSON.parse(row.attributes) as Record<string, unknown>,
    at: row.at,
  }));
}

/**
 * Drop events older than `retentionDays`, and instances not seen for as long.
 * No-op when retention is 0. Returns how many rows went.
 */
export async function pruneObservations(db: AppDatabase, retentionDays: number, now = Date.now()): Promise<number> {
  if (retentionDays <= 0)
    return 0;
  const cutoff = new Date(now - retentionDays * MS_PER_DAY).toISOString();
  let total = 0;
  while (true) {
    const res = await db.run(sql`DELETE FROM registry_instance_events WHERE id IN (SELECT id FROM registry_instance_events WHERE at < ${cutoff} LIMIT ${DELETE_BATCH})`);
    const affected = res.rowsAffected ?? 0;
    total += affected;
    if (affected < DELETE_BATCH)
      break;
  }
  const res = await db.delete(registryInstances).where(lt(registryInstances.lastSeenAt, cutoff)).run();
  return total + (res.rowsAffected ?? 0);
}
