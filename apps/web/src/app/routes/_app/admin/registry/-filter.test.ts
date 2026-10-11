import { describe, expect, it } from "vitest";
import { filterRows, matchesFilter } from "./-filter";

describe("matchesFilter", () => {
  it("matches everything for an empty or blank query", () => {
    expect(matchesFilter("", ["alice"])).toBe(true);
    expect(matchesFilter("   ", [])).toBe(true);
  });

  it("matches a substring of any field", () => {
    expect(matchesFilter("lic", ["Alice Liddell", "aliddell"])).toBe(true);
    expect(matchesFilter("k3x9", ["Alice", "alice", "ab12k3x9"])).toBe(true);
    expect(matchesFilter("bob", ["Alice", "alice", "ab12k3x9"])).toBe(false);
  });

  it("ignores case on both sides", () => {
    expect(matchesFilter("ALICE", ["alice"])).toBe(true);
    expect(matchesFilter("alice", ["ALICE"])).toBe(true);
  });

  it("trims the query", () => {
    expect(matchesFilter("  alice ", ["alice"])).toBe(true);
  });

  it("skips null and undefined fields", () => {
    expect(matchesFilter("null", [null, undefined])).toBe(false);
    expect(matchesFilter("a", [null, "abc"])).toBe(true);
  });

  it("does not match across field boundaries", () => {
    expect(matchesFilter("ab", ["a", "b"])).toBe(false);
  });
});

describe("filterRows", () => {
  const rows = [
    { owner: "Alice", slug: "tool" },
    { owner: "Bob", slug: "alice-fork" },
    { owner: "Carol", slug: "lib" },
  ];
  const fields = (r: typeof rows[number]) => [r.owner, r.slug];

  it("keeps the rows with a matching field, in order", () => {
    expect(filterRows(rows, "alice", fields)).toEqual([rows[0], rows[1]]);
  });

  it("returns every row for an empty query", () => {
    expect(filterRows(rows, "", fields)).toEqual(rows);
  });

  it("returns nothing when no row matches", () => {
    expect(filterRows(rows, "zzz", fields)).toEqual([]);
  });
});
