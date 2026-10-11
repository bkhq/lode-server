import type { Config } from "./config";
import type { Logger } from "./shared/lib/logger";
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";

/**
 * Optional sealed-file unlock for unattended container restarts. When
 * `config.MASTER_PASSWORD_FILE` is set:
 *
 *   1. Read the file (mode must be `0600`; otherwise refuse and warn —
 *      a permissive secret on disk is treated as an operator mistake,
 *      not silently consumed).
 *   2. Take the first non-blank line as the master password.
 *   3. POST to the local server's `/api/encryption/unlock` over loopback.
 *   4. **Delete the file**, regardless of unlock success, so a backup
 *      snapshot taken on the next sweep does not preserve it.
 *
 * This is a defence-in-depth helper for stateful deployments (k8s,
 * compose) that have no human at the terminal. The caller is
 * responsible for re-creating the file at boot from the secret store
 * — see `docs/develop/operations.md` § Sealed-file unlock.
 */
export async function attemptSealedUnlock(
  config: Config,
  logger: Logger,
): Promise<void> {
  const path = config.MASTER_PASSWORD_FILE;
  if (!path)
    return;
  if (!existsSync(path)) {
    logger.info({ path }, "sealed-unlock: file not present, skipping");
    return;
  }
  let stats;
  try {
    stats = statSync(path);
  }
  catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), path }, "sealed-unlock: stat failed");
    return;
  }
  // Refuse a world-readable secret on disk. The owner-readable bit
  // (0o600) is the same posture the bootstrap-token helper verifies in
  // `apps/api/src/modules/encryption/bootstrap.ts`.
  const mode = stats.mode & 0o777;
  if (mode !== 0o600) {
    logger.warn({ path, mode: mode.toString(8) }, "sealed-unlock: refusing — file mode must be 0600");
    return;
  }

  let password = "";
  try {
    const raw = readFileSync(path, "utf-8");
    const firstLine = raw.split(/\r?\n/).find(line => line.trim() !== "");
    password = firstLine?.trim() ?? "";
  }
  catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "sealed-unlock: read failed");
    deleteFile(path, logger);
    return;
  }
  if (!password) {
    logger.warn({ path }, "sealed-unlock: file empty, nothing to do");
    deleteFile(path, logger);
    return;
  }

  const basePath = config.BASE_PATH.replace(/\/+$/g, "");
  const url = `http://127.0.0.1:${config.PORT}${basePath}/api/encryption/unlock`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      logger.info("sealed-unlock: unlock succeeded");
    }
    else {
      const text = await res.text().catch(() => "");
      logger.warn({ status: res.status, body: text.slice(0, 200) }, "sealed-unlock: unlock failed");
    }
  }
  catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "sealed-unlock: request failed");
  }
  deleteFile(path, logger);
}

function deleteFile(path: string, logger: Logger): void {
  try {
    unlinkSync(path);
    logger.info({ path }, "sealed-unlock: file deleted");
  }
  catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), path }, "sealed-unlock: delete failed");
  }
}
