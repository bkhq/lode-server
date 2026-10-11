// Pure markdown heading parser and slugifier. Kept in its own module (and
// not under toc.tsx) so React Fast Refresh stays happy — toc.tsx exports
// components and a hook, everything pure lives here.

export interface HeadingNode {
  readonly level: number;
  readonly text: string;
  readonly slug: string;
}

// GitHub-ish slugifier: lowercase, drop punctuation other than dashes,
// collapse whitespace to single dashes. Collisions get `-N` suffixes via
// the counter in `scanMarkdownHeadings`.
const RE_INVALID = /[^\w\s-]/g;
const RE_WHITESPACE = /\s+/g;
const RE_DASH_COLLAPSE = /-+/g;
const RE_EDGE_DASHES = /^-|-$/g;

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(RE_INVALID, "")
    .replace(RE_WHITESPACE, "-")
    .replace(RE_DASH_COLLAPSE, "-")
    .replace(RE_EDGE_DASHES, "");
}

// Single mandatory space after the # tokens — extra spaces are trimmed in
// JS. Earlier patterns that allowed ` +` next to `.*?` overlapped on
// whitespace and the linter flagged them as super-linear backtracking.
const RE_HEADING = /^(#{1,6}) (.*)$/;
const RE_TRAILING_HASHES = / +#+$/;
const RE_FENCE = /^\s{0,3}(```|~~~)/;
const RE_INDENT_CODE = /^ {4,}/;

/**
 * Parses ATX-style headings out of markdown. Skips fenced code blocks and
 * indented (4-space) code blocks so a `# title` inside a code sample never
 * pollutes the TOC. Setext headings (===, ---) are not parsed — Lexical's
 * markdown round-trip emits ATX exclusively, so adding setext support
 * would just enlarge the surface for no document we'd actually see.
 */
export function scanMarkdownHeadings(markdown: string): HeadingNode[] {
  const headings: HeadingNode[] = [];
  const slugCounts = new Map<string, number>();
  let inFence = false;
  let fenceMarker: string | undefined;

  for (const rawLine of markdown.split("\n")) {
    const fenceMatch = RE_FENCE.exec(rawLine);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!marker)
        continue;
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      }
      else if (marker === fenceMarker) {
        inFence = false;
        fenceMarker = undefined;
      }
      continue;
    }
    if (inFence)
      continue;
    if (RE_INDENT_CODE.test(rawLine))
      continue;

    const match = RE_HEADING.exec(rawLine);
    if (!match || !match[1] || !match[2])
      continue;

    const level = match[1].length;
    let text = match[2].trimEnd();
    const trailing = RE_TRAILING_HASHES.exec(text);
    if (trailing)
      text = text.slice(0, -trailing[0].length);
    text = text.trim();
    if (!text)
      continue;
    const base = slugify(text);
    if (!base)
      continue;
    const seen = slugCounts.get(base) ?? 0;
    slugCounts.set(base, seen + 1);
    const slug = seen === 0 ? base : `${base}-${seen}`;
    headings.push({ level, text, slug });
  }

  return headings;
}
