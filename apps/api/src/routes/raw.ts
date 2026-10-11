import type { AppEnv } from "@/shared/lib/types";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { TAGS } from "@/shared/lib/openapi";

/**
 * Routes served on the raw API, `${BASE_PATH}/api/raw/*`.
 *
 * This is the surface for other services to integrate with, so it carries
 * none of the browser-facing protections the `/api` routes get: no security
 * headers, no CSRF guard, no CORS policy, no session or policy middleware.
 * The only protection applied to every route here is a per-client rate limit
 * (see `buildRawApp`). Anything that needs authentication must check it
 * itself — a service token in a header is the usual shape.
 *
 * Mount a module's open routes below, the same way `protected.ts` mounts
 * session-authenticated ones.
 */
export function rawRoutes() {
  const app = new Hono<AppEnv>();

  // A reachability probe for integrators: it also shows the raw API's
  // headers (or their absence) and consumes rate-limit budget like any other
  // route.
  app.get(
    "/health",
    describeRoute({
      tags: [TAGS.Raw],
      summary: "Raw API reachability probe",
      responses: { 200: { description: "The raw API is reachable" } },
    }),
    c => c.json({ status: "ok" }),
  );

  return app;
}
