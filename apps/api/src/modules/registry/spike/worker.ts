import type {
  DigestStream as DigestStreamClass,
  DurableObjectNamespace,
  DurableObjectState,
  FixedLengthStream as FixedLengthStreamClass,
  R2Bucket,
  R2UploadedPart,
} from "@cloudflare/workers-types";
import { createHash } from "node:crypto";

/**
 * Spike worker for milestone M2 of the registry plan. Not part of the app:
 * nothing imports it, and it has its own wrangler config next to this file.
 *
 * It mirrors the production request path — a stateless Worker that re-wraps
 * the request with new headers and forwards it to one Durable Object — and
 * exposes the R2 operations the BlobStore will be built on, so `run.ts` can
 * measure them from outside. Every route also runs in the stateless Worker
 * when called with `via=worker`, which is one of the plan's fallbacks.
 */

export interface SpikeEnv {
  SPIKE: DurableObjectNamespace;
  BUCKET: R2Bucket;
}

type Body = ReadableStream<Uint8Array>;

// Workers-only globals; the app's tsconfig types this file against Bun.
const { DigestStream } = crypto as unknown as { DigestStream: typeof DigestStreamClass };
const { FixedLengthStream } = globalThis as unknown as { FixedLengthStream: typeof FixedLengthStreamClass };

const MIB = 1024 * 1024;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * `plain` hands the request body to R2 untouched. `fixed` pipes it through a
 * FixedLengthStream of the declared size first, which gives R2 a known length
 * even when the request carried none.
 */
function uploadBody(request: Request, url: URL): Body {
  const body = request.body as Body;
  if (url.searchParams.get("mode") !== "fixed") {
    return body;
  }
  const fixed = new FixedLengthStream(Number(url.searchParams.get("size")));
  void body.pipeTo(fixed.writable as unknown as WritableStream<Uint8Array>).catch(() => {});
  return fixed.readable as unknown as Body;
}

/** `impl` selects how the stream is consumed; `none` only drains it. */
async function digest(body: Body, impl: string): Promise<string | null> {
  if (impl === "none") {
    const reader = body.getReader();
    while (!(await reader.read()).done) {
      // drained without hashing: the cost of the transfer alone
    }
    return null;
  }
  if (impl === "node") {
    const hash = createHash("sha256");
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      hash.update(value);
    }
    return hash.digest("hex");
  }
  const digester = new DigestStream("SHA-256");
  await body.pipeTo(digester as unknown as WritableStream<Uint8Array>);
  return hex(await digester.digest);
}

/** `size` bytes of zeros, produced without any I/O. */
function zeros(size: number): Body {
  let left = size;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const n = Math.min(left, MIB);
      controller.enqueue(new Uint8Array(n));
      left -= n;
      if (left === 0) {
        controller.close();
      }
    },
  });
}

async function handle(request: Request, env: SpikeEnv, where: "worker" | "do"): Promise<Response> {
  const url = new URL(request.url);
  const key = url.searchParams.get("key") ?? "";
  const route = `${request.method} ${url.pathname}`;
  // What this side of `stub.fetch` was told about the body.
  const seen = {
    where,
    contentLength: request.headers.get("content-length"),
    transferEncoding: request.headers.get("transfer-encoding"),
  };
  const bucket = env.BUCKET;

  try {
    switch (route) {
      case "GET /ping":
        return json({ seen });

      case "PUT /put": {
        const sha256 = url.searchParams.get("sha256");
        const object = await bucket.put(key, uploadBody(request, url) as never, sha256 ? { sha256 } : {});
        return json({ seen, size: object.size, sha256: object.checksums.sha256 ? hex(object.checksums.sha256) : null });
      }

      case "GET /head": {
        const object = await bucket.head(key);
        return json({ seen, exists: object !== null, size: object?.size ?? null });
      }

      case "DELETE /object":
        await bucket.delete(key);
        return json({ seen });

      case "POST /mpu/create": {
        const upload = await bucket.createMultipartUpload(key);
        return json({ seen, uploadId: upload.uploadId });
      }

      case "PUT /mpu/part": {
        const upload = bucket.resumeMultipartUpload(key, url.searchParams.get("uploadId") ?? "");
        const part = await upload.uploadPart(Number(url.searchParams.get("part")), uploadBody(request, url) as never);
        return json({ seen, part });
      }

      case "POST /mpu/complete": {
        const upload = bucket.resumeMultipartUpload(key, url.searchParams.get("uploadId") ?? "");
        const object = await upload.complete(await request.json() as R2UploadedPart[]);
        return json({ seen, size: object.size, checksums: object.checksums.toJSON() });
      }

      case "GET /digest": {
        const object = await bucket.get(key);
        if (!object) {
          return json({ seen, error: "missing object" }, 404);
        }
        const started = Date.now();
        const sha256 = await digest(object.body as unknown as Body, url.searchParams.get("impl") ?? "digeststream");
        return json({ seen, size: object.size, sha256, innerMs: Date.now() - started });
      }

      // The hashing cost alone: no R2, no network.
      case "GET /hash": {
        const size = Number(url.searchParams.get("size"));
        const sha256 = await digest(zeros(size), url.searchParams.get("impl") ?? "digeststream");
        return json({ seen, size, sha256 });
      }

      default:
        return json({ seen, error: `no route ${route}` }, 404);
    }
  }
  catch (err) {
    const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return json({ seen, error }, 500);
  }
}

export class SpikeDurableObject {
  readonly #env: SpikeEnv;

  constructor(_state: DurableObjectState, env: SpikeEnv) {
    this.#env = env;
  }

  async fetch(request: Request): Promise<Response> {
    return handle(request, this.#env, "do");
  }
}

export default {
  async fetch(request: Request, env: SpikeEnv): Promise<Response> {
    if (new URL(request.url).searchParams.get("via") === "worker") {
      return handle(request, env, "worker");
    }
    // Same shape as `workers/entry.ts`: one named object, and the request is
    // rebuilt with a new header set before it crosses `stub.fetch`.
    const stub = env.SPIKE.get(env.SPIKE.idFromName("spike"));
    const headers = new Headers(request.headers);
    headers.set("x-spike-forwarded", "1");
    const forwarded = new Request(request, { headers });
    return stub.fetch(forwarded as never) as unknown as Response;
  },
};
