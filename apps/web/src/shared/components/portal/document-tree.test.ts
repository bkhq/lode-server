import type { DocumentTreeNode } from "@/shared/lib/api/documents";
import { describe, expect, it } from "vitest";

import {
  ancestorIds,
  buildTreeIndex,
  flattenVisible,
  stepFocus,
  subtreeIds,
  toggleId,
} from "./document-tree.utils";

function n(id: string, parentId: string | null, title = id, childCount = 0): DocumentTreeNode {
  return {
    id,
    parentId,
    title,
    childCount,
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

// A small fixture:
//   root
//     a
//       a1
//       a2
//         a2a
//     b
const fixture: readonly DocumentTreeNode[] = [
  n("a", null),
  n("a1", "a"),
  n("a2", "a"),
  n("a2a", "a2"),
  n("b", null),
];

describe("buildTreeIndex", () => {
  it("buckets children under their parent and roots", () => {
    const idx = buildTreeIndex(fixture);
    expect(idx.childrenOf.get("")?.map(n => n.id)).toEqual(["a", "b"]);
    expect(idx.childrenOf.get("a")?.map(n => n.id)).toEqual(["a1", "a2"]);
    expect(idx.childrenOf.get("a2")?.map(n => n.id)).toEqual(["a2a"]);
  });

  it("counts descendants recursively", () => {
    const idx = buildTreeIndex(fixture);
    expect(idx.descendantCount.get("a")).toBe(3); // a1, a2, a2a
    expect(idx.descendantCount.get("a2")).toBe(1);
    expect(idx.descendantCount.get("b")).toBe(0);
  });

  it("treats orphans (parent we cannot read) as roots", () => {
    const idx = buildTreeIndex([
      n("orphan", "missing-parent"),
    ]);
    expect(idx.childrenOf.get("")?.map(n => n.id)).toEqual(["orphan"]);
  });

  it("does not loop on a self-cycle", () => {
    const idx = buildTreeIndex([
      n("loop", "loop"),
    ]);
    // The cycle still gets indexed under its own id; descendantCount must terminate.
    expect(idx.descendantCount.get("loop")).toBeGreaterThanOrEqual(0);
  });
});

describe("flattenVisible", () => {
  it("walks DFS over expanded subtrees only", () => {
    const idx = buildTreeIndex(fixture);
    const collapsed = flattenVisible(idx, new Set());
    expect(collapsed.map(v => v.node.id)).toEqual(["a", "b"]);

    const oneOpen = flattenVisible(idx, new Set(["a"]));
    expect(oneOpen.map(v => v.node.id)).toEqual(["a", "a1", "a2", "b"]);

    const twoOpen = flattenVisible(idx, new Set(["a", "a2"]));
    expect(twoOpen.map(v => v.node.id)).toEqual(["a", "a1", "a2", "a2a", "b"]);
  });

  it("reports depth so the renderer can indent", () => {
    const idx = buildTreeIndex(fixture);
    const flat = flattenVisible(idx, new Set(["a", "a2"]));
    const depths = Object.fromEntries(flat.map(v => [v.node.id, v.depth]));
    expect(depths).toEqual({ a: 0, a1: 1, a2: 1, a2a: 2, b: 0 });
  });
});

describe("ancestorIds", () => {
  it("walks parentId upward", () => {
    const idx = buildTreeIndex(fixture);
    expect(ancestorIds(idx, "a2a")).toEqual(["a2", "a"]);
    expect(ancestorIds(idx, "a")).toEqual([]);
  });

  it("terminates on a missing leaf", () => {
    const idx = buildTreeIndex(fixture);
    expect(ancestorIds(idx, "missing")).toEqual([]);
  });
});

describe("subtreeIds", () => {
  it("returns the node and every descendant id", () => {
    const idx = buildTreeIndex(fixture);
    expect([
      ...subtreeIds(idx, "a"),
    ].sort()).toEqual(["a", "a1", "a2", "a2a"]);
    expect([
      ...subtreeIds(idx, "b"),
    ]).toEqual(["b"]);
  });
});

describe("toggleId", () => {
  it("returns a new set with the id added or removed", () => {
    const before = new Set(["a"]);
    const added = toggleId(before, "b");
    expect([...added].sort()).toEqual(["a", "b"]);
    expect(before.has("b")).toBe(false);

    const removed = toggleId(added, "a");
    expect([...removed]).toEqual(["b"]);
  });
});

describe("stepFocus", () => {
  it("starts at the head when nothing is focused yet", () => {
    const idx = buildTreeIndex(fixture);
    const visible = flattenVisible(idx, new Set());
    expect(stepFocus(visible, null, 1)).toBe("a");
    expect(stepFocus(visible, null, -1)).toBe("b");
  });

  it("steps within the visible window", () => {
    const idx = buildTreeIndex(fixture);
    const visible = flattenVisible(idx, new Set(["a"]));
    // visible: a, a1, a2, b
    expect(stepFocus(visible, "a", 1)).toBe("a1");
    expect(stepFocus(visible, "a2", -1)).toBe("a1");
  });

  it("wraps at the ends", () => {
    const idx = buildTreeIndex(fixture);
    const visible = flattenVisible(idx, new Set(["a"]));
    // last item is b
    expect(stepFocus(visible, "b", 1)).toBe("a");
    expect(stepFocus(visible, "a", -1)).toBe("b");
  });

  it("returns null on an empty list", () => {
    expect(stepFocus([], "x", 1)).toBe(null);
  });
});
