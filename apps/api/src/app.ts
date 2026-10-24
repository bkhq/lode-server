import type { Handler } from "hono";
import type { Config } from "./config";
import type { AppDatabase } from "./db";
import type { EncryptionState } from "./modules/encryption/state";
import type { Logger } from "./shared/lib/logger";
import type { AppEnv } from "./shared/lib/types";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { loadConfig } from "./config";
import { logDefaultAdmins } from "./modules/account/auth/auth.service";
import { passwordHashUnsupportedReason } from "./modules/account/auth/password";
import { seedBootstrapAdmin } from "./modules/account/users/local-users.service";
import { startAuditRetentionSweep } from "./modules/audit";
import { assertCronSchedulerSupported, initCronActions, startCron } from "./modules/cron";
import { mountDocs } from "./modules/docs";
import { bootstrapEncryption } from "./modules/encryption";
import { EncryptionState as EncryptionStateCtor } from "./modules/encryption/state";
import { initFileModule, startFileGcSweep } from "./modules/file";
import { getAllRouteBindings, policyMiddleware } from "./modules/policy";
import { protectedRoutes, publicRoutes, rawRoutes, setupRoutes } from "./routes";
import { getAuthConfig, seedSettingsFromEnv } from "./shared/lib/app-config";
import { createLogger } from "./shared/lib/logger";
import { creationRateLimit } from "./shared/middleware/creation-rate-limit";
import { csrfGuard } from "./shared/middleware/csrf";
import { errorHandler } from "./shared/middleware/error-handler";
import { loggingMiddleware } from "./shared/middleware/logging";
import { rateLimit } from "./shared/middleware/rate-limit";
import { propagateRequestId } from "./shared/middleware/request-id";
import { hasStaticAssets, serveStaticAssets } from "./shared/middleware/static";

// ─── Types ───

export interface AppDeps {
  readonly config: Config;
  readonly db: AppDatabase;
  readonly logger: Logger;
  readonly encryption: EncryptionState;
}

export interface BootstrapResult {
  /** Current app — may be locked or full. Mutable via onUnlock. */
  readonly fetch: (req: Request, env?: Record<string, unknown>) => Response | Promise<Response>;
  /** Config object */
  readonly config: Config;
  /** Logger */
  readonly logger: Logger;
  /**
   * The live database handle at boot, or `undefined` when the app starts
   * encryption-locked (no DB until unlocked). Used by the lode readiness
   * probe and prepare handshake in index.ts.
   */
  readonly db?: AppDatabase;
  /** Close DB connection (if unlocked). Call on shutdown. */
  readonly closeDb: () => Promise<void>;
}

// ─── Bootstrap ───

/**
 * Bootstrap the application: load config, check encryption state,
 * and return a fetch handler that delegates to locked or full app.
 *
 * Used by both index.ts (production) and dev.ts (Vite dev server).
 */
export async function bootstrap(): Promise<BootstrapResult> {
  const config = await loadConfig();

  // Refuse a credential this runtime cannot check, at boot. Left to the
  // login route it would surface as an endless "invalid credentials", with
  // the real reason buried in a log line.
  if ((config.SINGLE_USER_MODE || config.LOCAL_LOGIN) && config.SINGLE_USER_PASSWORD_HASH) {
    const reason = passwordHashUnsupportedReason(config.SINGLE_USER_PASSWORD_HASH);
    if (reason)
      throw new Error(`[config] ${reason}`);
  }

  const logger = createLogger(config);
  // One controller per process owns all encryption state. Passed to the
  // bootstrap helper, threaded into `c.var.encryption` for every request,
  // and re-used across hot-swaps so DEK rotation stays consistent.
  const encryption = new EncryptionStateCtor();

  // Mutable reference for hot-swapping locked → unlocked
  let currentApp: { fetch: (req: Request, env?: Record<string, unknown>) => Response | Promise<Response> };
  let closeDb: () => Promise<void> = async () => {};
  // Live DB handle, exposed to index.ts for the lode readiness probe. Stays
  // undefined while the app is locked; set once the DB is unlocked/opened.
  let currentDb: AppDatabase | undefined;

  async function onDbReady(db: AppDatabase) {
    // Close the previous database handle (no-op on first call) so DEK rotation
    // can hot-swap the live db without leaking the old encrypted handle.
    await closeDb();
    currentDb = db;
    currentApp = await buildFullApp({ config, db, logger, encryption });
    logDefaultAdmins(await getAuthConfig(db, config), logger);
    closeDb = async () => {
      await db.close();
    };
    logger.info("system fully operational");
  }

  const result = await bootstrapEncryption(encryption, config, logger, onDbReady);

  if (result.mode === "disabled") {
    await onDbReady(result.db);
  }
  else {
    currentApp = buildLockedApp(config, logger, encryption);
  }

  return {
    fetch: (req, env) => currentApp.fetch(req, env),
    config,
    logger,
    db: currentDb,
    closeDb: () => closeDb(),
  } as BootstrapResult;
}

// ─── Shared installers ───

// CORS_ORIGIN may be a comma-separated list. In development with no value,
// allow same-origin requests (any host) — dev usually goes through nsl which
// proxies to the SPA's vite port and the API's bun port under one host.
function resolveCorsOrigin(config: Config): string | string[] {
  if (config.CORS_ORIGIN) {
    const list = config.CORS_ORIGIN.split(",").map(s => s.trim()).filter(Boolean);
    return list.length === 1
      ? list[0]!
      : list;
  }
  return config.NODE_ENV === "production"
    ? ""
    : "*";
}

function installCommonMiddleware(
  api: Hono<AppEnv>,
  { config, logger, db, encryption }: { config: Config; logger: Logger; db?: AppDatabase; encryption: EncryptionState },
): void {
  // Hono's `requestId()` accepts an inbound `X-Request-Id` (when present
  // and well-formed) and otherwise mints a UUID. `propagateRequestId`
  // echoes that value as an outgoing `X-Request-Id` response header so a
  // user-reported failure can be matched against the log line. Outbound
  // service callers (OIDC discovery, cron http-request) read the value
  // from `c.get("requestId")` and forward it as their own header.
  api.use("*", requestId());
  api.use("*", propagateRequestId);
  api.use("*", cors({
    origin: resolveCorsOrigin(config),
  }));
  api.use("*", (c, next) => {
    if (db !== undefined) {
      c.set("db", db);
    }
    c.set("config", config);
    c.set("logger", logger);
    c.set("encryption", encryption);
    return next();
  });
  api.use("*", loggingMiddleware());
  api.use("*", csrfGuard);
  // Global policy enforcement: every route declared in any module's
  // `defineResource.routes` is auto-gated. Undeclared routes pass
  // through; admin actors bypass before any DB query. See
  // docs/develop/module/policy-standard.md.
  api.use("*", policyMiddleware({ basePath: `${config.BASE_PATH}/api` }));
  // Per-user creation quota. Mounted once and self-discovering: it reads the
  // router table to find the routes that create something, so a new module
  // is covered as soon as it mounts. See shared/middleware.
  api.use("*", creationRateLimit({ app: api, basePath: `${config.BASE_PATH}/api` }));
}

// ─── Full App (unlocked) ───

export async function buildFullApp({ config, db, logger, encryption }: AppDeps) {
  const api = new Hono<AppEnv>();
  installCommonMiddleware(api, { config, logger, db, encryption });

  await seedSettingsFromEnv(db, config);
  await seedBootstrapAdmin(db, config, logger);
  startAuditRetentionSweep(db, config, logger);
  await initFileModule(config, logger);
  startFileGcSweep(db, config, logger);
  // Actions catalog is always populated so admins can plan jobs even
  // with the scheduler off. `startCron` allocates Baker and starts
  // firing ticks — only run it when the operator opts in. Actions whose
  // `spec.defaultEnabled` is `false` (e.g. `shell` — sh -c, no sandbox;
  // treat the registry as a host root crontab) need an explicit opt-in
  // via `CRON_ACTIONS_ENABLED`.
  initCronActions({ enabledActions: config.CRON_ACTIONS_ENABLED });
  if (config.CRON_ENABLED) {
    // Fails the boot rather than letting a host that evicts the app between
    // requests pretend it is running a scheduler.
    assertCronSchedulerSupported();
    await startCron({ db, logger, config });
  }

  // OpenAPI spec (/openapi.json) + docs viewer redirect (/docs). Mounted
  // BEFORE the route modules: Hono middleware only applies to routes
  // registered after it, so mounting here keeps docs outside every module's
  // `use("*")` auth / unlock guards (which would otherwise gate them).
  // `openAPIRouteHandler` walks `api`'s route table lazily at request time,
  // so routes registered below are still included in the spec. See modules/docs.
  const raw = rawRoutes();
  mountDocs(api, config, { raw });

  api.route("/", publicRoutes());
  api.route("/", protectedRoutes());

  // Fail closed at boot: protected modules register their object-level
  // policy bindings as an import side-effect of the `protectedRoutes()`
  // mount above. An empty registry means `policyMiddleware` would fall
  // through every request unauthorized — a catastrophic silent bypass.
  // Assert here (before serving) rather than letting it degrade at runtime.
  if (getAllRouteBindings().length === 0) {
    throw new Error(
      "[policy] no route bindings registered after mounting protectedRoutes() — "
      + "policy enforcement would fail open. This is a wiring bug (a module's "
      + "defineResource() side-effect did not run).",
    );
  }

  api.onError(errorHandler);

  return buildOuterApp(api, config, buildRawApp({ config, db, logger, encryption }, raw));
}

// ─── Locked App (setup / unlock) ───

export function buildLockedApp(config: Config, logger: Logger, encryption: EncryptionState) {
  const api = new Hono<AppEnv>();
  installCommonMiddleware(api, { config, logger, encryption });

  api.route("/", publicRoutes());
  api.route("/", setupRoutes());

  api.all("*", (c) => {
    return c.json({
      success: false,
      error: { code: "SYSTEM_LOCKED", message: "System is locked. Provide decryption key to unlock." },
    }, 503);
  });

  api.onError(errorHandler);

  return buildOuterApp(api, config);
}

// ─── Outer shell (shared by full & locked) ───

// ─── Raw API ───

/** Mount point of the raw API, below BASE_PATH. */
export const RAW_API_PREFIX = "/api/raw";

function isUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * The bare API other services integrate with, mounted at
 * `${BASE_PATH}/api/raw`.
 *
 * It shares the `/api` prefix but not the `/api` sub-app, because everything
 * that sub-app applies is built for the SPA in a browser and gets in the way
 * of a service calling from outside: security headers (a `same-origin`
 * resource policy blocks cross-origin readers outright), the CSRF guard
 * (which demands an Origin and an `X-Requested-With` a server-to-server
 * client never sends), the CORS policy, the session and policy middleware,
 * and the creation quota.
 *
 * What remains is plumbing — a request id to correlate with, the request
 * context, request logging, a JSON error shape — and one protection: a
 * per-client rate limit, `RAW_API_RATE_LIMIT_PER_MINUTE`. Routes that need
 * authentication check it themselves.
 *
 * `routes` is injectable so the composition can be tested with routes the
 * production table does not have.
 */
export function buildRawApp(
  { config, db, logger, encryption }: AppDeps,
  routes: Hono<AppEnv> = rawRoutes(),
): Hono<AppEnv> {
  const raw = new Hono<AppEnv>();

  raw.use("*", requestId());
  raw.use("*", propagateRequestId);
  raw.use("*", async (c, next) => {
    c.set("db", db);
    c.set("config", config);
    c.set("logger", logger);
    c.set("encryption", encryption);
    await next();
  });
  raw.use("*", loggingMiddleware());

  // Keyed per client IP. Unknown paths count too, so probing for routes
  // spends the same budget as calling them.
  const perMinute = config.RAW_API_RATE_LIMIT_PER_MINUTE;
  if (perMinute > 0) {
    raw.use("*", rateLimit({ windowMs: 60_000, max: perMinute, bucket: "raw-api" }));
  }

  raw.route("/", routes);

  // Anything unmatched under the prefix is answered here. It is also what
  // keeps the `/api` sub-app out: that sub-app is mounted after this one on
  // the same prefix, and Hono runs matching handlers in registration order,
  // so a response from here ends the chain before any `/api` middleware.
  // Without it a mistyped endpoint would fall through to the `/api` stack.
  raw.all("*", c => c.json({
    success: false,
    error: { code: "NOT_FOUND", message: "Not found" },
  }, 404));

  raw.onError(errorHandler);
  return raw;
}

export function buildOuterApp(api: Hono<AppEnv>, config: Config, raw?: Hono<AppEnv>, spa?: Handler) {
  const app = new Hono<AppEnv>();
  const base = config.BASE_PATH;
  const rawPrefix = `${base}${RAW_API_PREFIX}`;

  // Security headers for every response (API JSON + static SPA HTML/JS/CSS).
  // SPA bundles are hashed under BASE_PATH; styles need 'unsafe-inline' for
  // Tailwind v4 + base-ui runtime style injection. img data:/blob: covers
  // QR codes and inline SVGs. frame-ancestors 'self' lets the SPA preview
  // PDFs via same-origin <iframe>. HSTS auto-enables when APP_URL is
  // https — a direct deployment without a reverse proxy still gets it.
  const hstsEnabled = config.APP_URL?.startsWith("https://") ?? false;
  const securityHeaders = secureHeaders({
    referrerPolicy: "strict-origin-when-cross-origin",
    crossOriginOpenerPolicy: "same-origin",
    crossOriginResourcePolicy: "same-origin",
    xFrameOptions: "SAMEORIGIN",
    xContentTypeOptions: "nosniff",
    xDownloadOptions: "noopen",
    permissionsPolicy: {
      camera: [],
      microphone: [],
      geolocation: [],
      payment: [],
    },
    strictTransportSecurity: hstsEnabled ? "max-age=15552000; includeSubDomains" : false,
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      fontSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      frameAncestors: ["'self'"],
      frameSrc: ["'self'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      objectSrc: ["'none'"],
    },
  });

  // The raw API is exempt, decided by path: this is a browser policy for the
  // SPA and its API, and it would stop other services from reading the raw
  // API at all. Only while the raw API is mounted — a locked deployment has
  // none, and the prefix must then keep the normal headers.
  app.use("*", (c, next) =>
    raw !== undefined && isUnder(c.req.path, rawPrefix)
      ? next()
      : securityHeaders(c, next));

  // When BASE_PATH is set, redirect bare "/" to "${base}/" so a request to the
  // origin lands on the SPA. With no base the SPA already owns "/" — skip the
  // redirect to avoid a self-loop.
  // With HOME_PAGE=root the SPA owns "/" instead, and its home page is
  // served there outside the prefix (the client decides what to render).
  const homeAtRoot = config.HOME_PAGE === "root";
  if (base !== "" && !homeAtRoot) {
    app.get("/", (c) => {
      return c.html(`<meta http-equiv="refresh" content="0;url=${base}/">`);
    });
  }

  if (raw !== undefined) {
    // Before the `/api` sub-app, which shares the prefix: Hono runs matching
    // handlers in registration order, so mounting the raw API first is what
    // keeps CSRF, CORS, the session and policy middleware and the creation
    // quota from ever running on it. `raw-api.test.ts` pins this.
    app.route(rawPrefix, raw);
  }
  app.route(`${base}/api`, api);
  const serveSpa = spa ?? (hasStaticAssets()
    ? serveStaticAssets(base)
    : undefined);
  if (serveSpa !== undefined) {
    // With a BASE_PATH the wildcard below does not reach "/"; without one
    // it already does.
    if (base !== "" && homeAtRoot)
      app.get("/", serveSpa);
    app.get(`${base}/*`, serveSpa);
  }

  return app;
}
