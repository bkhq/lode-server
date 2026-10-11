import type { ActionSpec } from "../types";

// Shared bounds + enumerations. Live here (the definition layer) so the
// SPA, the validator, and the executor all read the same constants.
export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;
export const ALLOWED_METHODS = new Set<string>(HTTP_METHODS);
export const MIN_TIMEOUT_MS = 100;
export const MAX_TIMEOUT_MS = 60_000;
export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * URL allowlist + method check. Runs as the spec's deep `validate` hook
 * after the per-input checks have already filtered out wrong types.
 * The action is admin-gated at the route layer so trusted operators are
 * the only ones who can pass a URL through — this is hygiene, not a
 * sandbox.
 */
export async function validateUrlScheme(
  config: Record<string, unknown>,
): Promise<string | null> {
  if (typeof config.url !== "string")
    return null; // requiredness is enforced by `inputs[required:true]`
  let parsed: URL;
  try {
    parsed = new URL(config.url);
  }
  catch {
    return `config.url is not a valid URL: ${config.url}`;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return `config.url must use http or https, got ${parsed.protocol}`;

  if (config.method !== undefined) {
    if (typeof config.method !== "string")
      return "config.method must be a string";
    if (!ALLOWED_METHODS.has(config.method.toUpperCase()))
      return `config.method must be one of: ${HTTP_METHODS.join(", ")}`;
  }
  return null;
}

/**
 * Declarative definition of the `http-request` action.
 */
export const spec: ActionSpec = {
  name: "http-request",
  displayName: "HTTP request",
  description: "Issue one HTTP request and assert the response status.",
  category: "network",
  icon: "Globe",
  tags: ["http", "monitoring", "webhook"],
  version: "1.0.0",
  inputs: [
    {
      key: "url",
      label: "URL",
      type: "string",
      required: true,
      placeholder: "https://example.com/healthz",
      description: "Must be an http:// or https:// URL.",
    },
    {
      key: "method",
      label: "Method",
      type: "select",
      default: "GET",
      options: HTTP_METHODS.map(m => ({ value: m, label: m })),
    },
    {
      key: "headers",
      label: "Headers",
      type: "json",
      description: "JSON object of string→string. Leave blank for none.",
      placeholder: `{"Authorization": "Bearer …"}`,
    },
    {
      key: "body",
      label: "Body",
      type: "textarea",
      description: "Request body for POST / PUT / PATCH / DELETE. Ignored for GET / HEAD.",
    },
    {
      key: "timeoutMs",
      label: "Timeout (ms)",
      type: "number",
      default: DEFAULT_TIMEOUT_MS,
      min: MIN_TIMEOUT_MS,
      max: MAX_TIMEOUT_MS,
    },
    {
      key: "expectStatus",
      label: "Expected status",
      type: "number",
      min: 100,
      max: 599,
      description: "Leave blank to accept any 2xx; otherwise pin to a single status code.",
    },
  ],
  validate: validateUrlScheme,
};
