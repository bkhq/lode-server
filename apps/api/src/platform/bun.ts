import type { Platform, PlatformScheduler, ScheduledHandle } from "./types";
import { createMemoryKv } from "./memory-kv";

// ── scheduler: timers, non-overlapping, drained on stop ───────────────────

function createTimerScheduler(): PlatformScheduler {
  const handles = new Set<ScheduledHandle>();
  return {
    every(name, { delayMs, intervalMs }, fn) {
      let timer: ReturnType<typeof setInterval> | undefined;
      let first: ReturnType<typeof setTimeout> | undefined;
      let inFlight: Promise<void> | undefined;
      let stopped = false;
      const launch = () => {
        if (stopped || inFlight)
          return;
        inFlight = fn().catch(() => {}).finally(() => {
          inFlight = undefined;
        });
      };
      first = setTimeout(() => {
        first = undefined;
        launch();
        timer = setInterval(launch, intervalMs);
        // A background sweep must not keep the process alive on its own.
        (timer as { unref?: () => void }).unref?.();
      }, delayMs);
      (first as { unref?: () => void }).unref?.();
      const handle: ScheduledHandle = {
        async stop() {
          stopped = true;
          if (first)
            clearTimeout(first);
          if (timer)
            clearInterval(timer);
          first = undefined;
          timer = undefined;
          await inFlight;
          handles.delete(handle);
        },
      };
      handles.add(handle);
      void name;
      return handle;
    },
    async stopAll() {
      await Promise.all([...handles].map(h => h.stop()));
    },
  };
}

export function createBunPlatform(): Platform {
  return {
    name: "bun",
    env: {
      get: name => Bun.env[name],
      all: () => ({ ...Bun.env }),
    },
    kv: createMemoryKv(),
    scheduler: createTimerScheduler(),
    capabilities: {
      encryptionAtRest: true,
      argon2: true,
      pbkdf2MaxIterations: Number.POSITIVE_INFINITY,
      subprocess: true,
      filesystem: true,
      residentTimers: true,
    },
  };
}
