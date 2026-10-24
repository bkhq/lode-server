import type { MiddlewareHandler } from "hono";
import type { Config } from "@/config";
import type { AppEnv } from "@/shared/lib/types";
import { Hono } from "hono";
import { openAPIRouteHandler } from "hono-openapi";
import { BUILD_INFO } from "@/build-info";
import { TAGS } from "@/shared/lib/openapi";

// The docs UI is an external viewer handed the spec's absolute URL, so the
// app ships no UI of its own. Other viewers that take `?url=`:
// `https://petstore.swagger.io/?url=` (Swagger UI) and
// `https://redocly.github.io/redoc/?url=` (Redoc).
export const DOCS_VIEWER = "https://client.scalar.com/?url=";

/**
 * Mount the OpenAPI spec (`/openapi.json`) and a redirect to the docs viewer
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

  api.get("/openapi.json", async (c, next) => {
    handler ??= specHandler(extra.raw === undefined
      ? api
      : combined(api, extra.raw), config, base);
    const res = await handler(c, next);
    // The viewer fetches the spec from the user's browser, from its own
    // origin. The spec is public, and the read carries no credentials.
    res?.headers.set("Access-Control-Allow-Origin", "*");
    return res;
  });

  api.get("/docs", (c) => {
    const origin = new URL(config.APP_URL ?? c.req.url).origin;
    return c.redirect(`${DOCS_VIEWER}${encodeURIComponent(`${origin}${base}/openapi.json`)}`);
  });
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
      servers: [
        { url: base, description: "This deployment" },
      ],
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
