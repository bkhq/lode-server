/**
 * Validation rules shared with the lode client. A version and an asset name
 * end up in URLs lode fetches and in paths it writes, so they follow lode's
 * own rule (`crates/lode-core/src/idval.rs`): one safe path component,
 * `[A-Za-z0-9._-]`, no leading `.` or `-`. A package slug is held to a
 * narrower rule of the registry's own.
 */

// The whole of lode's `validate_id`: its separate empty / control-character /
// path-separator checks are all subsets of "every character is in the
// charset and the first is not `.` or `-`". `\w` is ASCII-only here: the
// pattern carries neither the `u` nor the `v` flag.
const RE_ID = /^\w[\w.-]*$/;

/**
 * lode puts no bound on an id. The registry does: an asset name becomes a
 * file name in the local blob store, and a package slug a URL segment.
 */
export const MAX_ID_LENGTH = 128;

/** Why `id` is not a valid id, or undefined when it is. `kind` names the field. */
export function idError(kind: string, id: string): string | undefined {
  const shown = quote(id.length > MAX_ID_LENGTH
    ? `${id.slice(0, MAX_ID_LENGTH)}...`
    : id);
  if (id === "")
    return `invalid ${kind} ${shown}: must not be empty`;
  if (id.startsWith(".") || id.startsWith("-"))
    return `invalid ${kind} ${shown}: must not start with '.' or '-'`;
  if (!RE_ID.test(id))
    return `invalid ${kind} ${shown}: only letters, digits, '.', '_' and '-' are allowed`;
  if (id.length > MAX_ID_LENGTH)
    return `invalid ${kind} ${shown}: longer than ${MAX_ID_LENGTH} characters`;
  return undefined;
}

// A package slug is narrower than a lode id: lowercase letters, digits and
// `-` only, so one package has one spelling in every URL. Every slug is a
// valid lode id, which is what the manifest `name` it becomes has to be.
const RE_PACKAGE_SLUG = /^[a-z0-9-]+$/;

/** Why `slug` cannot be a package slug, or undefined when it can. */
export function packageSlugError(slug: string): string | undefined {
  const shown = quote(slug.length > MAX_ID_LENGTH
    ? `${slug.slice(0, MAX_ID_LENGTH)}...`
    : slug);
  if (slug === "")
    return `invalid package slug ${shown}: must not be empty`;
  if (slug.startsWith("-"))
    return `invalid package slug ${shown}: must not start with '-'`;
  if (!RE_PACKAGE_SLUG.test(slug))
    return `invalid package slug ${shown}: only lowercase letters, digits and '-' are allowed`;
  if (slug.length > MAX_ID_LENGTH)
    return `invalid package slug ${shown}: longer than ${MAX_ID_LENGTH} characters`;
  return undefined;
}

export const MAX_DISPLAY_NAME_LENGTH = 100;

/**
 * Why `name` cannot be a package's display name, or undefined when it can.
 * Free text, shown and never put in a path; the caller trims it first.
 */
export function displayNameError(name: string): string | undefined {
  const cps = codePoints(name);
  if (cps.length === 0)
    return "invalid package name: must not be empty";
  if (cps.length > MAX_DISPLAY_NAME_LENGTH)
    return `invalid package name: longer than ${MAX_DISPLAY_NAME_LENGTH} characters`;
  if (cps.some(isControl))
    return `invalid package name ${quote(name)}: contains a control character`;
  return undefined;
}

// Rust's `char::is_control` (general category Cc) and the White_Space
// property `str::trim` strips, as code points. JavaScript's `trim()` differs
// (it also strips U+FEFF), so the sets are spelled out to match lode exactly.
function isControl(cp: number): boolean {
  return cp <= 0x1F || (cp >= 0x7F && cp <= 0x9F);
}

const WHITESPACE = new Set([
  0x20,
  0x85,
  0xA0,
  0x1680,
  0x2028,
  0x2029,
  0x202F,
  0x205F,
  0x3000,
]);

function isWhitespace(cp: number): boolean {
  return (cp >= 0x09 && cp <= 0x0D) || (cp >= 0x2000 && cp <= 0x200A) || WHITESPACE.has(cp);
}

function codePoints(value: string): number[] {
  return Array.from(value, ch => ch.codePointAt(0)!);
}

/**
 * Quote a hostile value for an error message with every control character
 * escaped, so it is never echoed raw into a response or a log line.
 */
function quote(value: string): string {
  return Array.from(JSON.stringify(value), (ch) => {
    const cp = ch.codePointAt(0)!;
    return isControl(cp)
      ? `\\u${cp.toString(16).padStart(4, "0")}`
      : ch;
  }).join("");
}

/** An asset's runtime, as lode's `RuntimeSpec`. */
export interface RuntimeSpec {
  runtime: string;
  version?: string | undefined;
  version_check?: string | undefined;
  download?: string | undefined;
  sha256?: string | undefined;
}

const RE_RUNTIME_NAME = /^[\w-][\w.-]*$/;
const RE_LOWER_SHA256 = /^[0-9a-f]{64}$/;

/**
 * Why an asset's runtime is not acceptable, or undefined when it is. Mirrors
 * lode's `validate_runtime_spec`: a plain binary name, no blank or control
 * characters in the other fields, an http(s) `download` with its `sha256`.
 */
export function runtimeSpecError(rt: RuntimeSpec): string | undefined {
  if (!RE_RUNTIME_NAME.test(rt.runtime))
    return `asset runtime: ${quote(rt.runtime)} is not a plain binary name`;
  for (const field of ["version", "version_check", "download"] as const) {
    const value = rt[field];
    if (value !== undefined && (codePoints(value).every(isWhitespace) || codePoints(value).some(isControl)))
      return `asset runtime: ${field} ${quote(value)} is blank or has a control character`;
  }
  if (rt.sha256 !== undefined && !RE_LOWER_SHA256.test(rt.sha256))
    return `asset runtime: sha256 ${quote(rt.sha256)} is not 64 lowercase hex characters`;
  if (rt.download !== undefined) {
    if (!rt.download.startsWith("https://") && !rt.download.startsWith("http://"))
      return `asset runtime: download ${quote(rt.download)} is not an http(s) URL`;
    if (rt.sha256 === undefined)
      return "asset runtime: a download needs its sha256";
  }
  return undefined;
}

/**
 * Why an asset's `run` / `exec` launch override is not acceptable, or
 * undefined when it is. Mirrors lode's `validate_command_override`: when
 * present it must be non-blank and free of control characters, since a
 * newline would let one signed field pass for another in the canonical
 * message.
 */
export function commandOverrideError(kind: "run" | "exec", value: string): string | undefined {
  const cps = codePoints(value);
  if (cps.every(isWhitespace))
    return `asset ${kind} must not be blank when present (omit the field instead)`;
  if (cps.some(isControl))
    return `asset ${kind} ${quote(value)}: contains a control character`;
  return undefined;
}
