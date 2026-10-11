// Shared types & constants for the cron admin page.
//
// Mirrors `apps/api/src/modules/cron/serialize.ts` for `CronJob` and
// `apps/api/src/modules/cron/actions/types.ts` for the action catalog.
// Kept in sync manually — the action catalog is a small, public contract
// and the shape is documented in `docs/modules/cron.md` so external
// modules can register actions that the SPA renders without a code
// change.

export interface CronJob {
  readonly id: string;
  readonly name: string;
  readonly cron: string;
  readonly taskType: string;
  readonly taskConfig: Record<string, unknown>;
  readonly enabled: boolean;
  readonly status: string;
  readonly nextExecution: string | null;
  readonly lastRun: {
    readonly status: string;
    readonly startedAt: string;
    readonly durationMs: number | null;
    readonly result: string | null;
    readonly error: string | null;
  } | null;
  readonly maxConsecutiveFailures: number;
  readonly isDeleted: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface JobsListResponse {
  success: true;
  data: { jobs: CronJob[]; hasMore: boolean; nextCursor: string | null };
}

export interface JobOneResponse {
  success: true;
  data: CronJob;
}

export type ActionInputType
  = | "string"
    | "textarea"
    | "secret"
    | "number"
    | "boolean"
    | "select"
    | "json";

export interface ActionInput {
  readonly key: string;
  readonly label: string;
  readonly type: ActionInputType;
  readonly required?: boolean;
  readonly description?: string;
  readonly placeholder?: string;
  readonly default?: unknown;
  readonly options?: readonly { value: string; label: string }[];
  readonly min?: number;
  readonly max?: number;
  readonly group?: string;
}

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

export interface ActionsResponse {
  success: true;
  data: {
    actions: ActionCatalogEntry[];
    cronFormats: string[];
    // false when the API was started with CRON_ENABLED=false — admins
    // can still browse / write, but no scheduled ticks fire.
    schedulerEnabled: boolean;
  };
}

// ─── Schedule presets ───
//
// Keyed by an i18n token under cron.presets.*; the value is the cron
// expression sent to the API. The API normalises shorthand forms
// (`@every_5m` → `@every_5_minutes`) so either is accepted.

export interface SchedulePreset {
  readonly key: string;
  readonly value: string;
}

export const SCHEDULE_PRESETS: readonly SchedulePreset[] = [
  { key: "every_1m", value: "@every_minute" },
  { key: "every_5m", value: "@every_5m" },
  { key: "every_15m", value: "@every_15m" },
  { key: "every_30m", value: "@every_30m" },
  { key: "hourly", value: "@hourly" },
  { key: "every_1h", value: "@every_1h" },
  { key: "every_6h", value: "@every_6h" },
  { key: "every_12h", value: "@every_12h" },
  { key: "daily", value: "@daily" },
  { key: "weekly", value: "@weekly" },
  { key: "monthly", value: "@monthly" },
  { key: "yearly", value: "@yearly" },
];

// Quick check: does the entered cron string match one of our presets?
// Used to pre-select the preset tab when editing an existing job's
// schedule (future) or when a user types a value that happens to be a
// preset. Kept as a Set for O(1) lookup.
export const PRESET_VALUES = new Set(SCHEDULE_PRESETS.map(p => p.value));

// Status filter presets for the toolbar Select. Each entry maps to
// the pair of `deleted` + `lastStatus` query params the cron list
// route understands. The list is intentionally short — admins want
// quick triage views, not a permutation of every lifecycle bit.
export interface StatusFilter {
  readonly deleted?: "false" | "true" | "only";
  readonly lastStatus?: "success" | "failed" | "running";
}
export const STATUS_FILTERS = {
  // Live jobs (default). Hides tombstones; no run-status filter so
  // both successful + failed jobs appear.
  active: { deleted: "false" },
  // Jobs whose latest run failed — primary triage view.
  failed: { deleted: "false", lastStatus: "failed" },
  // Jobs whose latest run succeeded.
  success: { deleted: "false", lastStatus: "success" },
  // Soft-deleted rows.
  deleted: { deleted: "only" },
} as const satisfies Record<string, StatusFilter>;

export type StatusFilterKey = keyof typeof STATUS_FILTERS;
export const STATUS_FILTER_ORDER: readonly StatusFilterKey[] = ["active", "failed", "success", "deleted"];

export const NAME_REGEX = /^[\w-]+$/;
export const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  running: "default",
  stopped: "secondary",
  paused: "secondary",
  error: "destructive",
  disabled: "outline",
  not_loaded: "outline",
  success: "default",
  failed: "destructive",
};

// Form state: schedule + name + retry policy are universal; per-action
// config lives in a free-form record indexed by each `ActionInput.key`.
// Switching action populates this record with the new action's
// defaults — no per-action React component needed.
export interface FormState {
  name: string;
  scheduleMode: "preset" | "custom";
  schedulePreset: string;
  scheduleCustom: string;
  action: string;
  /** Per-input values keyed by `ActionInput.key`. */
  config: Record<string, unknown>;
  /**
   * Retry budget. Stored as string so the input can be cleared cleanly;
   * empty = "send default" (server picks 3); explicit digits 0..100
   * ride the wire as a number.
   */
  maxConsecutiveFailures: string;
}

export const INITIAL_FORM: FormState = {
  name: "",
  scheduleMode: "preset",
  schedulePreset: "@every_1h",
  scheduleCustom: "0 0 3 * * *",
  action: "",
  config: {},
  maxConsecutiveFailures: "3",
};
