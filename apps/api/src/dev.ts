import { bootstrap } from "./app";

// Use globalThis to persist the bootstrap result across Vite HMR reloads.
// Without this, every code change re-executes dev.ts and locks the system.
const g = globalThis as Record<string, unknown>;

type FetchFn = (req: Request, env?: Record<string, unknown>) => Response | Promise<Response>;

let fetchFn: FetchFn;

if (g.__app_fetch) {
  fetchFn = g.__app_fetch as FetchFn;
}
else {
  // eslint-disable-next-line antfu/no-top-level-await
  const result = await bootstrap();
  fetchFn = result.fetch;
  g.__app_fetch = fetchFn;
}

// @hono/vite-dev-server expects export default { fetch }
export default { fetch: fetchFn };
