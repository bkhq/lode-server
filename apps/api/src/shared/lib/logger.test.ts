import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createLogger } from "./logger";

let dir: string;
let logFile: string;

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), "logger-"));
  logFile = resolve(dir, "logs/app.log");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("createLogger", () => {
  test("creates the log directory and file on first write", async () => {
    const log = createLogger({ LOG_LEVEL: "info", LOG_FILE: logFile, LOG_TO_STDOUT: false, NODE_ENV: "test" });
    log.info("hello");
    await Bun.sleep(50);
    log.flush();
    expect(existsSync(logFile)).toBe(true);
    const content = readFileSync(logFile, "utf-8");
    expect(content).toContain("hello");
  });

  test("supports both string and object payloads", async () => {
    const log = createLogger({ LOG_LEVEL: "info", LOG_FILE: logFile, LOG_TO_STDOUT: false, NODE_ENV: "test" });
    log.info("string-form");
    log.info({ user: "alice" }, "with-context");
    await Bun.sleep(50);
    log.flush();
    const content = readFileSync(logFile, "utf-8");
    expect(content).toContain("string-form");
    expect(content).toContain("with-context");
    expect(content).toContain("alice");
  });

  test("falls back to info on an unknown LOG_LEVEL", async () => {
    // Should not throw; the pino instance and dev tee both default to info.
    const log = createLogger({ LOG_LEVEL: "trace", LOG_FILE: logFile, LOG_TO_STDOUT: false, NODE_ENV: "test" });
    log.info("fallback ok");
    await Bun.sleep(50);
    log.flush();
    expect(readFileSync(logFile, "utf-8")).toContain("fallback ok");
  });

  test("warn / error / fatal / debug all write to the file at their respective levels", async () => {
    const log = createLogger({ LOG_LEVEL: "debug", LOG_FILE: logFile, LOG_TO_STDOUT: false, NODE_ENV: "test" });
    log.debug("d");
    log.warn("w");
    log.error({ x: 1 }, "e");
    log.fatal("f");
    await Bun.sleep(50);
    log.flush();
    const content = readFileSync(logFile, "utf-8");
    expect(content).toContain("\"d\"");
    expect(content).toContain("\"w\"");
    expect(content).toContain("\"e\"");
    expect(content).toContain("\"f\"");
  });

  test("redacts sensitive fields at the top level", async () => {
    const log = createLogger({ LOG_LEVEL: "info", LOG_FILE: logFile, LOG_TO_STDOUT: false, NODE_ENV: "test" });
    log.info({ user: { password: "secret" }, session: { token: "abc" } }, "redact-test");
    await Bun.sleep(50);
    log.flush();
    const content = readFileSync(logFile, "utf-8");
    expect(content).not.toContain("secret");
    expect(content).not.toContain("abc");
    expect(content).toContain("REDACTED");
  });

  test("redacts sensitive fields nested below the first level", async () => {
    // Earlier the redact paths were `*.password` / `*.token` etc. which only
    // matched one level below the root. A nested layout like the request
    // metadata bundle below would have leaked the cleartext credentials.
    const log = createLogger({ LOG_LEVEL: "info", LOG_FILE: logFile, LOG_TO_STDOUT: false, NODE_ENV: "test" });
    log.info(
      {
        outer: {
          ctx: {
            user: { password: "deep-secret-pw" },
            api: { authorization: "Bearer deep-secret-token" },
          },
        },
      },
      "deep-redact-test",
    );
    await Bun.sleep(50);
    log.flush();
    const content = readFileSync(logFile, "utf-8");
    expect(content).not.toContain("deep-secret-pw");
    expect(content).not.toContain("deep-secret-token");
    expect(content).toContain("REDACTED");
  });
});
