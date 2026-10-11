import type { ActionSpec } from "../types";

export const MIN_TIMEOUT_MS = 100;
export const MAX_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Declarative definition of the `shell` action.
 *
 * `dangerous: true` paints an amber banner in the SPA — the executor
 * runs with the API process's full privileges and there is no sandbox.
 * `defaultEnabled: false` keeps it out of the registry unless the
 * operator opts in via `CRON_ACTIONS_ENABLED=shell,…`.
 */
export const spec: ActionSpec = {
  name: "shell",
  displayName: "Shell command",
  description: "Run an `sh -c` command and capture exit + stdout snippet.",
  category: "system",
  icon: "Terminal",
  tags: ["shell", "ops"],
  version: "1.0.0",
  dangerous: true,
  defaultEnabled: false,
  inputs: [
    {
      key: "command",
      label: "Command",
      type: "textarea",
      required: true,
      placeholder: "sqlite3 /data/db/app.db 'VACUUM; ANALYZE;'",
      description: "Runs as `sh -c \"$command\"`. Pipes / redirects / && all work.",
    },
    {
      key: "cwd",
      label: "Working directory",
      type: "string",
      placeholder: "/tmp",
      description: "Optional. Defaults to the API process's cwd.",
    },
    {
      key: "timeoutMs",
      label: "Timeout (ms)",
      type: "number",
      default: DEFAULT_TIMEOUT_MS,
      min: MIN_TIMEOUT_MS,
      max: MAX_TIMEOUT_MS,
      description: "On expiry the child is SIGKILL'd and the run records as failed.",
    },
  ],
};
