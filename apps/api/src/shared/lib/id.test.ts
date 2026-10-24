import { describe, expect, it, setSystemTime } from "bun:test";
import { ulidTimestamp } from "./id";

describe("ulidTimestamp", () => {
  it("reads back the millisecond a ULID was minted at", () => {
    // `ulid(1469918176385)` from the ULID spec, lowercased as `ulid()` emits it.
    expect(ulidTimestamp("01aryz6s41tsv4rrffq69g5fav")).toBe(new Date(1469918176385).toISOString());
  });

  it("falls back to now for an id that is not a ULID", () => {
    setSystemTime(new Date("2026-06-14T08:30:15.123Z"));
    try {
      expect(ulidTimestamp("not-a-ulid")).toBe("2026-06-14T08:30:15.123Z");
    }
    finally {
      setSystemTime();
    }
  });
});
