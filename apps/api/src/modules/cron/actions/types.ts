import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import type { Logger } from "@/shared/lib/logger";

// ─── Shared runtime context ─────────────────────────────────────────

/**
 * Everything an executor receives at run time. Kept narrow so handlers
 * stay focused on the work, not on plumbing.
 */
export interface ActionContext {
  readonly db: AppDatabase;
  readonly logger: Logger;
  readonly config: Config;
}

// ─── Definition layer (ActionSpec) ──────────────────────────────────

/**
 * One declared field of an action's config. Drives:
 *   1. Create-time validation in `validateActionConfig` (required / range / enum).
 *   2. The admin UI's dynamic form (rendered from this descriptor — no
 *      hardcoded per-action React component needed).
 *   3. The `/cron/actions` catalog payload so external SPAs can build
 *      their own UIs from the same source of truth.
 *
 * Pick `type` to match the operator's data:
 *   - `string`   — short identifiers / URLs.
 *   - `textarea` — multi-line text (shell commands, request bodies).
 *   - `secret`   — value is masked in the UI (Bearer tokens, passwords).
 *   - `number`   — numeric input. Honour `min` / `max` for bounds.
 *   - `boolean`  — checkbox / switch.
 *   - `select`   — fixed choice; populate `options`.
 *   - `json`     — free-form structured payload; validated as JSON object.
 */
export type ActionInputType
  = | "string"
    | "textarea"
    | "secret"
    | "number"
    | "boolean"
    | "select"
    | "json";

export interface ActionInput {
  /** Key inside `taskConfig` (sent verbatim on POST /cron/jobs body.config). */
  readonly key: string;
  /** Form label / column header. */
  readonly label: string;
  /** Renderer + validator switch. */
  readonly type: ActionInputType;
  /** Required at create time. Maps to "this key cannot be null/empty". */
  readonly required?: boolean;
  /** Inline help text under the input. */
  readonly description?: string;
  /** UI hint inside the input itself. */
  readonly placeholder?: string;
  /** Default value injected when the operator leaves the input blank. */
  readonly default?: unknown;
  /** Allowed values when `type === "select"`. */
  readonly options?: readonly { value: string; label: string }[];
  /** Numeric bounds (applies when `type === "number"`). */
  readonly min?: number;
  readonly max?: number;
  /** Optional grouping label the UI can use to lay out fields in sections. */
  readonly group?: string;
}

/**
 * The **definition layer** — pure declarative metadata describing what
 * the action is, how its config is shaped, and how creation should be
 * validated. Contains no execution logic; safe to serialize, render in
 * the UI, or expose over the wire (minus the `validate` closure, which
 * the catalog route strips).
 */
export interface ActionSpec {
  /** Unique action key. Stable across deployments — referenced by job rows. */
  readonly name: string;
  /** Human-readable name shown in the action picker. */
  readonly displayName: string;
  /** One-line description shown next to `displayName`. */
  readonly description: string;
  /** Functional category (`maintenance`, `network`, `system`, `custom`, …). */
  readonly category: string;
  /** Optional `lucide-react` icon name surfaced by the SPA. */
  readonly icon?: string;
  /** Free-form search tags. Indexed client-side. */
  readonly tags?: readonly string[];
  /** Optional semver string surfaced in the UI action meta card. */
  readonly version?: string;
  /** Flagged in the UI with a warning banner (e.g. `shell`). */
  readonly dangerous?: boolean;
  /**
   * Whether the action is registered by default. Default `true`. Set to
   * `false` for actions that need an explicit operator opt-in (e.g. the
   * `shell` action's host-RCE blast radius). Opted in by listing the
   * action's `name` in `CRON_ACTIONS_ENABLED`.
   */
  readonly defaultEnabled?: boolean;
  /**
   * Suggested cron expression. When set, `startCron` auto-seeds one DB
   * row pointing at this action so the job is live on first boot.
   */
  readonly defaultCron?: string;
  /** Run the executor once on startup in addition to the schedule. */
  readonly runOnStartup?: boolean;
  /** Structured field definitions — single source of truth for UI + validate. */
  readonly inputs?: readonly ActionInput[];
  /**
   * Optional deep validation past the per-input checks. Return a
   * human-readable message to reject, or `null` to accept.
   */
  readonly validate?: (config: Record<string, unknown>) => Promise<string | null>;
}

// ─── Execution layer (ActionExecutor) ───────────────────────────────

/**
 * The **execution layer** — receives the parsed config + a db / logger
 * handle, does the work, returns a short status string that lands in
 * `cron_job_logs.result`. Throw to fail the run; the executor wraps the
 * error into `cron_job_logs.error`.
 */
export type ActionExecutor = (
  ctx: ActionContext,
  config: Record<string, unknown>,
) => Promise<string>;

// ─── Composed ActionDef ─────────────────────────────────────────────

/**
 * A registered action = its declarative spec paired with its execution
 * function. The registry keys by `spec.name`; callers that only need
 * metadata reach for `spec` and callers that need to run code reach for
 * `execute` — the type makes the boundary visible.
 */
export interface ActionDef {
  readonly spec: ActionSpec;
  readonly execute: ActionExecutor;
}
