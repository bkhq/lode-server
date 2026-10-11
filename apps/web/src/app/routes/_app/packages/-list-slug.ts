// The package slug and display name rules of the registry API
// (`apps/api/src/modules/registry/validate.ts`), mirrored so the create
// dialog can validate as the user types. The server stays authoritative.

export const MAX_SLUG_LENGTH = 128;
export const MAX_NAME_LENGTH = 100;

export type SlugError = "empty" | "leadingDash" | "uppercase" | "illegalChar" | "tooLong";
export type NameError = "empty" | "tooLong" | "controlChar";

const RE_SLUG = /^[a-z0-9-]+$/;
const RE_SLUG_ANY_CASE = /^[a-z0-9-]+$/i;
// eslint-disable-next-line no-control-regex
const RE_CONTROL = /[\u0000-\u001F\u007F-\u009F]/;

/** Why `slug` cannot be a package slug, as an error key, or undefined when it can. */
export function validatePackageSlug(slug: string): SlugError | undefined {
  if (slug === "")
    return "empty";
  if (slug.startsWith("-"))
    return "leadingDash";
  if (!RE_SLUG_ANY_CASE.test(slug))
    return "illegalChar";
  if (!RE_SLUG.test(slug))
    return "uppercase";
  if (slug.length > MAX_SLUG_LENGTH)
    return "tooLong";
  return undefined;
}

/** Why `name` cannot be a display name, as an error key, or undefined when it can. The server trims it too. */
export function validatePackageName(name: string): NameError | undefined {
  const length = Array.from(name.trim()).length;
  if (length === 0)
    return "empty";
  if (length > MAX_NAME_LENGTH)
    return "tooLong";
  if (RE_CONTROL.test(name.trim()))
    return "controlChar";
  return undefined;
}
