import type { Platform } from "@/platform";
import { afterEach, describe, expect, test } from "bun:test";
import { __resetPlatformForTests, getPlatform, setPlatform } from "@/platform";
import { assertCronSchedulerSupported } from "./cron.service";

function platformWithResidentTimers(residentTimers: boolean): Platform {
  const base = getPlatform();
  return { ...base, capabilities: { ...base.capabilities, residentTimers } };
}

afterEach(() => __resetPlatformForTests());

describe("assertCronSchedulerSupported", () => {
  test("passes on a runtime that stays resident between requests", () => {
    setPlatform(platformWithResidentTimers(true));
    expect(() => assertCronSchedulerSupported()).not.toThrow();
  });

  test("refuses on a runtime that is evicted when idle, and names the way out", () => {
    setPlatform(platformWithResidentTimers(false));
    expect(() => assertCronSchedulerSupported()).toThrow(/CRON_ENABLED/);
    expect(() => assertCronSchedulerSupported()).toThrow(/cron\/jobs\/:id\/trigger/);
  });
});
