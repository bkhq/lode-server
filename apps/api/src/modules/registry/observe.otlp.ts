// Reading OTLP/HTTP JSON exports (opentelemetry-proto, JSON encoding): just
// enough of `ExportMetricsServiceRequest` and `ExportLogsServiceRequest` to
// record what a host reports. Anything malformed inside a well-formed body is
// skipped rather than failing the export.

/** A scalar attribute value; arrays and maps are kept as their JSON text. */
export type AttributeValue = string | number | boolean;

export type Attributes = Record<string, AttributeValue>;

/** One gauge or sum data point. */
export interface MetricPoint {
  readonly value: number;
  readonly attributes: Attributes;
}

/** The metrics one resource exported. */
export interface ResourceMetrics {
  readonly resource: Attributes;
  readonly metrics: Record<string, MetricPoint[]>;
  /** Data points in this resource, for `partialSuccess.rejectedDataPoints`. */
  readonly points: number;
}

/** One log record, read as an event. */
export interface LogEvent {
  readonly name: string;
  readonly body: string | null;
  readonly attributes: Attributes;
  /** ISO time of the record, or undefined when it carries none. */
  readonly at: string | undefined;
}

/** The log records one resource exported. */
export interface ResourceLogs {
  readonly resource: Attributes;
  readonly events: LogEvent[];
}

type Json = Record<string, unknown>;

/** Every OTLP metric type, for counting data points. */
const POINT_KINDS = [
  "gauge",
  "sum",
  "histogram",
  "exponentialHistogram",
  "summary",
] as const;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function list(value: unknown): unknown[] {
  return Array.isArray(value)
    ? value
    : [];
}

/** An `AnyValue` as a scalar. int64 arrives as a string; it is kept a number when it fits. */
function anyValue(value: unknown): AttributeValue | undefined {
  if (!isObject(value))
    return undefined;
  if (typeof value.stringValue === "string")
    return value.stringValue;
  if (typeof value.boolValue === "boolean")
    return value.boolValue;
  if (value.intValue !== undefined) {
    const n = Number(value.intValue);
    return Number.isFinite(n)
      ? n
      : String(value.intValue);
  }
  if (typeof value.doubleValue === "number")
    return value.doubleValue;
  if (value.arrayValue !== undefined || value.kvlistValue !== undefined)
    return JSON.stringify(value.arrayValue ?? value.kvlistValue);
  return undefined;
}

export function attributes(value: unknown): Attributes {
  const out: Attributes = {};
  for (const kv of list(value)) {
    if (!isObject(kv) || typeof kv.key !== "string")
      continue;
    const v = anyValue(kv.value);
    if (v !== undefined)
      out[kv.key] = v;
  }
  return out;
}

function resourceAttributes(entry: Json): Attributes {
  return isObject(entry.resource)
    ? attributes(entry.resource.attributes)
    : {};
}

function pointValue(point: Json): number | undefined {
  if (typeof point.asDouble === "number")
    return point.asDouble;
  if (point.asInt !== undefined) {
    const n = Number(point.asInt);
    return Number.isFinite(n)
      ? n
      : undefined;
  }
  return undefined;
}

/** Nanoseconds since the epoch (a decimal string in OTLP JSON) as an ISO time. */
function isoFromNanos(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "" || value === "0" || value === 0)
    return undefined;
  try {
    const ms = Number(BigInt(String(value)) / 1_000_000n);
    const date = new Date(ms);
    return Number.isNaN(date.getTime())
      ? undefined
      : date.toISOString();
  }
  catch {
    return undefined;
  }
}

/** The resources of an `ExportMetricsServiceRequest`. Only gauges and sums are read. */
export function readMetrics(body: unknown): ResourceMetrics[] {
  if (!isObject(body))
    return [];
  return list(body.resourceMetrics).filter(isObject).map((entry) => {
    const metrics: Record<string, MetricPoint[]> = {};
    let points = 0;
    for (const scope of list(entry.scopeMetrics).filter(isObject)) {
      for (const metric of list(scope.metrics).filter(isObject)) {
        for (const kind of POINT_KINDS) {
          const data = metric[kind];
          if (isObject(data))
            points += list(data.dataPoints).length;
        }
        const data = isObject(metric.gauge)
          ? metric.gauge
          : isObject(metric.sum)
            ? metric.sum
            : undefined;
        if (typeof metric.name !== "string" || data === undefined)
          continue;
        for (const point of list(data.dataPoints).filter(isObject)) {
          const value = pointValue(point);
          if (value !== undefined) {
            (metrics[metric.name] ??= []).push({
              value,
              attributes: attributes(point.attributes),
            });
          }
        }
      }
    }
    return {
      resource: resourceAttributes(entry),
      metrics,
      points,
    };
  });
}

/**
 * The resources of an `ExportLogsServiceRequest`. A record's event name is its
 * `eventName` field, else its `event.name` attribute, else `log`.
 */
export function readLogs(body: unknown): ResourceLogs[] {
  if (!isObject(body))
    return [];
  return list(body.resourceLogs).filter(isObject).map((entry) => {
    const events: LogEvent[] = [];
    for (const scope of list(entry.scopeLogs).filter(isObject)) {
      for (const record of list(scope.logRecords).filter(isObject)) {
        const attrs = attributes(record.attributes);
        const named = typeof record.eventName === "string" && record.eventName !== ""
          ? record.eventName
          : attrs["event.name"];
        const body = anyValue(record.body);
        events.push({
          name: typeof named === "string" && named !== ""
            ? named
            : "log",
          body: body === undefined
            ? null
            : String(body),
          attributes: attrs,
          at: isoFromNanos(record.timeUnixNano) ?? isoFromNanos(record.observedTimeUnixNano),
        });
      }
    }
    return {
      resource: resourceAttributes(entry),
      events,
    };
  });
}
