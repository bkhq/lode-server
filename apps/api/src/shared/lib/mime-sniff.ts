/**
 * Tiny magic-byte sniffer for the small whitelist of MIME categories we
 * accept on uploads (images, PDF, text, zip, 7z).
 *
 * The client-supplied `file.type` cannot be trusted — a `.svg` (which is XML
 * with possible script payloads) can claim `image/png`. We sniff the first
 * 16 bytes and return the inferred top-level category. Callers compare that
 * to the claimed type and reject mismatches before persisting the file.
 *
 * The sniffer is deliberately conservative: when no signature matches we
 * return `null` so the caller's policy decides (today: also reject).
 */

export type SniffedKind
  = | "jpeg"
    | "png"
    | "gif"
    | "bmp"
    | "webp"
    | "tiff"
    | "pdf"
    | "text"
    | "zip"
    | "7z";

interface Signature {
  readonly kind: SniffedKind;
  readonly bytes: readonly number[];
  readonly offset?: number;
}

const SIGNATURES: readonly Signature[] = [
  // Images — specific subtypes so `mimeMatchesContent` can refuse a
  // mis-declared upload (jpeg bytes claiming image/png, etc.) instead of
  // accepting every image/* claim by category. WebP is handled below as a
  // special case because the RIFF prefix is shared with WAV / AVI.
  { kind: "jpeg", bytes: [0xFF, 0xD8, 0xFF] },
  { kind: "png", bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },
  { kind: "gif", bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] }, // gif87a
  { kind: "gif", bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] }, // gif89a
  { kind: "bmp", bytes: [0x42, 0x4D] },
  { kind: "tiff", bytes: [0x49, 0x49, 0x2A, 0x00] }, // little-endian
  { kind: "tiff", bytes: [0x4D, 0x4D, 0x00, 0x2A] }, // big-endian

  // PDF
  { kind: "pdf", bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF

  // Archives
  { kind: "zip", bytes: [0x50, 0x4B, 0x03, 0x04] }, // zip local file header
  { kind: "zip", bytes: [0x50, 0x4B, 0x05, 0x06] }, // empty zip
  { kind: "zip", bytes: [0x50, 0x4B, 0x07, 0x08] }, // spanned zip
  { kind: "7z", bytes: [0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C] },
];

function matches(buf: Uint8Array, sig: Signature): boolean {
  const offset = sig.offset ?? 0;
  if (buf.length < offset + sig.bytes.length)
    return false;
  for (let i = 0; i < sig.bytes.length; i++) {
    if (buf[offset + i] !== sig.bytes[i])
      return false;
  }
  return true;
}

/**
 * Real WebP files start with `RIFF` (4 bytes) + 4-byte size + `WEBP`.
 * A plain `RIFF` prefix would also match WAV and AVI, so WebP is sniffed
 * via the combined fingerprint rather than via the generic SIGNATURES
 * table.
 */
function isWebp(buf: Uint8Array): boolean {
  if (buf.length < 12)
    return false;
  return buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50;
}

function looksLikeText(buf: Uint8Array): boolean {
  if (buf.length === 0)
    return true;
  // Reject obvious binary: ANY null byte in the first 1KiB collapses the
  // text classification. Then require ≥95% printable ASCII / common UTF-8
  // continuation bytes, which is plenty for plain text, source code, csv.
  let printable = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!;
    if (b === 0)
      return false;
    // tab, lf, cr, printable ascii, or any > 0x7F (utf-8 continuation /
    // multibyte lead). The byte-level test is intentionally lenient.
    if (b === 0x09 || b === 0x0A || b === 0x0D || (b >= 0x20 && b <= 0x7E) || b > 0x7F)
      printable++;
  }
  return printable / buf.length >= 0.95;
}

/**
 * Sniff the leading bytes of a file and return the inferred kind, or null
 * when no signature matches. Empty buffers count as text (zero-byte text
 * files are legitimate uploads).
 */
export function sniffKind(buf: Uint8Array): SniffedKind | null {
  // WebP must be checked before the generic SIGNATURES table because the
  // shared `RIFF` prefix would otherwise need a dedicated entry; we keep
  // the table prefix-only and let isWebp() apply the offset-8 verification.
  if (isWebp(buf))
    return "webp";
  for (const sig of SIGNATURES) {
    if (matches(buf, sig))
      return sig.kind;
  }
  if (looksLikeText(buf))
    return "text";
  return null;
}

/**
 * Verify the claimed MIME type matches what the magic bytes say.
 *
 * For images, the match is on the exact subtype: jpeg bytes claiming
 * `image/png` is rejected so the audit / quota row carries the right
 * type, and the inline-render whitelist downstream stays honest. The
 * common `image/jpg` alias for `image/jpeg` is accepted.
 *
 * For text, anything that looks like ASCII / UTF-8 may claim any
 * `text/*` subtype (we cannot meaningfully sub-classify csv vs plain).
 */
export function mimeMatchesContent(claimed: string, buf: Uint8Array): boolean {
  const kind = sniffKind(buf);
  if (kind === null)
    return false;
  const lc = claimed.toLowerCase();
  switch (kind) {
    case "jpeg":
      return lc === "image/jpeg" || lc === "image/jpg";
    case "png":
      return lc === "image/png";
    case "gif":
      return lc === "image/gif";
    case "bmp":
      return lc === "image/bmp" || lc === "image/x-ms-bmp";
    case "webp":
      return lc === "image/webp";
    case "tiff":
      return lc === "image/tiff" || lc === "image/x-tiff";
    case "pdf":
      return lc === "application/pdf";
    case "zip":
      return lc === "application/zip" || lc === "application/x-zip-compressed";
    case "7z":
      return lc === "application/x-7z-compressed";
    case "text":
      return lc.startsWith("text/");
  }
}
