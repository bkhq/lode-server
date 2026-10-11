import { describe, expect, it } from "vitest";
import { scanMarkdownHeadings, slugify } from "./toc-scanner";

describe("slugify", () => {
  it("lowercases and dashes whitespace", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });
  it("strips punctuation", () => {
    expect(slugify("What's up?")).toBe("whats-up");
  });
  it("collapses repeated dashes and trims edges", () => {
    expect(slugify("  ---hello---  ")).toBe("hello");
  });
  it("strips non-ascii characters (matches GitHub's ASCII slugifier)", () => {
    expect(slugify("Chapter 1: 概述")).toBe("chapter-1");
  });
  it("returns empty for pure-punctuation input", () => {
    expect(slugify("!!!")).toBe("");
  });
});

describe("scanMarkdownHeadings", () => {
  it("parses ATX headings with levels", () => {
    const md = "# h1\n## h2\n### h3";
    const headings = scanMarkdownHeadings(md);
    expect(headings).toEqual([
      { level: 1, text: "h1", slug: "h1" },
      { level: 2, text: "h2", slug: "h2" },
      { level: 3, text: "h3", slug: "h3" },
    ]);
  });

  it("strips trailing # tokens (closing form)", () => {
    expect(scanMarkdownHeadings("## Title ##")[0]).toMatchObject({ text: "Title", slug: "title" });
  });

  it("ignores headings inside fenced code blocks", () => {
    const md = "# real\n```\n# fake\n```\n## also-real";
    expect(scanMarkdownHeadings(md).map(h => h.text)).toEqual(["real", "also-real"]);
  });

  it("ignores headings inside tilde-fenced code blocks", () => {
    const md = "# real\n~~~\n# fake\n~~~\n## also-real";
    expect(scanMarkdownHeadings(md).map(h => h.text)).toEqual(["real", "also-real"]);
  });

  it("ignores 4-space-indented (code) lines", () => {
    const md = "# real\n    # fake-indented\n## also-real";
    expect(scanMarkdownHeadings(md).map(h => h.text)).toEqual(["real", "also-real"]);
  });

  it("deduplicates colliding slugs by appending a counter", () => {
    const md = "# Hello\n# Hello\n# Hello";
    expect(scanMarkdownHeadings(md).map(h => h.slug)).toEqual(["hello", "hello-1", "hello-2"]);
  });

  it("requires the space after #", () => {
    expect(scanMarkdownHeadings("#nope\n# yes")).toEqual([
      { level: 1, text: "yes", slug: "yes" },
    ]);
  });

  it("returns an empty list for an empty document", () => {
    expect(scanMarkdownHeadings("")).toEqual([]);
  });

  it("skips lines that would produce an empty slug", () => {
    expect(scanMarkdownHeadings("# !!!\n# real")).toEqual([
      { level: 1, text: "real", slug: "real" },
    ]);
  });
});
