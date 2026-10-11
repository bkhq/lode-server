import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __resetMetricsForTests,
  counterAdd,
  gaugeSet,
  histogramObserve,
  renderPrometheus,
} from "./metrics";

beforeEach(() => __resetMetricsForTests());
afterEach(() => __resetMetricsForTests());

describe("counterAdd", () => {
  test("accumulates across calls with the same labels", () => {
    counterAdd("http_requests_total", "Total HTTP requests", 1, { route: "/x" });
    counterAdd("http_requests_total", "Total HTTP requests", 2, { route: "/x" });
    const out = renderPrometheus();
    expect(out).toContain("http_requests_total{route=\"/x\"} 3");
  });

  test("keeps separate buckets per label permutation", () => {
    counterAdd("http_requests_total", "Total HTTP requests", 1, { route: "/x" });
    counterAdd("http_requests_total", "Total HTTP requests", 1, { route: "/y" });
    const out = renderPrometheus();
    expect(out).toContain("http_requests_total{route=\"/x\"} 1");
    expect(out).toContain("http_requests_total{route=\"/y\"} 1");
  });

  test("treats no-label calls as a single unlabelled series", () => {
    counterAdd("auth_failures_total", "Auth failures", 1);
    counterAdd("auth_failures_total", "Auth failures", 1);
    const out = renderPrometheus();
    // Unlabelled lines have no brace block.
    expect(out).toMatch(/^auth_failures_total 2$/m);
  });

  test("ignores re-registration with a different metric type (no crash)", () => {
    counterAdd("twice_total", "Counter form", 5);
    // The second call uses gauge — implementation guards against type
    // confusion by returning early. The original counter value persists.
    gaugeSet("twice_total", "Gauge form", 99);
    const out = renderPrometheus();
    expect(out).toMatch(/^twice_total 5$/m);
  });
});

describe("gaugeSet", () => {
  test("replaces (not adds) the latest value per label set", () => {
    gaugeSet("queue_depth", "Queue depth", 7, { name: "main" });
    gaugeSet("queue_depth", "Queue depth", 3, { name: "main" });
    const out = renderPrometheus();
    expect(out).toContain("queue_depth{name=\"main\"} 3");
    expect(out).not.toContain("queue_depth{name=\"main\"} 7");
  });

  test("supports numeric label values without coercion errors", () => {
    gaugeSet("worker_id", "Worker id gauge", 1, { id: 42 });
    expect(renderPrometheus()).toContain("worker_id{id=\"42\"} 1");
  });
});

describe("histogramObserve", () => {
  test("emits the expected _bucket / _sum / _count families", () => {
    histogramObserve("req_seconds", "Request duration", 0.02);
    histogramObserve("req_seconds", "Request duration", 0.2);
    const out = renderPrometheus();
    expect(out).toContain("# HELP req_seconds Request duration");
    expect(out).toContain("# TYPE req_seconds histogram");
    expect(out).toContain("req_seconds_bucket{le=\"+Inf\"} 2");
    expect(out).toContain("req_seconds_count 2");
    // 0.02 falls under the 0.025 bucket; 0.2 under the 0.25 bucket.
    expect(out).toMatch(/req_seconds_bucket\{le="0\.025"\} 1/);
    expect(out).toMatch(/req_seconds_bucket\{le="0\.25"\} 2/);
  });
});

describe("renderPrometheus", () => {
  test("emits HELP and TYPE lines for every registered metric", () => {
    counterAdd("api_errors_total", "API error count", 1, { code: "500" });
    gaugeSet("encryption_locked", "Lock flag", 0);
    const out = renderPrometheus();
    expect(out).toMatch(/^# HELP api_errors_total API error count$/m);
    expect(out).toMatch(/^# TYPE api_errors_total counter$/m);
    expect(out).toMatch(/^# HELP encryption_locked Lock flag$/m);
    expect(out).toMatch(/^# TYPE encryption_locked gauge$/m);
  });

  test("escapes label values that contain newlines / quotes / backslashes", () => {
    counterAdd("weird_total", "Edge-case labels", 1, { tag: `line1\nline"2\\` });
    const out = renderPrometheus();
    // \n -> \\n, " -> \\\", \ -> \\\\ per Prometheus text format.
    expect(out).toContain("weird_total{tag=\"line1\\nline\\\"2\\\\\"} 1");
  });

  test("output ends with a trailing newline (text format requirement)", () => {
    counterAdd("any_total", "Any", 1);
    expect(renderPrometheus().endsWith("\n")).toBe(true);
  });
});

describe("label cardinality smoke test", () => {
  test("each unique label permutation creates its own series", () => {
    // Defence-in-depth check that the renderer doesn't collapse distinct
    // label sets into a single line. Buckets-per-label-permutation is the
    // primary cost vector for a Prometheus registry so we want to be sure
    // the storage is one-per-key.
    for (let i = 0; i < 8; i++) {
      counterAdd("multi_total", "Multi-label series", 1, { code: `c${i}` });
    }
    const out = renderPrometheus();
    for (let i = 0; i < 8; i++) {
      expect(out).toContain(`multi_total{code="c${i}"} 1`);
    }
  });
});
