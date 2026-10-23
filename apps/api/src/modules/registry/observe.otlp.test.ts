import { describe, expect, test } from "bun:test";
import { attributes, readLogs, readMetrics } from "./observe.otlp";

const resource = {
  attributes: [
    { key: "service.name", value: { stringValue: "myapp" } },
    { key: "service.version", value: { stringValue: "1.5.0" } },
    { key: "lode.report.interval", value: { intValue: "300" } },
  ],
};

describe("attributes", () => {
  test("reads scalars, int64 strings and nested values", () => {
    expect(attributes([
      { key: "s", value: { stringValue: "x" } },
      { key: "b", value: { boolValue: true } },
      { key: "i", value: { intValue: "42" } },
      { key: "d", value: { doubleValue: 1.5 } },
      { key: "a", value: { arrayValue: { values: [{ stringValue: "y" }] } } },
      { key: "skip", value: {} },
      { value: { stringValue: "no key" } },
    ])).toEqual({ s: "x", b: true, i: 42, d: 1.5, a: "{\"values\":[{\"stringValue\":\"y\"}]}" });
  });
});

describe("readMetrics", () => {
  test("collects gauge and sum points per resource and counts every point", () => {
    const [entry] = readMetrics({
      resourceMetrics: [{
        resource,
        scopeMetrics: [{
          metrics: [
            { name: "lode.app.up", gauge: { dataPoints: [{ asInt: "1" }] } },
            { name: "lode.app.status", gauge: { dataPoints: [{ asInt: "1", attributes: [{ key: "status", value: { stringValue: "running" } }] }] } },
            { name: "lode.app.restarts", sum: { dataPoints: [{ asDouble: 2 }] } },
            { name: "latency", histogram: { dataPoints: [{}, {}] } },
          ],
        }],
      }],
    });
    expect(entry!.resource).toEqual({ "service.name": "myapp", "service.version": "1.5.0", "lode.report.interval": 300 });
    expect(entry!.metrics).toEqual({
      "lode.app.up": [{ value: 1, attributes: {} }],
      "lode.app.status": [{ value: 1, attributes: { status: "running" } }],
      "lode.app.restarts": [{ value: 2, attributes: {} }],
    });
    expect(entry!.points).toBe(5);
  });

  test("an unexpected body reads as nothing", () => {
    expect(readMetrics(null)).toEqual([]);
    expect(readMetrics({ resourceMetrics: "x" })).toEqual([]);
    expect(readMetrics({ resourceMetrics: [{}] })).toEqual([{ resource: {}, metrics: {}, points: 0 }]);
  });
});

describe("readLogs", () => {
  test("names events from eventName, then event.name, then log", () => {
    const [entry] = readLogs({
      resourceLogs: [{
        resource,
        scopeLogs: [{
          logRecords: [
            { eventName: "lode.updated", timeUnixNano: "1760000000000000000", body: { stringValue: "1.4.0 -> 1.5.0" } },
            { attributes: [{ key: "event.name", value: { stringValue: "lode.paused" } }], observedTimeUnixNano: "1760000001000000000" },
            { body: { stringValue: "plain" } },
          ],
        }],
      }],
    });
    expect(entry!.events).toEqual([
      { name: "lode.updated", body: "1.4.0 -> 1.5.0", attributes: {}, at: "2025-10-09T08:53:20.000Z" },
      { name: "lode.paused", body: null, attributes: { "event.name": "lode.paused" }, at: "2025-10-09T08:53:21.000Z" },
      { name: "log", body: "plain", attributes: {}, at: undefined },
    ]);
  });
});
