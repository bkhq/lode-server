import type { Asset, Version } from "@/shared/lib/registry/types";
import { describe, expect, it } from "vitest";
import {
  channelNameError,
  channelsOf,
  displayNameError,
  MAX_ID_LENGTH,
  publishedVersions,
  shortHash,
  totalSize,
  versionError,
} from "./-detail-validate";

function asset(name: string, size: number): Asset {
  return { name, size, sha256: "a".repeat(64), sig: null, key_id: null, alg: null, run: null, exec: null, created_at: "2026-01-01T00:00:00Z" };
}

function version(id: string, status: Version["status"], assets: Asset[] = []): Version {
  return { id, version: id, status, notes: null, published_at: null, created_at: "2026-01-01T00:00:00Z", assets };
}

describe("versionError", () => {
  it("accepts lode ids", () => {
    for (const id of ["1.0.0", "v2", "2026.10.1-rc_1", "A", "_x", "a".repeat(MAX_ID_LENGTH)])
      expect(versionError(id)).toBeUndefined();
  });

  it("rejects the empty string", () => {
    expect(versionError("")).toBe("empty");
  });

  it("rejects a leading '.' or '-'", () => {
    expect(versionError(".1")).toBe("leading");
    expect(versionError("-1")).toBe("leading");
  });

  it("rejects characters outside [A-Za-z0-9._-]", () => {
    for (const id of ["1.0 0", "1/0", "1+build", "v1\n", "版本"])
      expect(versionError(id)).toBe("charset");
  });

  it("rejects more than 128 characters", () => {
    expect(versionError("a".repeat(MAX_ID_LENGTH + 1))).toBe("tooLong");
  });
});

describe("channelNameError", () => {
  it("follows the same id rule as a version", () => {
    expect(channelNameError("stable")).toBeUndefined();
    expect(channelNameError("beta-2")).toBeUndefined();
    expect(channelNameError("")).toBe("empty");
    expect(channelNameError("-beta")).toBe("leading");
    expect(channelNameError("my channel")).toBe("charset");
    expect(channelNameError("c".repeat(MAX_ID_LENGTH + 1))).toBe("tooLong");
  });
});

describe("displayNameError", () => {
  it("accepts 1 to 100 characters after trimming", () => {
    expect(displayNameError("My App")).toBeUndefined();
    expect(displayNameError("  x  ")).toBeUndefined();
    expect(displayNameError("名".repeat(100))).toBeUndefined();
  });

  it("rejects a blank name", () => {
    expect(displayNameError("")).toBe("empty");
    expect(displayNameError("   ")).toBe("empty");
  });

  it("rejects more than 100 characters, counted as code points", () => {
    expect(displayNameError("a".repeat(101))).toBe("tooLong");
    expect(displayNameError("😀".repeat(100))).toBeUndefined();
    expect(displayNameError("😀".repeat(101))).toBe("tooLong");
  });
});

describe("version helpers", () => {
  it("keeps only published versions", () => {
    const versions = [version("3", "draft"), version("2", "published"), version("1", "yanked")];
    expect(publishedVersions(versions).map(v => v.version)).toEqual(["2"]);
  });

  it("lists the channels that point at a version", () => {
    const channels = [
      { name: "stable", version: "1.0.0", updated_at: "" },
      { name: "beta", version: "1.1.0", updated_at: "" },
      { name: "lts", version: "1.0.0", updated_at: "" },
    ];
    expect(channelsOf("1.0.0", channels)).toEqual(["stable", "lts"]);
    expect(channelsOf("9.9.9", channels)).toEqual([]);
  });

  it("sums asset sizes", () => {
    expect(totalSize([])).toBe(0);
    expect(totalSize([asset("a", 10), asset("b", 32)])).toBe(42);
  });

  it("shortens a sha256 to its first 12 characters", () => {
    expect(shortHash("0123456789abcdef0123")).toBe("0123456789ab");
    expect(shortHash("abc")).toBe("abc");
  });
});
