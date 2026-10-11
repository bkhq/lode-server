import type { FileStorageDriver } from "./types";

const drivers = new Map<string, FileStorageDriver>();
let activeDriverName: string | undefined;

/**
 * Register a storage driver. Last-write-wins: re-registering a driver
 * under the same name replaces the prior entry. Driver names are
 * case-sensitive and should be lowercase.
 *
 * Drivers register themselves at module load, e.g. from
 * `modules/file/storage/local.ts` via a top-level `registerDriver(...)`
 * call. Downstream projects add S3 / Azure / GCS drivers the same way
 * — no patch of mod-file required.
 */
export function registerDriver(driver: FileStorageDriver): void {
  drivers.set(driver.name, driver);
}

/** Test-only: clear the driver registry between cases. */
export function __resetDriverRegistryForTests(): void {
  drivers.clear();
  activeDriverName = undefined;
}

/** Look up a registered driver by name. Throws if absent. */
export function getDriver(name: string): FileStorageDriver {
  const d = drivers.get(name);
  if (!d) {
    const known = [...drivers.keys()].sort().join(", ") || "(none registered)";
    throw new Error(`Unknown file storage driver: '${name}'. Registered: ${known}.`);
  }
  return d;
}

/** Set the active driver for the running process. Idempotent. */
export function setActiveDriver(name: string): void {
  // Resolve to surface unknown names early (boot-time, not first-upload-time).
  getDriver(name);
  activeDriverName = name;
}

/**
 * Return the currently-active driver. Throws if {@link setActiveDriver}
 * has not been called yet — callers should not reach this before boot
 * has resolved `Config.FILE_STORAGE_DRIVER`.
 */
export function getActiveDriver(): FileStorageDriver {
  if (!activeDriverName) {
    throw new Error("File storage driver not selected. Call setActiveDriver() during boot.");
  }
  return getDriver(activeDriverName);
}

/** Inspect the registered driver names — handy for diagnostic endpoints / tests. */
export function listRegisteredDrivers(): readonly string[] {
  return [...drivers.keys()].sort();
}
