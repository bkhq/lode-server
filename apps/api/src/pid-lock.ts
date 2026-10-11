import { closeSync, existsSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";

let lockPath: string | null = null;

const RE_TRAILING_SLASHES = /\/+$/;

function tryCreateExclusive(filePath: string, content: string): boolean {
  try {
    const fd = openSync(filePath, "wx");
    writeSync(fd, content);
    closeSync(fd);
    return true;
  }
  catch {
    return false;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  }
  catch {
    return false;
  }
}

/**
 * Check if the process at the given port is our app or something else.
 * Returns:
 *   "self"    — confirmed our instance (health responded with status:"ok")
 *   "other"   — confirmed NOT ours (port responds but not our health endpoint)
 *   "unknown" — inconclusive (port not listening, fetch failed, timeout, etc.)
 */
async function probeProcess(port: number, basePath: string): Promise<"self" | "other" | "unknown"> {
  const trimmedBase = basePath.replace(RE_TRAILING_SLASHES, "");
  const url = `http://127.0.0.1:${port}${trimmedBase}/api/health`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) {
      // Server responded but the response status indicates it's not our
      // health endpoint (404, 500, etc.) — treat as a different process.
      return "other";
    }
    const body = await res.text();
    if (body.includes("\"status\":\"ok\"")) {
      return "self";
    }
    return "other";
  }
  catch {
    return "unknown";
  }
}

function parseLockFile(content: string): { pid: number; port: number } | null {
  const parts = content.trim().split(":");
  if (parts.length !== 2)
    return null;
  const pid = Number.parseInt(parts[0]!, 10);
  const port = Number.parseInt(parts[1]!, 10);
  if (Number.isNaN(pid) || Number.isNaN(port))
    return null;
  return { pid, port };
}

/**
 * Best-effort check that a PID belongs to "a bun process" — used as a
 * secondary signal when the HTTP probe is inconclusive (server still
 * starting up, etc.). Linux uses /proc/PID/cmdline, macOS uses `ps`.
 */
function isProbablyAppByOs(pid: number): boolean {
  try {
    if (process.platform === "darwin") {
      const res = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="]);
      if (res.exitCode !== 0)
        return false;
      return res.stdout.toString().toLowerCase().includes("bun");
    }
    const cmdlinePath = `/proc/${pid}/cmdline`;
    if (!existsSync(cmdlinePath))
      return false;
    const cmdline = readFileSync(cmdlinePath, "utf-8").toLowerCase();
    return cmdline.includes("bun");
  }
  catch {
    return false;
  }
}

export async function acquirePidLock(dbPath: string, port: number, basePath: string): Promise<void> {
  const dir = dirname(dbPath);
  lockPath = resolve(dir, "app.pid");
  const content = `${process.pid}:${port}`;

  if (tryCreateExclusive(lockPath, content))
    return;

  // Lock file exists — read it
  let existing: { pid: number; port: number } | null = null;
  try {
    const raw = readFileSync(lockPath, "utf-8");
    existing = parseLockFile(raw);
  }
  catch {
    rmSync(lockPath, { force: true });
    if (tryCreateExclusive(lockPath, content))
      return;
    console.error("Failed to acquire PID lock after cleanup");
    process.exit(1);
  }

  if (!existing) {
    rmSync(lockPath, { force: true });
    if (tryCreateExclusive(lockPath, content))
      return;
    console.error("Failed to acquire PID lock");
    process.exit(1);
  }

  // Same process re-entering acquirePidLock (e.g. `bun --hot` re-evaluates
  // the entry module without forking). The lock is already ours.
  if (existing.pid === process.pid)
    return;

  if (!isProcessAlive(existing.pid)) {
    // Process dead — stale lock, safe to take over
    rmSync(lockPath, { force: true });
    if (tryCreateExclusive(lockPath, content))
      return;
    console.error("Failed to acquire PID lock");
    process.exit(1);
  }

  // Process is alive — determine identity via HTTP probe
  const probe = await probeProcess(existing.port, basePath);

  if (probe === "self") {
    console.error(`Another instance is already running (PID ${existing.pid}, port ${existing.port})`);
    process.exit(1);
  }

  if (probe === "other") {
    // Port responds but it's not ours — PID was recycled, safe to reclaim
    rmSync(lockPath, { force: true });
    if (tryCreateExclusive(lockPath, content))
      return;
    console.error("Failed to acquire PID lock");
    process.exit(1);
  }

  // probe === "unknown" — REFUSE to take over a live PID without definitive
  // evidence it isn't ours. The OS-level signal (procfs / ps) is informational
  // only; an exit-on-the-side-of-caution policy avoids racing a freshly-
  // started sibling that hasn't bound yet.
  if (isProbablyAppByOs(existing.pid)) {
    console.error(`Another instance appears to be starting (PID ${existing.pid}). If this is stale, remove ${lockPath}`);
  }
  else {
    console.error(`Cannot determine ownership of live PID ${existing.pid} on port ${existing.port}. If this is stale, remove ${lockPath}`);
  }
  process.exit(1);
}

export function releasePidLock(): void {
  if (!lockPath)
    return;
  try {
    const raw = readFileSync(lockPath, "utf-8");
    const existing = parseLockFile(raw);
    if (existing && existing.pid === process.pid) {
      rmSync(lockPath, { force: true });
    }
  }
  catch {
    // Lock file already removed
  }
}
