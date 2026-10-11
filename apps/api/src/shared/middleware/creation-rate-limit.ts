import type { Hono } from "hono";
import type { AppEnv } from "@/shared/lib/types";
import { createMiddleware } from "hono/factory";
import { getAuthProvider } from "@/shared/middleware/auth-registry";
import { consumeCreationQuota } from "./creation-quota";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

const RE_PARAM = /^:/;
const RE_ESCAPE = /[.*+?^${}()|[\]\\]/g;

interface Window {
  readonly name: "minute" | "hour";
  readonly ms: number;
  readonly max: number;
}

interface Candidate {
  readonly regex: RegExp;
  readonly resource: string;
}

/**
 * Turn a collection path into the name of the thing it holds:
 * `/documents/:id/attachments` → `attachment`.
 *
 * Only the plural forms the route table actually uses are handled. A name
 * that does not end in `s` is left alone, so a collection called `/totp`
 * stays `totp`.
 */
function resourceFromPattern(pattern: string): string {
  const segment = pattern.split("/").filter(s => s !== "" && !RE_PARAM.test(s)).at(-1) ?? "";
  return segment
    .replace(/ies$/, "y")
    .replace(/(ss|sh|ch|x)es$/, "$1")
    .replace(/(?<!s)s$/, "");
}

function compile(basePath: string, pattern: string): RegExp {
  const body = `${basePath}${pattern}`
    .split("/")
    .map(s => (RE_PARAM.test(s) ? "[^/]+" : s.replace(RE_ESCAPE, "\\$&")))
    .join("/");
  return new RegExp(`^${body}$`);
}

/**
 * Discover the routes that create something.
 *
 * A REST collection answers `GET` with a list and `POST` with a create, so
 * a `POST` whose path also has a `GET` is creating a member of that
 * collection — while an action posted at a member (`/cron/jobs/:id/trigger`,
 * `/policy/check`) has no matching `GET` and is left alone. That rule
 * separates the two cleanly across this app's whole route table, so a new
 * module is covered the moment it mounts, with nothing to remember and no
 * list to maintain.
 *
 * `creation-rate-limit.test.ts` pins the discovered set, so a route that
 * enters or leaves it has to be acknowledged.
 */
export function discoverCreationRoutes(app: Hono<AppEnv>, basePath = ""): Candidate[] {
  const listPaths = new Set(app.routes.filter(r => r.method === "GET").map(r => r.path));
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const route of app.routes) {
    if (route.method !== "POST" || !listPaths.has(route.path) || seen.has(route.path))
      continue;
    seen.add(route.path);
    out.push({ regex: compile(basePath, route.path), resource: resourceFromPattern(route.path) });
  }
  return out;
}

export interface CreationRateLimitOptions {
  /** The router whose table is searched for creating routes. */
  readonly app: Hono<AppEnv>;
  /** Prefix the router is mounted under, e.g. `/app/api`. */
  readonly basePath?: string;
}

/**
 * Per-user throttle on creating content, backed by the `rate_limits` table.
 *
 * Mounted once, globally. It finds the creating routes itself (see
 * `discoverCreationRoutes`) rather than being wired into each one, so a new
 * module is throttled as soon as it is mounted and nobody has to remember
 * to opt in.
 *
 * Budgets are per resource: a burst of comments does not spend the budget
 * for opening issues, and a runaway loop in one module cannot lock a user
 * out of the rest of the app. `CREATE_RATE_LIMIT_EXEMPT` lists resources to
 * leave alone.
 *
 * Two windows are enforced together: `CREATE_RATE_LIMIT_PER_MINUTE` bounds a
 * burst, and `CREATE_RATE_LIMIT_PER_HOUR` bounds the sustained rate a burst
 * limit alone would still allow. Either at `0` disables that window.
 * Rejected requests keep counting, so sustained abuse escalates out of the
 * minute window into the hour one rather than settling into a comfortable
 * rhythm just under the burst cap.
 *
 * Creation is the surface where an authenticated caller can grow the
 * database without bound, so the counters outlive the process: an in-memory
 * window alone dies with it, and a caller can pace requests around a restart
 * — or, on a runtime that evicts the app when idle, around the eviction.
 * Counting happens in memory and reaches the `rate_limits` table only when
 * the stored value would change a decision; see `creation-quota.ts`. Keying
 * on the user id bounds the table to users × resources × windows, one row
 * each, overwritten in place.
 */
export function creationRateLimit(options: CreationRateLimitOptions) {
  const { app, basePath = "" } = options;
  let candidates: Candidate[] | null = null;
  let lastRouteCount = -1;

  // The module routers mount after this middleware is installed, so the
  // table is read on first use and refreshed if it has grown since.
  function getCandidates(): Candidate[] {
    if (candidates === null || app.routes.length !== lastRouteCount) {
      candidates = discoverCreationRoutes(app, basePath);
      lastRouteCount = app.routes.length;
    }
    return candidates;
  }

  return createMiddleware<AppEnv>(async (c, next) => {
    if (c.req.method !== "POST")
      return next();

    const match = getCandidates().find(x => x.regex.test(c.req.path));
    if (!match)
      return next();

    const config = c.get("config");
    if (config.CREATE_RATE_LIMIT_EXEMPT.includes(match.resource))
      return next();

    const windows = ([
      { name: "minute", ms: MINUTE_MS, max: config.CREATE_RATE_LIMIT_PER_MINUTE },
      { name: "hour", ms: HOUR_MS, max: config.CREATE_RATE_LIMIT_PER_HOUR },
    ] satisfies Window[]).filter(w => w.max > 0);
    if (windows.length === 0)
      return next();

    const db = c.get("db");
    // Same provider `authRequired` uses, and it caches onto the context, so
    // the session is still resolved at most once per request. An
    // unauthenticated caller passes through to the auth layer, which
    // rejects it anyway.
    let user = c.get("user");
    if (!user) {
      const resolved = await getAuthProvider()(db, c);
      if (!resolved)
        return next();
      c.set("user", resolved);
      user = resolved;
    }

    const counts = await consumeCreationQuota(
      db,
      windows.map(w => ({ key: `${match.resource}:${w.name}:${user.id}`, windowMs: w.ms, max: w.max })),
    );

    const now = Date.now();
    // Report the longest wait among the windows that tripped: a caller told
    // to retry in a second would only trip the hour window again.
    let retryAfter = 0;
    for (const [i, window] of windows.entries()) {
      const result = counts[i]!;
      if (result.count > window.max)
        retryAfter = Math.max(retryAfter, Math.ceil((result.resetAt - now) / 1000));
    }

    if (retryAfter > 0) {
      c.header("Retry-After", String(Math.max(1, retryAfter)));
      return c.json(
        { success: false, error: { code: "RATE_LIMITED", message: "Too many requests. Try again later." } },
        429,
      );
    }

    return next();
  });
}
