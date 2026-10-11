# M2 workerd spike: streamed body into R2, 500 MiB digest

Milestone M2 of [the registry plan](../../../../../../docs/plan/20261009-2241-lode-registry-server.md)
builds the `BlobStore` on two assumptions listed under *Risks*. This spike
measures both on the real workerd runtime before anything depends on them.

Nothing here is part of the app: no module imports these files, the Worker has
its own `wrangler.toml`, and it is never deployed.

| File | Role |
| --- | --- |
| `worker.ts` | Stateless Worker + one Durable Object, shaped like `src/workers/entry.ts` (the request is rebuilt with a new header set, then crosses `stub.fetch`). Exposes R2 put, multipart and digest routes. |
| `wrangler.toml` | Local config: one Durable Object class, one R2 bucket, same compatibility date and flags as the app. |
| `run.ts` | Boots the Worker with `wrangler dev`, drives every case, prints the tables below. |

## Running it

From the repository root, with dependencies installed:

```bash
bun apps/api/src/modules/registry/spike/run.ts
```

It takes about a minute, listens on `127.0.0.1:8797` (`--port <n>` overrides),
needs roughly 2 GiB of free disk and memory while it runs, and removes its
`.wrangler` state afterwards. `--debug` shows wrangler's output. The exit
code is non-zero when a case that must succeed fails or a digest mismatches.

## Verdicts

- **Q1 — streamed request body into R2 through the Durable Object: works as
  planned.** `Content-Length` survives `stub.fetch`, and
  `bucket.put(key, request.body, { sha256 })` accepts the stream as is.
  No variant is needed as long as the route requires `Content-Length`, which
  the plan already does.
- **Q2 — SHA-256 over a 500 MiB R2 object inside the Durable Object: works as
  planned.** About 3.5 s wall and about 4 s CPU locally (3.9–4.2 s across repeated
  runs), against a 30 s default CPU limit. No fallback is needed.

## Method

The tables are the output of one run; repeated runs stayed within about 10 %
of them (the 500 MiB digest ranged 3.5–3.7 s wall and 3.9–4.2 s CPU).

Measured on 2026-10-10 with wrangler 4.132.0 / workerd 1.20260915.1,
compatibility date 2026-09-01, `nodejs_compat`, Bun 1.4.2 as the client, on an
AMD Ryzen AI Max+ 395 (Linux 7.1). R2 and the Durable Object are wrangler's
local simulators.

- **wall** is measured by the client around the whole request.
- **workerd CPU** is the user + system CPU time of the workerd processes
  (`/proc/<pid>/stat`, 10 ms resolution) consumed while the request ran. Local
  workerd neither exposes per-request CPU time nor enforces a CPU limit, so
  this is the closest available figure. It is an upper bound: it covers both
  workerd processes wrangler starts (its proxy and the runtime) and the R2
  simulator, which runs inside the runtime process and writes to local disk.
- **workerd RSS growth** is the highest summed resident set size sampled every
  20 ms during the request, minus the size before it. It also includes the
  proxy and the simulator, and it is noisy (allocator warm-up shows on the
  first large request), so it bounds buffering rather than measuring the
  isolate's heap.
- Bodies are random bytes; the client computes the expected SHA-256.

## Q1 — streamed body into R2 through the Durable Object

Path under test: client → Worker → `new Request(request, { headers })` →
`stub.fetch` → Durable Object → `bucket.put(key, request.body, { sha256 })`.
"plain" passes `request.body` untouched; "FixedLengthStream" pipes it through
`new FixedLengthStream(declaredSize)` first.

| case | body | Content-Length seen in DO | Transfer-Encoding seen in DO | result | object stored | wall | workerd CPU | workerd RSS growth |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| plain, Content-Length | 1 MiB | 1048576 | absent | 200 stored | yes (1048576 bytes) | 20 ms | 20 ms | 8 MiB |
| plain, Content-Length | 50 MiB | 52428800 | absent | 200 stored | yes (52428800 bytes) | 387 ms | 430 ms | 88 MiB |
| plain, Content-Length | 95 MiB | 99614720 | absent | 200 stored | yes (99614720 bytes) | 684 ms | 750 ms | 25 MiB |
| plain, Content-Length | 95 MiB | 99614720 | absent | 200 stored | yes (99614720 bytes) | 661 ms | 720 ms | 6 MiB |
| plain, Content-Length | 95 MiB | 99614720 | absent | 200 stored | yes (99614720 bytes) | 660 ms | 720 ms | 4 MiB |
| plain, Content-Length | 1024 MiB | 1073741824 | absent | 200 stored | yes (1073741824 bytes) | 7067 ms | 7730 ms | 141 MiB |
| plain, wrong sha256 | 1 MiB | 1048576 | absent | 500 `Error: put: The SHA-256 checksum you specified did not match what we received. You provided a SHA-256 checksum with value: cb26… Actual SHA-256 was: 3927… (10037)` | no | 12 ms | 10 ms | 1 MiB |
| plain, chunked | 1 MiB | absent | chunked | 500 `TypeError: Provided readable stream must have a known length (request/response body or readable half of FixedLengthStream)` | no | 3 ms | 0 ms | 1 MiB |
| FixedLengthStream, chunked | 1 MiB | absent | chunked | 200 stored | yes (1048576 bytes) | 16 ms | 20 ms | 0 MiB |
| plain, chunked | 50 MiB | absent | chunked | 500 same `TypeError` | no | 6 ms | 10 ms | 0 MiB |
| FixedLengthStream, chunked | 50 MiB | absent | chunked | 200 stored | yes (52428800 bytes) | 649 ms | 720 ms | 2 MiB |
| FixedLengthStream, chunked, wrong sha256 | 1 MiB | absent | chunked | 500 same checksum `Error` (10037) | no | 16 ms | 10 ms | 0 MiB |
| FixedLengthStream, chunked, declared size 1 byte short | 1 MiB | absent | chunked | 500 `TypeError: Attempt to write too many bytes through a FixedLengthStream.` | no | 16 ms | 10 ms | 1 MiB |
| FixedLengthStream, chunked, declared size 1 byte long | 1 MiB | absent | chunked | 500 `TypeError: FixedLengthStream did not see all expected bytes before close().` | no | 31 ms | 40 ms | 0 MiB |

Paced upload (8 MiB, 256 KiB every 50 ms, FixedLengthStream): 200 stored in
1620 ms; worst concurrent ping to the same Durable Object: 8 ms.

What the table establishes:

- **Content-Length is preserved across `stub.fetch`**, including through the
  `new Request(request, { headers })` rewrap the app's entry point does. The
  Durable Object saw the exact byte count for 1, 50 and 95 MiB, and R2 took
  the plain request body without complaint. The 64 MiB multipart parts in Q2
  went the same way through `uploadPart`.
- **The body is not buffered.** Three consecutive 95 MiB uploads grew the
  workerd processes by 25, 6 and 4 MiB. The 1024 MiB row exists only for this
  question (it is above the production request cap): a body of that size grew
  them by 141 MiB in total, proxy and R2 simulator included. The 88 MiB on the
  first 50 MiB upload is first-use allocation; it does not recur or scale.
- **R2 rejects a wrong `sha256` and stores nothing**; `put` rejects with an
  `Error` after the body has been consumed. The message text and the `10037`
  code come from the local simulator — treat any rejection of `put` as a
  failed upload instead of matching on the text.
- **Without Content-Length (chunked) the plain path fails**, before any byte
  is read, with the `TypeError` above. The smallest working variant is
  `request.body.pipeTo(fixed.writable)` + `bucket.put(key, fixed.readable, …)`
  with `fixed = new FixedLengthStream(size)`. It still streams, R2 still
  verifies `sha256`, and a body that is one byte shorter or longer than
  declared fails the upload with nothing stored.
- **A streaming upload does not hold the Durable Object.** While a paced
  upload was in flight for 1.6 s, other requests to the same object were
  answered in at most 8 ms.

Recommendation: build the single-request upload and `putPart` on the plain
path, and refuse a request without `Content-Length` up front (the plan's API
table already says "`Content-Length` required") rather than letting R2 throw.
`FixedLengthStream` is the escape hatch if chunked uploads ever have to be
accepted; the declared `size` is already part of the multipart start payload.

Side observation for the implementation: when the Durable Object answered the
chunked request with an error without reading its body, workerd logged
`Uncaught TypeError: Can't read from request stream after response has been
sent.` and wrangler's proxy reported a dropped connection on the following
request (it retried and succeeded). Cancel or drain the request body before
answering an upload early.

## Q2 — SHA-256 over a 500 MiB R2 object

The object is built with R2 multipart: seven 64 MiB parts and one 52 MiB
part, each streamed Worker → Durable Object → `uploadPart(n, request.body)`.

| part | size | Content-Length seen in DO | result | wall | workerd CPU | workerd RSS growth |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 64 MiB | 67108864 | 200 stored | 403 ms | 430 ms | 23 MiB |
| 2 | 64 MiB | 67108864 | 200 stored | 428 ms | 440 ms | 6 MiB |
| 3 | 64 MiB | 67108864 | 200 stored | 397 ms | 430 ms | 13 MiB |
| 4 | 64 MiB | 67108864 | 200 stored | 384 ms | 400 ms | 2 MiB |
| 5 | 64 MiB | 67108864 | 200 stored | 358 ms | 380 ms | 3 MiB |
| 6 | 64 MiB | 67108864 | 200 stored | 401 ms | 420 ms | 0 MiB |
| 7 | 64 MiB | 67108864 | 200 stored | 373 ms | 420 ms | 7 MiB |
| 8 | 52 MiB | 54525952 | 200 stored | 305 ms | 310 ms | 4 MiB |

Completed object: 524288000 bytes; checksums R2 reports for it: `{}`. The
assembled object carries no SHA-256 of its own, which confirms the plan's
premise that the server has to compute it.

The digest was then computed over the stored object in several ways; every
result was compared with the client's SHA-256 of the same bytes.

| path | digest | wall | workerd CPU | workerd RSS growth | worst concurrent ping |
| --- | --- | --- | --- | --- | --- |
| Durable Object, R2 body -> DigestStream (run 1) | matches | 3475 ms | 3920 ms | 158 MiB | 3447 ms |
| Durable Object, R2 body -> DigestStream (run 2) | matches | 3578 ms | 4080 ms | 45 MiB | 3554 ms |
| Durable Object, R2 body -> DigestStream (run 3) | matches | 3605 ms | 4040 ms | 18 MiB | 3580 ms |
| Durable Object, R2 body -> node:crypto createHash | matches | 3208 ms | 3580 ms | 3 MiB | 3182 ms |
| Durable Object, R2 body drained, no hashing | n/a | 2899 ms | 3300 ms | 8 MiB | 2873 ms |
| stateless Worker, R2 body -> DigestStream | matches | 3497 ms | 3960 ms | 12 MiB | 3513 ms |
| Durable Object, 500 MiB of zeros -> DigestStream (no R2) | matches | 243 ms | 250 ms | 64 MiB | 218 ms |
| Durable Object, 500 MiB of zeros -> node:crypto createHash (no R2) | matches | 232 ms | 230 ms | 0 MiB | 207 ms |

Reading the numbers:

- **CPU.** `object.body.pipeTo(new crypto.DigestStream("SHA-256"))` over
  500 MiB cost 3.9–4.1 s of process CPU (up to 4.2 s in other runs). Draining the same object without
  hashing cost 3.3 s, so most of that is the local R2 simulator and stream
  transfer; hashing 500 MiB with no R2 involved cost 0.25 s (about 2 GiB/s).
  The hashing itself is therefore well under 1 s on this host, and even the
  whole 4.2 s upper bound is 14 % of the default limit.
- **Memory.** The object is streamed, not buffered: after the first run the
  processes grew by 18–45 MiB for a 500 MiB object, and the 158 MiB of the
  first run did not accumulate over the following ones.
- **`DigestStream` or incremental hashing**: both work and cost the same
  within noise. `node:crypto` `createHash` (available under `nodejs_compat`)
  is the one that also runs on Bun.

Production limits that apply:

| Limit | Value | Margin from this spike |
| --- | --- | --- |
| CPU time per request | 30 s by default; `limits.cpu_ms` raises it up to 300,000 ms (5 min) on paid plans. The same limits apply to a Durable Object. | ≤ 4.2 s measured, I/O simulation included |
| Memory per isolate | 128 MB | streaming; no growth proportional to the object |
| Request body | 100 MB on Free/Pro (200 MB Business, 500 MB Enterprise) | 95 MiB = 99,614,720 bytes and 64 MiB parts are both under it |

Local workerd enforces none of these (the 1024 MiB upload above went
through), so the figures are a measurement of cost, not a proof of production
behaviour. The plan's M5 smoke run against a deployed preview is where the
500 MiB case is confirmed under real limits. Setting `limits.cpu_ms` is not
required by these numbers.

### Occupancy of the Durable Object during the digest

In the local runtime a concurrent request to the Durable Object waited for
the whole digest (3.4–3.6 s, last column). The same wait appears when the
object is only drained, and when the digest runs in the stateless Worker
instead, so it is not caused by hashing or by the Durable Object: local
workerd serves the Worker, the Durable Object and the disk-backed R2
simulator from one thread, and a read that never has to wait for data never
yields. The paced upload in Q1 shows the object does interleave requests when
the I/O actually waits. Whether a production R2 read yields often enough
cannot be shown locally; measure it in the M5 deployed smoke (ping latency
during a 500 MiB completion).

### Fallbacks

Not needed. For the record, should production disagree:

- **Digest in the stateless Worker** — measured above at the same cost
  (3497 ms wall, 3960 ms CPU). It needs only the bucket binding in the Worker,
  keeps the single-object digest over the whole asset, and moves the work to
  a different isolate from the Durable Object. This is the one to pick.
- **Hash each part as it arrives and verify a digest list** — not measured.
  SHA-256 state cannot be carried from one request to the next with
  `DigestStream` or WebCrypto, so this can only verify per-part digests, not
  the whole-object `sha256` the manifest publishes; it would change the
  multipart contract.
