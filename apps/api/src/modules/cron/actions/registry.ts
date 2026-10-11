import type { ActionDef, ActionExecutor, ActionInput } from "./types";

// ─── Constructor ────────────────────────────────────────────────────

/**
 * Type-safe constructor for an action definition. The two layers stay
 * physically separate at the call site:
 *
 *   - `spec`    — declarative metadata + input schema (`ActionSpec`)
 *   - `execute` — the function that does the work (`ActionExecutor`)
 *
 * The returned object (and its `spec`) are frozen so a registered
 * action can't be mutated out from under callers that hold a reference
 * (catalog readers, the cron task runner, etc.). Per-input field
 * mutability is already enforced at the type level via `readonly`.
 *
 * Pattern for external modules:
 *
 * ```ts
 * import { defineAction, registerAction } from "@/modules/cron";
 *
 * const spec: ActionSpec = { name: "my-action", ... };
 * const execute: ActionExecutor = async (ctx, cfg) => "done";
 *
 * registerAction(defineAction({ spec, execute }));
 * ```
 *
 * Per the convention in `docs/modules/cron.md`, the call lives at the
 * module's `index.ts` top level so registration happens as a side
 * effect of importing the module.
 */
export function defineAction(def: ActionDef): ActionDef {
  return Object.freeze({
    spec: Object.freeze({ ...def.spec }),
    execute: def.execute,
  });
}

// ─── Registry storage ───────────────────────────────────────────────

const actions = new Map<string, ActionDef>();

/**
 * Add an action to the in-process registry. Throws on duplicate names
 * so misconfigured modules don't silently shadow each other.
 *
 * Call this from your module's `index.ts` top-level (paired with
 * `defineAction()` for type safety). Registration happens as a side
 * effect of importing the module, mirroring how the rest of the
 * template wires module-owned data (cf. `registerBackupContribution`).
 */
export function registerAction(def: ActionDef): void {
  if (actions.has(def.spec.name)) {
    throw new Error(`Cron action "${def.spec.name}" is already registered`);
  }
  actions.set(def.spec.name, def);
}

/** Return the full ActionDef (spec + executor). */
export function getAction(name: string): ActionDef | undefined {
  return actions.get(name);
}

/** Return only the executor function — for the cron task runner. */
export function getActionExecutor(name: string): ActionExecutor | undefined {
  return actions.get(name)?.execute;
}

export function getActionNames(): string[] {
  return [...actions.keys()];
}

export interface DefaultAction {
  readonly name: string;
  readonly cron: string;
  readonly runOnStartup: boolean;
}

/** Return actions that declare a defaultCron (used for auto-seeding DB on startup). */
export function getDefaultActions(): DefaultAction[] {
  const defaults: DefaultAction[] = [];
  for (const [name, def] of actions) {
    if (def.spec.defaultCron) {
      defaults.push({ name, cron: def.spec.defaultCron, runOnStartup: def.spec.runOnStartup ?? false });
    }
  }
  return defaults;
}

// ─── Public catalog ─────────────────────────────────────────────────

/**
 * Public-facing entry surfaced by `GET /api/cron/actions`. Mirrors
 * `ActionSpec` minus the `validate` closure (which can't cross the wire)
 * plus a derived `requiredKeys` for SPAs that don't want to walk
 * `inputs[]` themselves. Optional `ActionSpec` fields are normalized to
 * `null` so the JSON shape is stable for clients.
 */
export interface ActionCatalogEntry {
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly category: string;
  readonly icon: string | null;
  readonly tags: readonly string[];
  readonly version: string | null;
  readonly dangerous: boolean;
  readonly defaultCron: string | null;
  readonly inputs: readonly ActionInput[];
  readonly requiredKeys: readonly string[];
}

export function getActionsCatalog(): ActionCatalogEntry[] {
  const entries: ActionCatalogEntry[] = [];
  for (const [name, def] of actions) {
    const inputs = def.spec.inputs ?? [];
    entries.push({
      name,
      displayName: def.spec.displayName,
      description: def.spec.description,
      category: def.spec.category,
      icon: def.spec.icon ?? null,
      tags: def.spec.tags ?? [],
      version: def.spec.version ?? null,
      dangerous: def.spec.dangerous ?? false,
      defaultCron: def.spec.defaultCron ?? null,
      inputs,
      requiredKeys: inputs.filter(i => i.required).map(i => i.key),
    });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Create-time validation ─────────────────────────────────────────

function isEmptyValue(v: unknown): boolean {
  return v === null || v === undefined || v === "";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate `config` against the action's declared `inputs[]`:
 *   1. Every `required: true` input must have a non-empty value.
 *   2. The value must satisfy the declared `type` (numbers parse,
 *      selects are in `options`, json values are plain objects, …).
 *   3. The optional `spec.validate(config)` callback runs last for
 *      cross-field rules.
 */
export async function validateActionConfig(
  action: string,
  config: Record<string, unknown>,
): Promise<string | null> {
  const def = actions.get(action);
  if (!def) {
    return `Unknown action: "${action}". Available: ${getActionNames().join(", ")}`;
  }

  for (const input of def.spec.inputs ?? []) {
    const value = config[input.key];
    if (isEmptyValue(value)) {
      if (input.required)
        return `config.${input.key} is required for action "${action}"`;
      continue;
    }
    const typeError = checkInputType(input, value);
    if (typeError)
      return typeError;
  }

  if (def.spec.validate) {
    return def.spec.validate(config);
  }

  return null;
}

function checkInputType(input: ActionInput, value: unknown): string | null {
  switch (input.type) {
    case "string":
    case "textarea":
    case "secret":
      if (typeof value !== "string")
        return `config.${input.key} must be a string`;
      return null;
    case "number": {
      const n = Number(value);
      if (!Number.isFinite(n))
        return `config.${input.key} must be a number`;
      if (input.min !== undefined && n < input.min)
        return `config.${input.key} must be >= ${input.min}`;
      if (input.max !== undefined && n > input.max)
        return `config.${input.key} must be <= ${input.max}`;
      return null;
    }
    case "boolean":
      if (typeof value !== "boolean")
        return `config.${input.key} must be a boolean`;
      return null;
    case "select": {
      const allowed = input.options?.map(o => o.value) ?? [];
      if (typeof value !== "string" || !allowed.includes(value))
        return `config.${input.key} must be one of: ${allowed.join(", ")}`;
      return null;
    }
    case "json":
      if (!isPlainObject(value))
        return `config.${input.key} must be a JSON object`;
      return null;
    default:
      return null;
  }
}

/** Test-only helper: drop all registered actions to keep test cases isolated. */
export function __resetActionRegistryForTests(): void {
  actions.clear();
}
