const RE_FORBIDDEN = /[\\\0]/;

function isPathSegment(segment: string): boolean {
  return segment !== "" && segment !== "." && segment !== "..";
}

/**
 * Refuse anything that is not a plain relative `/`-separated path. Both
 * drivers apply it, so a key is valid on one exactly when it is on the other,
 * and on the local driver it cannot name a path outside the store root.
 */
export function assertBlobKey(key: string): void {
  if (RE_FORBIDDEN.test(key) || !key.split("/").every(isPathSegment)) {
    throw new Error(`Invalid blob key: ${JSON.stringify(key)}`);
  }
}

/**
 * A prefix is a key that may stop anywhere: after a `/`, or part-way through
 * a segment. The empty prefix is refused — it would match every object.
 */
export function assertBlobPrefix(prefix: string): void {
  const segments = prefix.split("/");
  const last = segments.pop();
  const valid = prefix !== ""
    && !RE_FORBIDDEN.test(prefix)
    && segments.every(isPathSegment)
    && last !== "."
    && last !== "..";
  if (!valid) {
    throw new Error(`Invalid blob key prefix: ${JSON.stringify(prefix)}`);
  }
}
