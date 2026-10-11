/**
 * Throwable error type used by the config-loading pipeline. The
 * orchestrating `loadConfig()` catches these and surfaces them via
 * `console.error` + `process.exit(1)`; the lower-level helpers throw
 * so that unit tests can `expect(...).rejects.toThrow(ConfigError)`
 * without fork-and-watch ceremony.
 *
 * `field` is the offending env / config key when the failure is
 * single-source (boot guards). Aggregate failures (zod parse errors)
 * pass `field === undefined` and embed the per-field detail in the
 * message.
 */
export class ConfigError extends Error {
  readonly field: string | undefined;
  readonly hint: string | undefined;

  constructor(message: string, opts: { field?: string; hint?: string } = {}) {
    super(message);
    this.name = "ConfigError";
    this.field = opts.field;
    this.hint = opts.hint;
  }
}
