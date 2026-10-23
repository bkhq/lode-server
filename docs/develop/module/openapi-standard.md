# OpenAPI Standard

> Every route a module exposes **must** appear in the generated OpenAPI spec.
> This is enforced at review: a new `*.routes.ts` that ships routes without
> `describeRoute` is rejected.

The API keeps its plain `new Hono<AppEnv>()` route factories. OpenAPI is
layered on with [`hono-openapi`](https://hono.dev/examples/hono-openapi)
middleware plus the shared helpers in
[`apps/api/src/shared/lib/openapi.ts`](../../../apps/api/src/shared/lib/openapi.ts).
The spec is served at `/api/openapi.json`; `/api/docs` redirects to an
external viewer that loads it (see [`modules/docs`](../../../apps/api/src/modules/docs/docs.routes.ts)).

Reference implementations: [`system.routes.ts`](../../../apps/api/src/modules/system/system.routes.ts)
(public + token + non-envelope responses) and
[`audit.routes.ts`](../../../apps/api/src/modules/audit/audit.routes.ts)
(admin + query/param validation).

---

## The two pieces

| Concern | Tool | Notes |
|---|---|---|
| Make the route visible + document responses | `describeRoute({ tags, summary, security, responses })` | **Required on every route.** First middleware in the chain. |
| Validate + document the request | `validator("query" \| "json" \| "param" \| "header", schema)` | Use **only** where a Zod schema already validated input. Replaces `schema.parse(...)`. |

A route with no `describeRoute` is **invisible** to the spec — the walker
that builds `/openapi.json` only collects routes carrying `describeRoute`.

---

## Rules

1. **Every route gets `describeRoute` first**, before auth/validation
   middleware:

   ```ts
   import { describeRoute, errors, jsonOk, SECURITY, TAGS, validator } from "@/shared/lib/openapi";

   router.get(
     "/things/:id",
     describeRoute({
       tags: [TAGS.Issue],
       summary: "Get a thing",
       security: SECURITY.session,
       responses: { ...jsonOk(thingSchema), ...errors(401, 403, 404) },
     }),
     authRequired,
     validator("param", z.object({ id: z.string() })),
     async (c) => {
       const { id } = c.req.valid("param");
       // ...
     },
   );
   ```

2. **Validation: migrate `schema.parse(...)` → `validator(...)`.** Where a
   route already validated input with a Zod schema, drop the manual parse and
   read the typed value with `c.req.valid(target)`:

   ```ts
   // before
   const body = createThingSchema.parse(await c.req.json());
   // after — add `validator("json", createThingSchema)` to the chain, then:
   const body = c.req.valid("json");
   ```

   `validator` preserves the project's **422 `VALIDATION_ERROR` envelope** (it
   throws `ValidationError` via a shared hook), so the contract is unchanged.

3. **Do NOT force `validator` onto bespoke parsing.** Routes that hand-parse
   for security/timing reasons (e.g. `account/auth` login: malformed JSON →
   `400`, bad credentials → `400`, constant-time compare) keep their handler
   **unchanged** — add only `describeRoute`. Forcing `validator` there would
   change status codes and break the flow.

4. **Tag per module.** Use the module's `TAGS.*` constant. Add a new entry to
   `TAGS` in `shared/lib/openapi.ts` when you add a module (one line).

5. **Declare auth.** Add `security: SECURITY.session` (cookie) or
   `SECURITY.serviceToken` (bearer) on protected routes; omit on public ones.

6. **Responses.** Build the `responses` map from the envelope helpers so the
   shape matches the live `ApiResponse<T>` envelope:

   | Helper | Emits |
   |---|---|
   | `jsonOk(data?, desc?)` | `200 { success: true, data }` |
   | `jsonCreated(data?, desc?)` | `201 { success: true, data }` |
   | `jsonPaged(item, desc?)` | `200 { success: true, data: item[], meta }` |
   | `noContent(desc?)` | `204` |
   | `raw(status, mediaType, desc)` | non-JSON (text/binary/redirect) |
   | `errors(...codes)` | error envelope per status (400/401/403/404/409/413/422/429/500/503) |

   `data` defaults to `z.unknown()` — pass a small Zod schema (often mirroring
   the Drizzle row) when the precise shape is worth documenting. Define it once
   at the top of the routes file and reuse it for list + detail.

---

## Checklist (per route)

- [ ] `describeRoute` is the first middleware, with `tags` + `summary`.
- [ ] `security` set on protected routes.
- [ ] `responses` includes the success helper **and** the realistic error codes.
- [ ] Input schema validated via `validator(...)` (or, for bespoke parsing, left as-is).
- [ ] Handler reads validated input via `c.req.valid(target)`.
- [ ] Route appears in `/api/openapi.json` and renders in the viewer behind `/api/docs`.

## Where docs are wired

- Spec + viewer redirect: `apps/api/src/modules/docs/docs.routes.ts` (`mountDocs`).
- Mounted **before** the route modules in `app.ts` so docs stay outside every
  module's `use("*")` auth/unlock guards (Hono middleware only applies to
  routes registered after it).
- The app ships no docs UI. `/api/docs` redirects to `DOCS_VIEWER`
  (`https://client.scalar.com/?url=`) with the spec's absolute URL, built from
  `APP_URL` when set. The viewer fetches the spec from the browser, so
  `/api/openapi.json` answers with `Access-Control-Allow-Origin: *`.
