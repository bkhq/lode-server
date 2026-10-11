import type { ActionExecutor } from "../types";
import { z } from "zod";
import { getPlatform } from "@/platform";
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS } from "./spec";

// Cap captured stdout/stderr per stream. Anything larger lands in the
// process's own logs (where syslog / journald / pino can rotate it) but
// never in `cron_job_logs.result` — that column is meant for short
// per-run hints, not arbitrary blobs.
const MAX_STREAM_BYTES = 4096;

// Validates the config persisted by the create-job route (already vetted
// by `validateActionConfig` against the action's `inputs[]`). Re-parsing
// at execute time catches a hand-edited DB row or a stale schema before
// the executor reaches `Bun.spawn`.
const shellConfigSchema = z.object({
  command: z.string().min(1),
  timeoutMs: z.number().int().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS).optional(),
  cwd: z.string().optional(),
}).passthrough();

type ShellConfig = z.infer<typeof shellConfigSchema>;

function parseConfig(config: Record<string, unknown>): ShellConfig {
  return shellConfigSchema.parse(config);
}

function trimStream(buf: ArrayBuffer | Uint8Array | null): { text: string; truncated: boolean; totalBytes: number } {
  if (!buf)
    return { text: "", truncated: false, totalBytes: 0 };
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const total = bytes.byteLength;
  const slice = total > MAX_STREAM_BYTES ? bytes.subarray(0, MAX_STREAM_BYTES) : bytes;
  return {
    text: new TextDecoder().decode(slice),
    truncated: total > MAX_STREAM_BYTES,
    totalBytes: total,
  };
}

/**
 * Run an arbitrary shell command. The command runs inside `sh -c` so
 * pipes, redirects, and `&&` work as operators expect. Stdout and
 * stderr are captured (bounded to MAX_STREAM_BYTES each); the exit
 * code drives success vs failure.
 *
 * SECURITY: the action runs with the API process's user, env, and
 * filesystem permissions — there is no sandbox. The route layer gates
 * registration to admin sessions; treat the registry like a host root
 * crontab and review every command before it lands.
 */
export const execute: ActionExecutor = async (ctx, config) => {
  if (!getPlatform().capabilities.subprocess) {
    throw new Error("The shell action needs a runtime that can spawn processes; this one cannot.");
  }
  const cfg = parseConfig(config);
  // Per-job timeout is clamped by the operator-level
  // `SHELL_ACTION_TIMEOUT_SECONDS` ceiling so a single misbehaving job
  // (or a hand-edited DB row) cannot starve the scheduler indefinitely.
  const ceilingMs = ctx.config.SHELL_ACTION_TIMEOUT_SECONDS * 1000;
  const requested = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.min(requested, ceilingMs);
  const startedAt = Date.now();

  const proc = Bun.spawn(["sh", "-c", cfg.command], {
    ...(cfg.cwd ? { cwd: cfg.cwd } : {}),
    stdout: "pipe",
    stderr: "pipe",
  });

  // Bound the wall-clock so a runaway `tail -f` doesn't pin the executor.
  const timer = setTimeout(() => {
    try {
      proc.kill("SIGKILL");
    }
    catch {}
  }, timeoutMs);
  let timedOut = false;
  let exitCode: number | null = null;
  try {
    const [stdoutBuf, stderrBuf, code] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).arrayBuffer(),
      proc.exited,
    ]);
    exitCode = code;
    const stdout = trimStream(stdoutBuf);
    const stderr = trimStream(stderrBuf);
    const durationMs = Date.now() - startedAt;
    // SIGKILL fires after timeoutMs — detect it via signal-derived
    // exit. Bun reports SIGKILL as code 137 (128 + 9).
    timedOut = code === 137 && durationMs + 50 >= timeoutMs;

    if (timedOut) {
      ctx.logger.warn({ command: cfg.command, durationMs }, "cron_shell_timeout");
      throw new Error(`shell command timed out after ${timeoutMs}ms: ${cfg.command}`);
    }

    if (code !== 0) {
      ctx.logger.warn(
        { command: cfg.command, exitCode: code, durationMs },
        "cron_shell_nonzero_exit",
      );
      const stderrTag = stderr.text ? ` stderr: ${stderr.text}` : "";
      throw new Error(`shell command exited ${code} (${durationMs}ms)${stderrTag}`);
    }

    ctx.logger.debug(
      { command: cfg.command, exitCode: code, stdoutBytes: stdout.totalBytes, durationMs },
      "cron_shell_ok",
    );
    const tail = stdout.text
      ? ` stdout: ${stdout.text}${stdout.truncated ? `…(${stdout.totalBytes - MAX_STREAM_BYTES} more bytes)` : ""}`
      : "";
    return `exit 0 (${durationMs}ms)${tail}`;
  }
  finally {
    clearTimeout(timer);
    // Defence in depth: if the await chain unwound before exit, make
    // sure we don't leak a running child.
    if (exitCode === null) {
      try {
        proc.kill("SIGKILL");
      }
      catch {}
    }
  }
};
