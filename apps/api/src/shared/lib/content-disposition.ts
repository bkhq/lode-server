// RFC 6266 / RFC 5987 — Content-Disposition with Unicode-aware filename.
//
// Browsers handle three forms with decreasing fidelity:
//
//   1. `filename*=UTF-8''<percent-encoded>`     — full Unicode (RFC 5987).
//   2. `filename="<ascii fallback>"`            — ASCII-only legacy parse.
//   3. (omitted)                                — browser invents a name.
//
// We always emit both `filename=` (so old / non-compliant clients still
// see something readable) and `filename*=` (so modern clients render
// the original UTF-8 name unmangled). Putting `encodeURIComponent` of
// a UTF-8 string into the quoted-string variant — as the previous
// inline form did — leaves users with `foo%20bar.pdf` in the Save-As
// dialog instead of `foo bar.pdf`.

const RE_NON_TOKEN = /[^\w.-]+/g;

/** Strip / replace characters illegal in a quoted-string filename for the ASCII fallback. */
function asciiFallback(name: string): string {
  // Replace any non-token byte with `_` so the value stays parseable
  // by RFC 6266 §4.3 fallback consumers. Drop control chars entirely.
  // eslint-disable-next-line no-control-regex
  const stripped = name.replace(/[\x00-\x1F\x7F"\\]/g, "");
  return stripped.replace(RE_NON_TOKEN, "_") || "download";
}

/**
 * Build a `Content-Disposition` value with both ASCII fallback and
 * RFC 5987 UTF-8 forms.
 *
 * @param disposition `inline` to render in-browser, `attachment` to
 *   prompt a download. The route layer decides based on
 *   MIME-sniff results and module policy.
 * @param filename The display name as it should appear to the user.
 *   Unicode is preserved verbatim through the `filename*=` form.
 */
export function buildContentDisposition(disposition: "inline" | "attachment", filename: string): string {
  const fallback = asciiFallback(filename);
  const encoded = encodeURIComponent(filename);
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
