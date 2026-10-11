import { HttpError } from "@/shared/lib/http";

/**
 * Resolve a user-facing message for a caught error.
 *
 * `fallback` is an already-localized generic string supplied by the
 * caller. When the error carries a server-assigned `code` (every
 * structured API failure does — the envelope is `{ error: { code,
 * message } }`), the `message` is server-internal and must NOT be
 * surfaced verbatim: returning `fallback` keeps internals from leaking
 * into toasts. Only code-less errors (non-JSON proxy responses, plain
 * `Error`s) fall through to the raw message.
 */
export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof HttpError)
    return err.code ? fallback : err.message;
  return err instanceof Error ? err.message : fallback;
}
