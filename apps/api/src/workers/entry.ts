import type { DurableObjectNamespace, DurableObjectState, R2Bucket } from "@cloudflare/workers-types";
import { bootstrap } from "@/app";
import { setPlatform } from "@/platform";
import { createWorkersPlatform } from "./platform";
import { registerR2Driver } from "./r2";
import { serveSpaRequest } from "./spa";

/**
 * Cloudflare Workers entry point.
 *
 * The Worker itself holds no state: it forwards every request to a single
 * Durable Object instance that owns the SQLite database and runs the whole
 * Hono app. That keeps the deployment shaped like the Bun one — one
 * process, one database, in-process caches — rather than spreading state
 * across isolates.
 *
 * Static assets are served by the platform's asset pipeline (see
 * `wrangler.jsonc`), so the app's own filesystem-backed static middleware
 * stays disabled here.
 */

export interface WorkerEnv {
  /** Binding for the Durable Object class exported below. */
  APP: DurableObjectNamespace;
  /** Blob storage for the file module. Required when FILE_STORAGE_DRIVER=r2. */
  FILES?: R2Bucket;
  /** The built SPA. Only consulted under a BASE_PATH, where the Worker runs first for the SPA's paths. */
  ASSETS?: { fetch: (request: Request) => Promise<Response> };
  [key: string]: unknown;
}

type FetchHandler = (req: Request, env?: Record<string, unknown>) => Response | Promise<Response>;

/** Carries the deployment's configuration identity to the Durable Object. */
const CONFIG_VERSION_HEADER = "x-app-config-version";

/**
 * A stable digest of every string-valued binding — the `vars` and secrets the
 * app parses into its `Config`.
 *
 * A Durable Object keeps the `env` it was constructed with for as long as it
 * stays resident, and this app schedules alarms, so it can stay resident
 * indefinitely. Without this, `wrangler secret put` appears to do nothing:
 * the new value is bound to new invocations of the stateless Worker while the
 * object serving every request still holds the old one.
 */
async function envFingerprint(env: Record<string, unknown>): Promise<string> {
  const pairs = Object.entries(env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pairs));
  return [
    ...new Uint8Array(digest),
  ].map(b => b.toString(16).padStart(2, "0")).join("");
}

export class AppDurableObject {
  readonly #state: DurableObjectState;
  #fetchApp: FetchHandler | undefined;
  #runDueTasks: (() => Promise<void>) | undefined;
  #configVersion: string | undefined;

  constructor(state: DurableObjectState, env: WorkerEnv) {
    this.#state = state;
    // Nothing is served until the platform is installed and migrations have
    // run: `blockConcurrencyWhile` holds every inbound event, including the
    // alarm, until boot resolves.
    void state.blockConcurrencyWhile(async () => {
      const { platform, runDueTasks } = createWorkersPlatform({
        env: env as Record<string, unknown>,
        storage: state.storage,
      });
      setPlatform(platform);
      if (env.FILES) {
        registerR2Driver(env.FILES);
      }
      this.#configVersion = await envFingerprint(env as Record<string, unknown>);
      const app = await bootstrap();
      this.#fetchApp = app.fetch;
      this.#runDueTasks = runDueTasks;
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (!this.#fetchApp) {
      return new Response("Service starting", { status: 503 });
    }

    // The configuration this object booted with is no longer the deployed
    // one. It cannot adopt the new `env` in place, so it resets; the next
    // request constructs it against the current bindings. The header is set
    // by the stateless Worker below and therefore cannot be forged from
    // outside.
    const deployed = request.headers.get(CONFIG_VERSION_HEADER);
    if (deployed !== null && this.#configVersion !== undefined && deployed !== this.#configVersion) {
      this.#state.abort("configuration changed");
      return new Response("Configuration changed, restarting", { status: 503 });
    }

    return this.#fetchApp(request, {});
  }

  /** Durable Object alarm: the Workers stand-in for the Bun sweep timers. */
  async alarm(): Promise<void> {
    await this.#runDueTasks?.();
  }

  /** Exposed for the deployed smoke test; see tests/workers. */
  get id(): string {
    return this.#state.id.toString();
  }
}

// Computed once per isolate: the bindings cannot change under a running
// version, so re-digesting them on every request would be pure overhead.
let cachedConfigVersion: string | undefined;

async function configVersion(env: Record<string, unknown>): Promise<string> {
  cachedConfigVersion ??= await envFingerprint(env);
  return cachedConfigVersion;
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    // Under a BASE_PATH the asset pipeline cannot map the prefix, so the
    // SPA's paths arrive here first; see ./spa.ts.
    const spa = await serveSpaRequest(request, env);
    if (spa !== undefined)
      return spa;

    // One named instance: this app has a single database, so it has a
    // single object. Sharding would mean sharding the database too.
    const stub = env.APP.get(env.APP.idFromName("app"));

    // Overwritten, never appended: a client cannot talk the object into
    // resetting by sending this header itself.
    const headers = new Headers(request.headers);
    headers.set(CONFIG_VERSION_HEADER, await configVersion(env as Record<string, unknown>));
    const forwarded = new Request(request, { headers });

    return stub.fetch(forwarded as never) as unknown as Response;
  },
};
