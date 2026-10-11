import type { Platform } from "./types";
import { createBunPlatform } from "./bun";

export type { KvNamespace, Platform, PlatformCapabilities, PlatformEnv, PlatformKv, PlatformScheduler, ScheduledHandle } from "./types";

let current: Platform | undefined;

/**
 * The active runtime adapter. Bun is the default and is created lazily;
 * a Workers entry point installs its own adapter with `setPlatform()`
 * before the first request. Tests may install a fake the same way.
 */
export function getPlatform(): Platform {
  if (!current)
    current = createBunPlatform();
  return current;
}

export function setPlatform(platform: Platform): void {
  current = platform;
}

/** Test hook — drop the active adapter so the next call recreates the default. */
export function __resetPlatformForTests(): void {
  current = undefined;
}
