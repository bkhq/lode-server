import { describe, expect, it } from "vitest";
import { partitionBySize, validateAttachmentSelection } from "./attachment-upload";

function makeFile(name: string, size: number): File {
  return new File([new Uint8Array(size)], name, { type: "text/plain" });
}

describe("validateAttachmentSelection", () => {
  it("rejects selections beyond the remaining slot count", () => {
    const result = validateAttachmentSelection([makeFile("a.txt", 10), makeFile("b.txt", 10)], 19, 1024, 20);
    expect(result).toBe("limit");
  });

  it("rejects oversized files", () => {
    const result = validateAttachmentSelection([makeFile("a.txt", 2048)], 0, 1024, 20);
    expect(result).toBe("size");
  });

  it("accepts selections within limits", () => {
    const result = validateAttachmentSelection([makeFile("a.txt", 512)], 2, 1024, 20);
    expect(result).toBe("ok");
  });
});

describe("partitionBySize", () => {
  it("splits files by the per-file size cap", () => {
    const small = makeFile("small.txt", 100);
    const big = makeFile("big.txt", 5000);
    const { accepted, rejected } = partitionBySize([small, big], 1024);
    expect(accepted).toEqual([small]);
    expect(rejected).toEqual([big]);
  });

  it("accepts all when every file is within the cap", () => {
    const a = makeFile("a.txt", 100);
    const b = makeFile("b.txt", 200);
    const { accepted, rejected } = partitionBySize([a, b], 1024);
    expect(accepted).toEqual([a, b]);
    expect(rejected).toEqual([]);
  });
});
