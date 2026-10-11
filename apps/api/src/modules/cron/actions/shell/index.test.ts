import type { ActionContext } from "../types";
import { beforeAll, describe, expect, test } from "bun:test";
import shellAction from ".";
import { __resetActionRegistryForTests, registerAction, validateActionConfig } from "../registry";

beforeAll(() => {
  __resetActionRegistryForTests();
  registerAction(shellAction);
});

const fakeLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  flush: () => {},
  reopen: () => {},
} as unknown as ActionContext["logger"];

const fakeConfig = {
  SHELL_ACTION_TIMEOUT_SECONDS: 300,
  HTTP_ACTION_TIMEOUT_SECONDS: 30,
} as unknown as ActionContext["config"];
const ctx: ActionContext = {
  db: null as unknown as ActionContext["db"],
  logger: fakeLogger,
  config: fakeConfig,
};

const run = (cfg: Record<string, unknown>) => shellAction.execute(ctx, cfg);
function validate(cfg: Record<string, unknown>) {
  return validateActionConfig("shell", { ...cfg, action: "shell" });
}

describe("shell validate (via inputs[])", () => {
  test("rejects missing command (required input)", async () => {
    expect(await validate({})).toMatch(/command is required/);
  });

  test("rejects empty command (required + non-empty)", async () => {
    expect(await validate({ command: "" })).toMatch(/command is required/);
  });

  test("rejects non-string command (string typecheck)", async () => {
    expect(await validate({ command: 42 })).toMatch(/command must be a string/);
  });

  test("rejects timeout out of range", async () => {
    expect(await validate({ command: "true", timeoutMs: 0 })).toMatch(/timeoutMs must be >= 100/);
    expect(await validate({ command: "true", timeoutMs: 999_999_999 })).toMatch(/timeoutMs must be <= 300000/);
  });

  test("rejects non-string cwd (string typecheck)", async () => {
    expect(await validate({ command: "true", cwd: 42 })).toMatch(/cwd must be a string/);
  });

  test("accepts a well-formed config", async () => {
    expect(await validate({ command: "echo hi", timeoutMs: 1000, cwd: "/tmp" })).toBeNull();
  });
});

describe("runShell", () => {
  test("captures stdout on exit 0", async () => {
    const result = await run({ command: "echo hello-world" });
    expect(result).toMatch(/^exit 0 /);
    expect(result).toContain("hello-world");
  });

  test("supports shell features (pipes + redirects)", async () => {
    const result = await run({ command: "echo abc | tr a-z A-Z" });
    expect(result).toMatch(/^exit 0 /);
    expect(result).toContain("ABC");
  });

  test("throws on non-zero exit, attaches stderr", async () => {
    expect(run({ command: "echo boom >&2; exit 7" })).rejects.toThrow(/exited 7/);
  });

  test("times out long-running commands", async () => {
    // sleep 1 is enough — SIGKILL fires at 200ms; stream drain finishes
    // shortly after pipe close. Keep the bun-test cap above 1s so a slow
    // CI runner that delays stdout/stderr EOF doesn't trip the framework
    // timeout before our timeout-detection branch runs.
    expect(run({ command: "sleep 1", timeoutMs: 200 })).rejects.toThrow(/timed out after 200ms|exited 137/);
  }, 10_000);

  test("truncates very large stdout to MAX_STREAM_BYTES", async () => {
    const result = await run({
      command: "head -c 20000 /dev/zero | tr '\\0' '0'",
      timeoutMs: 5000,
    });
    expect(result).toMatch(/^exit 0 /);
    expect(result).toContain("more bytes");
  });

  test("respects cwd when provided", async () => {
    const result = await run({ command: "pwd", cwd: "/tmp" });
    expect(result).toContain("/tmp");
  });
});
