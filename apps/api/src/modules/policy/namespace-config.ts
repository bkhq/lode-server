interface ComputedUserset {
  readonly relation: string;
}

interface TupleToUserset {
  readonly tupleset: string;
  readonly computed_userset: string;
}

type RelationRuleEntry
  = | { readonly this: Record<string, never> }
    | { readonly computed_userset: ComputedUserset }
    | { readonly tuple_to_userset: TupleToUserset };

interface RelationRule {
  readonly union: readonly RelationRuleEntry[];
}

export interface NamespaceConfig {
  readonly name: string;
  readonly relations?: Readonly<Record<string, RelationRule>>;
}

const namespaceRegistry = new Map<string, NamespaceConfig>();

const defaultNamespaces: readonly NamespaceConfig[] = [
  { name: "user" },
  {
    name: "group",
    relations: {
      member: { union: [{ this: {} }] },
    },
  },
  {
    name: "resource_group",
    relations: {
      viewer: {
        union: [{ this: {} }, { computed_userset: { relation: "editor" } }],
      },
      editor: {
        union: [{ this: {} }, { computed_userset: { relation: "manager" } }],
      },
      manager: {
        union: [{ this: {} }, { computed_userset: { relation: "admin" } }],
      },
      admin: { union: [{ this: {} }] },
      member: { union: [{ this: {} }] },
    },
  },
  // `item` is the permission namespace for the item base module
  // (`apps/api/src/modules/item/`). Every sub-type that builds on `item`
  // (issue, document, …) writes its access tuples here.
  //
  // Relations:
  // - owner    : creator; full control. Written by ItemService.createItem.
  // - editor   : can modify; implied by owner.
  // - viewer   : can read; implied by editor and by assignee. Also inherited from any
  //              ancestor `item` reached via the parent_item edge — this is
  //              how document subtree visibility works (a viewer/editor on a
  //              parent item flows down to its descendants).
  // - assignee : current handler (issue assignee); implied by owner. The
  //              relation is here so sub-types can list "items assigned to
  //              me" without each rolling its own indexed column.
  // - approver : current approver in an approval flow (e.g. expense).
  //              Stays narrow (no implicit inheritance) so revoking it on
  //              status transitions is straightforward.
  // - watcher  : notification-only subscriber. No visibility implications;
  //              sub-types decide whether watching also grants read.
  // - parent_item : item → item edge. Only the upward edge is stored
  //                 (`(item, child, parent_item, item, parent)`); the
  //                 downward enumeration is a recursive CTE on tuples.
  {
    name: "item",
    relations: {
      owner: { union: [{ this: {} }] },
      editor: {
        union: [
          { this: {} },
          { computed_userset: { relation: "owner" } },
          { tuple_to_userset: { tupleset: "parent_item", computed_userset: "editor" } },
        ],
      },
      viewer: {
        union: [
          { this: {} },
          { computed_userset: { relation: "editor" } },
          // The current handler of an item can always read it. This is the
          // one rule the issue routes used to encode by hand
          // (`creatorId || assigneeId`); keeping it in the namespace means
          // every path — routes, attachments, comments — agrees.
          { computed_userset: { relation: "assignee" } },
          { tuple_to_userset: { tupleset: "parent_item", computed_userset: "viewer" } },
        ],
      },
      assignee: {
        union: [{ this: {} }, { computed_userset: { relation: "owner" } }],
      },
      approver: { union: [{ this: {} }] },
      watcher: { union: [{ this: {} }] },
      parent_item: { union: [{ this: {} }] },
    },
  },
];

// Namespaces modules add with `registerNamespace`, kept apart from the
// registry so `loadNamespaces()` can rebuild it without losing them.
const moduleNamespaces = new Map<string, NamespaceConfig>();

/**
 * Reset the registry. With no argument it holds the shipped defaults plus
 * every namespace registered by a module; with `configs` it holds exactly
 * those, which tests use to run against a namespace set of their own.
 */
export function loadNamespaces(configs?: readonly NamespaceConfig[]): void {
  namespaceRegistry.clear();
  for (const config of configs ?? [...defaultNamespaces, ...moduleNamespaces.values()]) {
    namespaceRegistry.set(config.name, config);
  }
}

/**
 * Add a module's namespace, typically from the module's `index.ts`.
 * Registering an identical config again is a no-op; a different config under
 * a name already taken — a shipped namespace or another module's — throws,
 * since it would silently change that namespace's access ladder.
 */
export function registerNamespace(config: NamespaceConfig): void {
  const existing = defaultNamespaces.find(ns => ns.name === config.name) ?? moduleNamespaces.get(config.name);
  if (existing !== undefined) {
    if (JSON.stringify(existing) === JSON.stringify(config))
      return;
    throw new Error(`[policy] namespace "${config.name}" is already registered with a different config`);
  }
  moduleNamespaces.set(config.name, config);
  namespaceRegistry.set(config.name, config);
}

/** Test hook: drop a module namespace. Call `loadNamespaces()` afterwards. */
export function __unregisterNamespaceForTests(name: string): void {
  moduleNamespaces.delete(name);
}

export function getNamespace(name: string): NamespaceConfig | undefined {
  return namespaceRegistry.get(name);
}

export function getAllNamespaces(): ReadonlyMap<string, NamespaceConfig> {
  return namespaceRegistry;
}

/**
 * Get the higher-level relations that imply the given relation.
 * e.g. getParentRelations("app", "viewer") → ["manager"]
 * because viewer's union includes computed_userset{relation: "manager"},
 * meaning having "manager" implies having "viewer".
 */
export function getParentRelations(namespace: string, relation: string): readonly string[] {
  const ns = namespaceRegistry.get(namespace);
  if (!ns?.relations)
    return [];

  const rel = ns.relations[relation];
  if (!rel)
    return [];

  const parents: string[] = [];
  for (const entry of rel.union) {
    if ("computed_userset" in entry) {
      parents.push(entry.computed_userset.relation);
    }
  }
  return parents;
}

export function getTupleToUsersetRules(namespace: string, relation: string): readonly TupleToUserset[] {
  const ns = namespaceRegistry.get(namespace);
  if (!ns?.relations)
    return [];

  const rel = ns.relations[relation];
  if (!rel)
    return [];

  const rules: TupleToUserset[] = [];
  for (const entry of rel.union) {
    if ("tuple_to_userset" in entry) {
      rules.push(entry.tuple_to_userset);
    }
  }
  return rules;
}

export function getValidRelations(namespace: string): readonly string[] {
  const ns = namespaceRegistry.get(namespace);
  if (!ns?.relations)
    return [];
  return Object.keys(ns.relations);
}

// Load defaults on import
loadNamespaces();
