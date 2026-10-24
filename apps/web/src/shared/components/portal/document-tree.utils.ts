// Pure helpers for the nested document tree. Kept side-effect free so the
// component layer stays small and the recursion + descendant logic can be
// unit-tested without React.

import type { DocumentTreeNode } from "@/shared/lib/api/documents";
import { storageKey } from "@/shared/lib/branding";

export interface TreeIndex {
  /** Map of parentId ('' = root) → ordered children. */
  readonly childrenOf: ReadonlyMap<string, readonly DocumentTreeNode[]>;
  /** Map of node id → its node. */
  readonly byId: ReadonlyMap<string, DocumentTreeNode>;
  /** Map of node id → number of all descendants (children + grandchildren …). */
  readonly descendantCount: ReadonlyMap<string, number>;
}

const ROOT = "";

/**
 * Builds an index of the flat tree payload returned by `/documents/tree`.
 * Children inherit the server's order (already sorted by lower-cased title).
 *
 * Orphans — nodes whose parentId points at something we cannot read — float to
 * the root so they remain visible. Without this, sharing a deeply nested doc
 * without its ancestors would silently hide it.
 */
export function buildTreeIndex(nodes: readonly DocumentTreeNode[]): TreeIndex {
  const byId = new Map<string, DocumentTreeNode>();
  for (const n of nodes)
    byId.set(n.id, n);

  const childrenOf = new Map<string, DocumentTreeNode[]>();
  for (const n of nodes) {
    const parent = n.parentId && byId.has(n.parentId)
      ? n.parentId
      : ROOT;
    const list = childrenOf.get(parent);
    if (list)
      list.push(n);
    else
      childrenOf.set(parent, [n]);
  }

  // Recursively count descendants. Cycle-safe via memo + visited.
  const descendantCount = new Map<string, number>();
  const visiting = new Set<string>();
  const compute = (id: string): number => {
    if (descendantCount.has(id))
      return descendantCount.get(id)!;
    if (visiting.has(id))
      return 0;
    visiting.add(id);
    const kids = childrenOf.get(id) ?? [];
    let total = kids.length;
    for (const k of kids)
      total += compute(k.id);
    visiting.delete(id);
    descendantCount.set(id, total);
    return total;
  };
  for (const n of nodes)
    compute(n.id);

  return { childrenOf, byId, descendantCount };
}

/**
 * Returns the visible nodes in DFS order, skipping subtrees whose root is not
 * expanded. This is what keyboard up/down walks over and what the picker
 * dialog renders.
 */
export function flattenVisible(
  index: TreeIndex,
  expanded: ReadonlySet<string>,
): readonly { node: DocumentTreeNode; depth: number }[] {
  const out: { node: DocumentTreeNode; depth: number }[] = [];
  const walk = (parentId: string, depth: number): void => {
    const kids = index.childrenOf.get(parentId) ?? [];
    for (const k of kids) {
      out.push({ node: k, depth });
      if (expanded.has(k.id))
        walk(k.id, depth + 1);
    }
  };
  walk(ROOT, 0);
  return out;
}

/**
 * Walks `parentId` upward from `id` and returns the ancestor ids (excluding
 * `id` itself). Used to auto-expand the path to the active document so the
 * highlighted row is in view after navigation.
 */
export function ancestorIds(index: TreeIndex, id: string): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let cursor: string | null = index.byId.get(id)?.parentId ?? null;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    out.push(cursor);
    cursor = index.byId.get(cursor)?.parentId ?? null;
  }
  return out;
}

/**
 * Returns the set of `id` plus every descendant. The move-picker uses this to
 * grey out invalid drop targets — moving a node under itself or its own
 * subtree creates a cycle.
 */
export function subtreeIds(index: TreeIndex, id: string): ReadonlySet<string> {
  const out = new Set<string>([id]);
  const stack = [id];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const k of index.childrenOf.get(cur) ?? []) {
      if (!out.has(k.id)) {
        out.add(k.id);
        stack.push(k.id);
      }
    }
  }
  return out;
}

/** Toggles `id` in a set without mutating the input. */
export function toggleId(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(set);
  if (next.has(id))
    next.delete(id);
  else
    next.add(id);
  return next;
}

/**
 * Returns the next visible id when stepping by `delta` rows. Wraps to the
 * other end so arrow-down on the last row jumps back to the top — matches
 * Outline / Notion behaviour.
 */
export function stepFocus(
  visible: readonly { node: DocumentTreeNode }[],
  current: string | null,
  delta: 1 | -1,
): string | null {
  if (visible.length === 0)
    return null;
  if (current === null) {
    return visible[delta > 0
      ? 0
      : visible.length - 1]!.node.id;
  }
  const idx = visible.findIndex(v => v.node.id === current);
  if (idx === -1)
    return visible[0]!.node.id;
  const next = (idx + delta + visible.length) % visible.length;
  return visible[next]!.node.id;
}

/**
 * Reads/writes the persisted expanded-set. Keyed globally, not per-user — the
 * spec calls this out explicitly. `null` from the reader means "use default".
 */
const STORAGE_KEY = storageKey("documents:expanded");

export function readPersistedExpansion(): ReadonlySet<string> | null {
  if (typeof window === "undefined")
    return null;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw)
    return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed))
      return null;
    return new Set(parsed.filter((v): v is string => typeof v === "string"));
  }
  catch {
    return null;
  }
}

export function writePersistedExpansion(expanded: ReadonlySet<string>): void {
  if (typeof window === "undefined")
    return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(expanded)));
  }
  catch {
    // Storage quota / private mode — silently degrade.
  }
}
