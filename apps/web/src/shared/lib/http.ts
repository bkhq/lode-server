const BASE_PATH = import.meta.env.BASE_URL.replace(/\/+$/, "");
const BASE_URL = `${BASE_PATH}/api`;

export { BASE_PATH };

export class SystemLockedError extends Error {
  constructor() {
    super("System is locked");
    this.name = "SystemLockedError";
  }
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  /** Server-supplied Retry-After in seconds (parsed from header). */
  readonly retryAfter: number | undefined;
  constructor(message: string, status: number, code?: string, retryAfter?: number) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

type HttpEventType = "unauthorized" | "system-locked";
type HttpEventListener = (type: HttpEventType) => void;

const listeners = new Set<HttpEventListener>();

export function onHttpEvent(listener: HttpEventListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(type: HttpEventType) {
  for (const fn of listeners) fn(type);
}

/**
 * Low-level helper for non-JSON responses (downloads, multipart uploads,
 * SSE). Applies the same defaults `http()` does (credentials, CSRF
 * header on mutating methods, JSON Content-Type unless the body is
 * FormData) and emits the same `unauthorized` / `system-locked` events
 * so the SPA's global handlers fire consistently regardless of which
 * shape the response is.
 *
 * Returns the raw `Response` on success; callers decide how to read the
 * body (`blob()`, `arrayBuffer()`, stream pump, etc.).
 *
 * On failure it parses the JSON envelope when possible (the API uses a
 * uniform `{ success, error: { code, message } }` shape) and throws
 * `HttpError` / `SystemLockedError` exactly like `http()`.
 */
export async function httpRaw(path: string, init?: RequestInit): Promise<Response> {
  const hasBody = init?.body != null;
  const isFormData = init?.body instanceof FormData;
  const method = (init?.method ?? "GET").toUpperCase();
  const isMutating = method !== "GET" && method !== "HEAD";
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(hasBody && !isFormData ? { "Content-Type": "application/json" } : {}),
      ...(isMutating ? { "X-Requested-With": "XMLHttpRequest" } : {}),
      ...init?.headers,
    },
  });

  if (res.ok)
    return res;

  if (res.status === 401) {
    emit("unauthorized");
    throw new HttpError("Unauthorized", 401, "UNAUTHORIZED");
  }
  // Best-effort JSON parse of the error envelope. Non-JSON error bodies
  // (e.g. an upstream proxy 502) fall through with the generic
  // `HTTP <status>` message.
  const body = await res.clone().json().catch(() => ({})) as { error?: { code?: string; message?: string } };
  const errorCode = body.error?.code;

  if (errorCode === "SYSTEM_LOCKED") {
    emit("system-locked");
    throw new SystemLockedError();
  }

  let retryAfter: number | undefined;
  const ra = res.headers.get("retry-after");
  if (ra) {
    const n = Number(ra);
    if (Number.isFinite(n) && n >= 0) {
      retryAfter = n;
    }
    else {
      const t = Date.parse(ra);
      if (!Number.isNaN(t)) {
        retryAfter = Math.max(0, Math.round((t - Date.now()) / 1000));
      }
    }
  }
  throw new HttpError(body.error?.message ?? `HTTP ${res.status}`, res.status, errorCode, retryAfter);
}

export async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await httpRaw(path, init);
  return res.json() as Promise<T>;
}
