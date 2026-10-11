import type { MiddlewareHandler } from "hono";
import type { Config } from "@/config";
import type { AppEnv } from "@/shared/lib/types";
import { Scalar } from "@scalar/hono-api-reference";
import { Hono } from "hono";
import { openAPIRouteHandler } from "hono-openapi";
import { BUILD_INFO } from "@/build-info";
import { TAGS } from "@/shared/lib/openapi";

// Scalar serves an HTML shell that loads its bundle from a CDN and injects
// inline init scripts. The app's strict global CSP (`script-src 'self'`,
// see buildOuterApp) would block both, leaving a blank page. This relaxed
// policy is scoped to the `/docs` route only.
//
// `secureHeaders` writes its CSP *after* `await next()`, so an inner handler
// cannot override it. `docsCspRelax` therefore has to be registered on the
// outer app *before* `secureHeaders` — that way its own post-`next()` body
// runs last and wins. See app.ts.
const DOCS_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "img-src 'self' data: https://cdn.jsdelivr.net",
  "font-src 'self' data: https://cdn.jsdelivr.net",
  "connect-src 'self'",
  "worker-src 'self' blob:",
].join("; ");

export const docsCspRelax: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("Content-Security-Policy", DOCS_CSP);
};

/**
 * Mount the OpenAPI spec (`/openapi.json`) and the Scalar API reference
 * (`/docs`) onto the API app. Call this *after* every module's routes are
 * mounted on `api`, since `openAPIRouteHandler` walks `api`'s route table to
 * build the spec (routes without `describeRoute` are omitted).
 *
 * The raw API is served beside `api`, not inside it, so pass its routes as
 * `raw` to document them too (under `/raw`, relative to the `/api` server).
 * The combined route table is assembled on the first request, once every
 * router has its routes.
 */
export function mountDocs(api: Hono<AppEnv>, config: Config, extra: { raw?: Hono<AppEnv> } = {}): void {
  const base = `${config.BASE_PATH}/api`;
  let handler: MiddlewareHandler | undefined;

  api.get("/openapi.json", (c, next) => {
    handler ??= specHandler(extra.raw === undefined ? api : combined(api, extra.raw), config, base);
    return handler(c, next);
  });

  api.get(
    "/docs",
    Scalar({ url: `${base}/openapi.json`, pageTitle: `${config.APP_NAME} API` }),
  );
}

function combined(api: Hono<AppEnv>, raw: Hono<AppEnv>): Hono<AppEnv> {
  const view = new Hono<AppEnv>();
  view.route("/", api);
  view.route("/raw", raw);
  return view;
}

function specHandler(routes: Hono<AppEnv>, config: Config, base: string): MiddlewareHandler {
  return openAPIRouteHandler(routes, {
    documentation: {
      openapi: "3.1.0",
      info: {
        title: `${config.APP_NAME} API`,
        version: BUILD_INFO.version,
        description: "HTTP API generated from the in-process Hono route definitions.",
      },
      servers: [{ url: base, description: "This deployment" }],
      components: {
        securitySchemes: {
          sessionCookie: {
            type: "apiKey",
            in: "cookie",
            name: "session_id",
            description: "Browser session cookie issued at login (`__Secure-session_id` in production).",
          },
          serviceToken: {
            type: "http",
            scheme: "bearer",
            description: "Service token via `Authorization: Bearer <token>` for metrics and token-scoped backup.",
          },
        },
      },
      tags: Object.values(TAGS).map(name => ({ name })),
    },
  });
}
