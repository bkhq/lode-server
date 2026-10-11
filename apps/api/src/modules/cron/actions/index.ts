import type { ActionDef } from "./types";
import httpRequest from "./http-request";
import logCleanup from "./log-cleanup";
import { __resetActionRegistryForTests, registerAction } from "./registry";
import shell from "./shell";
import softDeleteCleanup from "./soft-delete-cleanup";

export interface InitActionsOptions {
  /**
   * Names of actions whose `spec.defaultEnabled` is `false` that the
   * operator has explicitly opted into. Sourced from
   * `config.CRON_ACTIONS_ENABLED`. Actions with `defaultEnabled !== false`
   * (the common case) are always registered.
   */
  readonly enabledActions?: readonly string[];
}

// Every action the API knows about. The filter at `initActions` decides
// which ones land in the registry on this boot — actions with
// `spec.defaultEnabled === false` need their `name` to appear in
// `enabledActions` to register.
//
// External modules can still register their own actions at their own
// `index.ts` top level via `registerAction(defineAction({ ... }))`. The
// same opt-in convention applies: declare `defaultEnabled: false` on the
// spec and document the `CRON_ACTIONS_ENABLED` name.
const ALL_ACTIONS: readonly ActionDef[] = [
  logCleanup,
  httpRequest,
  softDeleteCleanup,
  shell,
];

let initialized = false;

export function initActions(options: InitActionsOptions = {}): void {
  if (initialized)
    return;
  const optIn = new Set(options.enabledActions ?? []);
  for (const def of ALL_ACTIONS) {
    const enabledByDefault = def.spec.defaultEnabled !== false;
    if (enabledByDefault || optIn.has(def.spec.name)) {
      registerAction(def);
    }
  }
  initialized = true;
}

/** Test-only: clear and re-register so each test runs against a fresh registry. */
export function __resetAndReinitActionsForTests(options: InitActionsOptions = {}): void {
  __resetActionRegistryForTests();
  initialized = false;
  initActions(options);
}

export {
  defineAction,
  getAction,
  getActionExecutor,
  getActionNames,
  getActionsCatalog,
  getDefaultActions,
  registerAction,
  validateActionConfig,
} from "./registry";
export type { ActionCatalogEntry } from "./registry";
export type {
  ActionContext,
  ActionDef,
  ActionExecutor,
  ActionInput,
  ActionInputType,
  ActionSpec,
} from "./types";
