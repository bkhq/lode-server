// Cookie-jar HTTP client for talking to the live API. Tracks Set-Cookie so
// the session cookie issued during the OIDC callback flows into subsequent
// authenticated requests.
import process from "node:process";

export const API_BASE = process.env.E2E_API_BASE ?? "http://127.0.0.1:3010/app";
export const DEX_BASE = process.env.E2E_DEX_BASE ?? "http://127.0.0.1:5566/dex";

const RE_COOKIE_KV = /^([^=]+)=([^;]+)/;

export class CookieJar {
  private store = new Map<string, string>();

  capture(res: Response): void {
    const setCookies = res.headers.getSetCookie();
    for (const raw of setCookies) {
      const match = RE_COOKIE_KV.exec(raw);
      if (!match)
        continue;
      const [, k, v] = match;
      if (!k)
        continue;
      // Browsers drop the cookie on Max-Age=0 / past Expires, but for our
      // tests treating an empty value the same way is sufficient.
      if (v === "" || v === "deleted") {
        this.store.delete(k);
      }
      else {
        this.store.set(k, v ?? "");
      }
    }
  }

  header(): string {
    return [...this.store.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  has(name: string): boolean {
    return this.store.has(name);
  }

  reset(): void {
    this.store.clear();
  }
}

export interface ApiOptions {
  readonly method?: string;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  readonly redirect?: RequestRedirect;
  readonly raw?: boolean;
  readonly formData?: FormData;
}

export class ApiClient {
  readonly cookies = new CookieJar();
  readonly base: string;

  constructor(base: string = API_BASE) {
    this.base = base;
  }

  async raw(path: string, opts: ApiOptions = {}): Promise<Response> {
    const method = (opts.method ?? "GET").toUpperCase();
    const isMutating = method !== "GET" && method !== "HEAD";
    // Default Origin matches the API base so csrfGuard's Origin check (active
    // when CORS_ORIGIN is set on the API) accepts the request. Tests that
    // exercise the Origin-mismatch branch override via opts.headers.
    const originHost = new URL(this.base).origin;
    const headers: Record<string, string> = {
      ...(opts.body != null && opts.formData == null ? { "Content-Type": "application/json" } : {}),
      ...(isMutating ? { "X-Requested-With": "XMLHttpRequest", "Origin": originHost } : {}),
      ...(this.cookies.header() ? { Cookie: this.cookies.header() } : {}),
      ...opts.headers,
    };
    const init: RequestInit = { method, headers, redirect: opts.redirect ?? "manual" };
    if (opts.formData) {
      init.body = opts.formData;
    }
    else if (opts.body != null) {
      init.body = JSON.stringify(opts.body);
    }
    const res = await fetch(`${this.base}${path}`, init);
    this.cookies.capture(res);
    return res;
  }

  async json<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
    const res = await this.raw(path, opts);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API ${opts.method ?? "GET"} ${path} -> ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }
}
