#!/usr/bin/env bun
/* eslint-disable no-console */
/**
 * Runner for the M2 workerd spike. Boots `worker.ts` in workerd through
 * `wrangler dev`, drives the upload and digest paths, and prints the
 * measurements as Markdown. See README.md for the questions and the results.
 *
 * Usage (from the repository root):
 *   bun apps/api/src/modules/registry/spike/run.ts
 */
import type { Subprocess } from "bun";
import { Buffer } from "node:buffer";
import { randomFillSync } from "node:crypto";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

// Flags instead of environment variables: `--port <n>` and `--debug`.
const portFlag = process.argv.indexOf("--port");
const PORT = portFlag === -1
  ? 8797
  : Number(process.argv[portFlag + 1]);
const DEBUG = process.argv.includes("--debug");
const BASE = `http://127.0.0.1:${PORT}`;
const MIB = 1024 * 1024;
const PART_SIZE = 64 * MIB;
const LARGE_SIZE = 500 * MIB;
const HERE = new URL(".", import.meta.url).pathname;
const API_DIR = new URL("../../../../", import.meta.url).pathname;

interface Reply {
  status: number;
  body: {
    seen?: { where: string; contentLength: string | null; transferEncoding: string | null };
    error?: string;
    [key: string]: unknown;
  };
}

interface Sample {
  wallMs: number;
  /** CPU time the workerd processes consumed while the step ran. */
  cpuMs: number;
  /** Highest summed resident set size seen while the step ran, minus the size before it. */
  rssGrowthMiB: number;
}

function sha256(data: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

function randomBytes(size: number): Buffer {
  return randomFillSync(Buffer.allocUnsafe(size));
}

/**
 * A request body with no known length: fetch sends it chunked. `delayMs`
 * paces the chunks, standing in for a slow client.
 */
function chunked(data: Uint8Array, delayMs = 0): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (delayMs > 0) {
        await sleep(delayMs);
      }
      const end = Math.min(offset + 256 * 1024, data.length);
      controller.enqueue(data.subarray(offset, end));
      offset = end;
      if (offset === data.length) {
        controller.close();
      }
    },
  });
}

async function call(method: string, path: string, body?: Uint8Array | ReadableStream<Uint8Array> | string): Promise<Reply> {
  const res = await fetch(`${BASE}${path}`, { method, body, duplex: "half" } as unknown as RequestInit);
  const text = await res.text();
  try {
    return {
      status: res.status,
      body: JSON.parse(text) as Reply["body"],
    };
  }
  catch {
    return {
      status: res.status,
      body: {
        error: text.slice(0, 300),
      },
    };
  }
}

// --- process accounting -----------------------------------------------------

function procStat(pid: number): { comm: string; ppid: number; cpuTicks: number } | undefined {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const comm = raw.slice(raw.indexOf("(") + 1, raw.lastIndexOf(")"));
    const rest = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    return {
      comm,
      ppid: Number(rest[1]),
      cpuTicks: Number(rest[11]) + Number(rest[12]),
    };
  }
  catch {
    return undefined;
  }
}

/** Every workerd process descended from the `wrangler dev` process. */
function workerdPids(root: number): number[] {
  const all = readdirSync("/proc").filter(name => /^\d+$/.test(name)).map(Number);
  const stats = new Map(all.map(pid => [
    pid,
    procStat(pid),
  ] as const));
  const descends = (pid: number): boolean => {
    for (let p = stats.get(pid)?.ppid; p !== undefined && p > 1; p = stats.get(p)?.ppid) {
      if (p === root) {
        return true;
      }
    }
    return false;
  };
  return all.filter(pid => stats.get(pid)?.comm === "workerd" && descends(pid));
}

let pids: number[] = [];

// Linux reports process times in clock ticks of 10 ms.
function cpuMs(): number {
  return pids.reduce((sum, pid) => sum + (procStat(pid)?.cpuTicks ?? 0), 0) * 10;
}

function rssMiB(): number {
  let kb = 0;
  for (const pid of pids) {
    try {
      kb += Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0);
    }
    catch {
      // process gone
    }
  }
  return kb / 1024;
}

async function measure<T>(step: () => Promise<T>): Promise<{ result: T; sample: Sample }> {
  const rssBefore = rssMiB();
  let rssPeak = rssBefore;
  const timer = setInterval(() => {
    rssPeak = Math.max(rssPeak, rssMiB());
  }, 20);
  const cpuBefore = cpuMs();
  const started = performance.now();
  try {
    const result = await step();
    const wallMs = performance.now() - started;
    rssPeak = Math.max(rssPeak, rssMiB());
    return {
      result,
      sample: { wallMs, cpuMs: cpuMs() - cpuBefore, rssGrowthMiB: rssPeak - rssBefore },
    };
  }
  finally {
    clearInterval(timer);
  }
}

// --- reporting --------------------------------------------------------------

function table(headers: string[], rows: (string | number)[][]): void {
  console.log(`| ${headers.join(" | ")} |`);
  console.log(`| ${headers.map(() => "---").join(" | ")} |`);
  for (const row of rows) {
    console.log(`| ${row.join(" | ")} |`);
  }
  console.log("");
}

const ms = (n: number): string => `${Math.round(n)} ms`;
const mib = (n: number): string => `${Math.round(n)} MiB`;
function outcome(r: Reply): string {
  return r.status === 200
    ? "200 stored"
    : `${r.status} ${(r.body.error ?? "").replaceAll("\n", " ")}`;
}

/**
 * Runs `step` while repeatedly asking the Durable Object for a trivial
 * answer; the worst latency shows whether the object stays responsive.
 */
async function withPings<T>(step: () => Promise<T>): Promise<{ result: T; worstPingMs: number }> {
  const state = { busy: true };
  let worstPingMs = 0;
  const pinger = (async () => {
    while (state.busy) {
      const started = performance.now();
      await call("GET", "/ping");
      worstPingMs = Math.max(worstPingMs, performance.now() - started);
      await sleep(25);
    }
  })();
  // The ping in flight when the step ends is the one that waited longest.
  const stop = async (): Promise<number> => {
    state.busy = false;
    await pinger;
    return worstPingMs;
  };
  try {
    return { result: await step(), worstPingMs: await stop() };
  }
  catch (err) {
    await stop();
    throw err;
  }
}

let failures = 0;

function expect(cond: boolean, message: string): void {
  if (!cond) {
    failures++;
    console.error(`UNEXPECTED: ${message}`);
  }
}

// --- Q1: streamed request body into R2 through the Durable Object ------------

async function uploads(): Promise<void> {
  console.log("## Q1 — streamed body into R2 through the Durable Object\n");
  const rows: (string | number)[][] = [];

  const put = async (label: string, key: string, data: Uint8Array, opts: { digest?: string; stream?: boolean; mode?: string; size?: number }): Promise<Reply> => {
    const query = new URLSearchParams({
      key,
      sha256: opts.digest ?? sha256(data),
      mode: opts.mode ?? "plain",
      size: String(opts.size ?? data.length),
    });
    const { result, sample } = await measure(() => call("PUT", `/put?${query}`, opts.stream
      ? chunked(data)
      : data));
    const head = await call("GET", `/head?key=${key}`);
    rows.push([
      label,
      mib(data.length / MIB),
      result.body.seen?.contentLength ?? "absent",
      result.body.seen?.transferEncoding ?? "absent",
      outcome(result),
      head.body.exists
        ? `yes (${head.body.size} bytes)`
        : "no",
      ms(sample.wallMs),
      ms(sample.cpuMs),
      mib(sample.rssGrowthMiB),
    ]);
    await call("DELETE", `/object?key=${key}`);
    return result;
  };

  // 1024 MiB is above the production request cap; it is here because a body
  // that large makes buffering visible in the memory column.
  for (const size of [1, 50, 95, 95, 95, 1024]) {
    const data = randomBytes(size * MIB);
    const res = await put(`plain, Content-Length`, `q1/plain-${size}`, data, {});
    expect(res.status === 200, `plain ${size} MiB upload returned ${res.status} ${res.body.error ?? ""}`);
    expect(res.body.seen?.contentLength === String(data.length), `Content-Length was ${res.body.seen?.contentLength} for ${size} MiB`);
  }

  const small = randomBytes(MIB);
  const wrong = sha256(randomBytes(32));
  const bad = await put("plain, wrong sha256", "q1/wrong-digest", small, { digest: wrong });
  expect(bad.status !== 200, "R2 accepted a wrong sha256");

  for (const size of [1, 50]) {
    const data = size === 1
      ? small
      : randomBytes(size * MIB);
    await put("plain, chunked", `q1/chunked-plain-${size}`, data, { stream: true });
    const fixed = await put("FixedLengthStream, chunked", `q1/chunked-fixed-${size}`, data, { stream: true, mode: "fixed" });
    expect(fixed.status === 200, `FixedLengthStream ${size} MiB upload returned ${fixed.status} ${fixed.body.error ?? ""}`);
  }
  await put("FixedLengthStream, chunked, wrong sha256", "q1/fixed-wrong-digest", small, { stream: true, mode: "fixed", digest: wrong });
  await put("FixedLengthStream, chunked, declared size 1 byte short", "q1/fixed-short", small, { stream: true, mode: "fixed", size: small.length - 1 });
  await put("FixedLengthStream, chunked, declared size 1 byte long", "q1/fixed-long", small, { stream: true, mode: "fixed", size: small.length + 1 });

  table(
    [
      "case",
      "body",
      "Content-Length seen in DO",
      "Transfer-Encoding seen in DO",
      "result",
      "object stored",
      "wall",
      "workerd CPU",
      "workerd RSS growth",
    ],
    rows,
  );

  // A paced upload takes real time without being CPU-bound, so it shows
  // whether an in-flight streaming request holds the object.
  const paced = randomBytes(8 * MIB);
  const query = new URLSearchParams({
    key: "q1/paced",
    sha256: sha256(paced),
    mode: "fixed",
    size: String(paced.length),
  });
  const started = performance.now();
  const { result, worstPingMs } = await withPings(() => call("PUT", `/put?${query}`, chunked(paced, 50)));
  expect(result.status === 200, `paced upload returned ${result.status} ${result.body.error ?? ""}`);
  console.log(`Paced upload (8 MiB, 256 KiB every 50 ms, FixedLengthStream): ${outcome(result)} in ${ms(performance.now() - started)}; worst concurrent ping to the same Durable Object: ${ms(worstPingMs)}\n`);
  await call("DELETE", "/object?key=q1/paced");
}

// --- Q2: SHA-256 over a 500 MiB multipart object ------------------------------

async function largeDigest(): Promise<void> {
  console.log("## Q2 — SHA-256 over a 500 MiB R2 object\n");
  const key = "q2/large";

  const created = await call("POST", `/mpu/create?key=${key}`);
  const uploadId = String(created.body.uploadId);
  const hasher = new Bun.CryptoHasher("sha256");
  const parts: unknown[] = [];
  const partRows: (string | number)[][] = [];
  for (let offset = 0, n = 1; offset < LARGE_SIZE; offset += PART_SIZE, n++) {
    const data = randomBytes(Math.min(PART_SIZE, LARGE_SIZE - offset));
    hasher.update(data);
    const { result, sample } = await measure(() => call("PUT", `/mpu/part?key=${key}&uploadId=${uploadId}&part=${n}`, data));
    expect(result.status === 200, `part ${n} returned ${result.status} ${result.body.error ?? ""}`);
    parts.push(result.body.part);
    partRows.push([
      n,
      mib(data.length / MIB),
      result.body.seen?.contentLength ?? "absent",
      outcome(result),
      ms(sample.wallMs),
      ms(sample.cpuMs),
      mib(sample.rssGrowthMiB),
    ]);
  }
  const expected = hasher.digest("hex");
  const completed = await call("POST", `/mpu/complete?key=${key}&uploadId=${uploadId}`, JSON.stringify(parts));
  expect(completed.status === 200 && completed.body.size === LARGE_SIZE, `complete returned ${completed.status} ${JSON.stringify(completed.body)}`);

  console.log("Multipart upload, 64 MiB parts, each part streamed Worker -> Durable Object -> `uploadPart`:\n");
  table([
    "part",
    "size",
    "Content-Length seen in DO",
    "result",
    "wall",
    "workerd CPU",
    "workerd RSS growth",
  ], partRows);
  console.log(`Completed object: ${completed.body.size} bytes; checksums R2 reports for it: ${JSON.stringify(completed.body.checksums)}\n`);

  const rows: (string | number)[][] = [];
  const run = async (label: string, path: string, want: string | null): Promise<void> => {
    const { result: { result, sample }, worstPingMs: worstPing } = await withPings(() => measure(() => call("GET", path)));
    expect(result.status === 200, `${label} returned ${result.status} ${result.body.error ?? ""}`);
    expect(result.body.sha256 === want, `${label} digest was ${result.body.sha256}, expected ${want}`);
    rows.push([
      label,
      want === null
        ? "n/a"
        : result.body.sha256 === want
          ? "matches"
          : "MISMATCH",
      ms(sample.wallMs),
      ms(sample.cpuMs),
      mib(sample.rssGrowthMiB),
      ms(worstPing),
    ]);
  };

  const zeroDigest = sha256(new Uint8Array(LARGE_SIZE));
  for (let i = 1; i <= 3; i++) {
    await run(`Durable Object, R2 body -> DigestStream (run ${i})`, `/digest?key=${key}`, expected);
  }
  await run("Durable Object, R2 body -> node:crypto createHash", `/digest?key=${key}&impl=node`, expected);
  await run("Durable Object, R2 body drained, no hashing", `/digest?key=${key}&impl=none`, null);
  await run("stateless Worker, R2 body -> DigestStream", `/digest?key=${key}&via=worker`, expected);
  await run("Durable Object, 500 MiB of zeros -> DigestStream (no R2)", `/hash?size=${LARGE_SIZE}`, zeroDigest);
  await run("Durable Object, 500 MiB of zeros -> node:crypto createHash (no R2)", `/hash?size=${LARGE_SIZE}&impl=node`, zeroDigest);

  table([
    "path",
    "digest",
    "wall",
    "workerd CPU",
    "workerd RSS growth",
    "worst concurrent ping",
  ], rows);
  await call("DELETE", `/object?key=${key}`);
}

// --- boot ---------------------------------------------------------------------

async function waitForBoot(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/ping`)).ok) {
        return;
      }
    }
    catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(`spike worker did not answer within ${timeoutMs}ms`);
}

async function main(): Promise<void> {
  rmSync(`${HERE}.wrangler`, { recursive: true, force: true });
  const dev: Subprocess = Bun.spawn(
    [
      `${API_DIR}node_modules/.bin/wrangler`,
      "dev",
      "--config",
      "wrangler.toml",
      "--port",
      String(PORT),
      "--ip",
      "127.0.0.1",
    ],
    {
      cwd: HERE,
      env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
      stdout: DEBUG ? "inherit" : "ignore",
      stderr: DEBUG ? "inherit" : "ignore",
    },
  );
  try {
    await waitForBoot(120_000);
    pids = workerdPids(dev.pid);
    const cpu = /model name\s*:\s*(.+)/.exec(readFileSync("/proc/cpuinfo", "utf8"))?.[1] ?? "unknown";
    console.log(`Host CPU: ${cpu}; workerd processes measured: ${pids.length}\n`);
    await uploads();
    await largeDigest();
  }
  finally {
    dev.kill();
    await dev.exited;
    rmSync(`${HERE}.wrangler`, { recursive: true, force: true });
  }
  process.exit(failures === 0
    ? 0
    : 1);
}

void main();
