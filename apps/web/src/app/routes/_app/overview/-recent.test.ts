import type { RegistryPackage, Version } from "@/shared/lib/registry/types";
import { describe, expect, it } from "vitest";
import { pickRecentPackages, recentVersions } from "./-recent";

function pkg(slug: string, updatedAt: string): RegistryPackage {
  return {
    id: `id-${slug}`,
    namespace: "ab12cd34",
    slug,
    name: slug.toUpperCase(),
    visibility: "private",
    description: null,
    require_signature: false,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: updatedAt,
  };
}

function version(v: string, createdAt: string, publishedAt: string | null = null): Version {
  return {
    id: `id-${v}`,
    version: v,
    status: publishedAt ? "published" : "draft",
    notes: null,
    published_at: publishedAt,
    created_at: createdAt,
    assets: [],
  };
}

describe("pickRecentPackages", () => {
  it("returns nothing for empty input", () => {
    expect(pickRecentPackages([], 5)).toEqual([]);
  });

  it("orders by updated_at, newest first", () => {
    const packages = [
      pkg("old", "2026-03-01T00:00:00.000Z"),
      pkg("new", "2026-05-01T00:00:00.000Z"),
      pkg("mid", "2026-04-01T00:00:00.000Z"),
    ];
    expect(pickRecentPackages(packages, 5).map(p => p.slug)).toEqual(["new", "mid", "old"]);
  });

  it("caps the result at n", () => {
    const packages = [
      pkg("a", "2026-03-01T00:00:00.000Z"),
      pkg("b", "2026-05-01T00:00:00.000Z"),
      pkg("c", "2026-04-01T00:00:00.000Z"),
    ];
    expect(pickRecentPackages(packages, 2).map(p => p.slug)).toEqual(["b", "c"]);
    expect(pickRecentPackages(packages, 0)).toEqual([]);
  });

  it("keeps input order between packages updated at the same instant", () => {
    const packages = [
      pkg("first", "2026-04-01T00:00:00.000Z"),
      pkg("second", "2026-04-01T00:00:00.000Z"),
      pkg("third", "2026-04-01T00:00:00.000Z"),
    ];
    expect(pickRecentPackages(packages, 2).map(p => p.slug)).toEqual(["first", "second"]);
  });

  it("does not mutate its input", () => {
    const packages = [
      pkg("old", "2026-03-01T00:00:00.000Z"),
      pkg("new", "2026-05-01T00:00:00.000Z"),
    ];
    pickRecentPackages(packages, 5);
    expect(packages.map(p => p.slug)).toEqual(["old", "new"]);
  });
});

describe("recentVersions", () => {
  const a = pkg("a", "2026-05-01T00:00:00.000Z");
  const b = pkg("b", "2026-04-01T00:00:00.000Z");

  it("returns nothing for empty input", () => {
    expect(recentVersions([], 5)).toEqual([]);
    expect(recentVersions([
      { package: a, versions: [] },
    ], 5)).toEqual([]);
  });

  it("merges versions across packages, newest first", () => {
    const result = recentVersions([
      {
        package: a,
        versions: [
          version("1.0.0", "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"),
          version("1.1.0", "2026-03-01T00:00:00.000Z", "2026-03-02T00:00:00.000Z"),
        ],
      },
      {
        package: b,
        versions: [
          version("0.1.0", "2026-02-01T00:00:00.000Z", "2026-02-02T00:00:00.000Z"),
        ],
      },
    ], 5);
    expect(result.map(r => `${r.package.slug}@${r.version.version}`)).toEqual([
      "a@1.1.0",
      "b@0.1.0",
      "a@1.0.0",
    ]);
  });

  it("exposes the instant an entry was sorted by", () => {
    const result = recentVersions([
      {
        package: a,
        versions: [
          version("1.0.0", "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"),
          version("1.1.0", "2026-03-01T00:00:00.000Z"),
        ],
      },
    ], 5);
    expect(result.map(r => r.at)).toEqual(["2026-03-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"]);
  });

  it("sorts a draft without published_at by created_at", () => {
    const result = recentVersions([
      {
        package: a,
        versions: [
          version("1.0.0", "2026-01-01T00:00:00.000Z", "2026-01-10T00:00:00.000Z"),
          version("2.0.0-draft", "2026-01-05T00:00:00.000Z"),
        ],
      },
      {
        package: b,
        versions: [
          version("0.2.0-draft", "2026-01-20T00:00:00.000Z"),
        ],
      },
    ], 5);
    expect(result.map(r => r.version.version)).toEqual(["0.2.0-draft", "1.0.0", "2.0.0-draft"]);
  });

  it("prefers published_at over created_at", () => {
    const result = recentVersions([
      {
        package: a,
        versions: [
          version("early-created", "2026-01-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z"),
          version("late-created", "2026-02-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z"),
        ],
      },
    ], 5);
    expect(result.map(r => r.version.version)).toEqual(["early-created", "late-created"]);
  });

  it("caps the result at n", () => {
    const versions = Array.from({ length: 8 }, (_, i) =>
      version(`1.${i}.0`, `2026-01-0${i + 1}T00:00:00.000Z`));
    const result = recentVersions([
      { package: a, versions },
    ], 5);
    expect(result.map(r => r.version.version)).toEqual([
      "1.7.0",
      "1.6.0",
      "1.5.0",
      "1.4.0",
      "1.3.0",
    ]);
  });

  it("keeps input order between versions at the same instant", () => {
    const at = "2026-01-01T00:00:00.000Z";
    const result = recentVersions([
      {
        package: a,
        versions: [
          version("1.0.0", at),
          version("1.0.1", at),
        ],
      },
      {
        package: b,
        versions: [
          version("0.1.0", at),
        ],
      },
    ], 5);
    expect(result.map(r => `${r.package.slug}@${r.version.version}`)).toEqual([
      "a@1.0.0",
      "a@1.0.1",
      "b@0.1.0",
    ]);
  });
});
