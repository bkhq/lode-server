import { describe, expect, it } from "vitest";
import { versionCounts } from "./-detail-observe-data";

describe("versionCounts", () => {
  it("counts online instances per version, most common first, unknown last", () => {
    expect(versionCounts([
      { version: "1.0.0", online: true },
      { version: "1.1.0", online: true },
      { version: "1.1.0", online: true },
      { version: null, online: true },
      { version: "0.9.0", online: false },
    ])).toEqual([
      { version: "1.1.0", count: 2 },
      { version: "1.0.0", count: 1 },
      { version: null, count: 1 },
    ]);
  });
});
