import type { FileStorageDriver } from "./types";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { ROOT_DIR } from "@/root";
import { registerDriver } from "./registry";

let localRoot: string | undefined;

/**
 * Local-filesystem driver. The on-disk layout under `localRoot` is:
 *
 *     <ab>/<cd>/<sha256>
 *
 * — first two hex pairs of the sha256 fan the tree out so no single
 * directory holds more than ~4 000 entries even at 100 M uploads.
 *
 * Writes are two-phase (tmp file → rename) so a crash leaves a sweepable
 * `.tmp` file rather than an orphan at the final name. `delete` is
 * tolerant of a missing file — the GC sweeper may race with a manual
 * cleanup and we don't want either side to crash.
 */
export const localDriver: FileStorageDriver = {
  name: "local",

  setup(config) {
    const root = config.FILE_STORAGE_LOCAL_ROOT;
    localRoot = isAbsolute(root) ? root : resolve(ROOT_DIR, root);
    if (!existsSync(localRoot)) {
      mkdirSync(localRoot, { recursive: true, mode: 0o700 });
    }
  },

  async put(key, data) {
    const path = resolveKey(key);
    const dir = dirname(path);
    if (!existsSync(dir)) {
      // 0o700 — only the runtime user (and root) sees the cleartext blob
      // tree. This matters when DB_ENCRYPTION is on; per-file uploads
      // stay outside the SQLite file.
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const tmp = `${path}.tmp`;
    await Bun.write(tmp, data);
    try {
      renameSync(tmp, path);
    }
    catch (err) {
      try {
        rmSync(tmp, { force: true });
      }
      catch {}
      throw err;
    }
  },

  async getStream(key) {
    const path = resolveKey(key);
    const file = Bun.file(path);
    if (!(await file.exists())) {
      throw new Error(`Missing blob at ${key}`);
    }
    return file.stream();
  },

  async delete(key) {
    const path = resolveKey(key);
    try {
      rmSync(path, { force: true });
    }
    catch {
      // best-effort
    }
  },

  async exists(key) {
    const path = resolveKey(key);
    return await Bun.file(path).exists();
  },
};

function resolveKey(key: string): string {
  if (!localRoot) {
    throw new Error("Local driver not initialised. Ensure FILE_STORAGE_DRIVER=local and initFileModule(config) ran at boot.");
  }
  // Defence in depth: refuse absolute keys and `..` traversal. Keys are
  // produced internally from a sha256 prefix so this should never fire,
  // but a future caller bug shouldn't let arbitrary paths through.
  if (isAbsolute(key) || key.split(/[/\\]/).includes("..")) {
    throw new Error(`Invalid storage key: ${key}`);
  }
  return resolve(localRoot, key.split("/").join(sep));
}

// Self-register at module load. Downstream drivers (S3 / Azure / GCS)
// follow the same pattern: a top-level `registerDriver(...)` in the
// module body so importing the file is enough to make the driver
// available; `initFileModule` only picks the active one and runs its
// `setup` hook.
registerDriver(localDriver);

/** Test-only: rebind the local root and re-register. */
export function __setLocalDriverRootForTests(path: string): void {
  localRoot = path;
  if (!existsSync(localRoot)) {
    mkdirSync(localRoot, { recursive: true, mode: 0o700 });
  }
  registerDriver(localDriver);
}
