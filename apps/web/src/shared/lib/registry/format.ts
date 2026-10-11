const UNITS = ["B", "KiB", "MiB", "GiB"] as const;

/** Byte count in binary units: whole numbers up to KiB, one decimal from MiB up. */
export function formatBytes(n: number): string {
  if (!(n > 0) || !Number.isFinite(n))
    return "0 B";
  let value = n;
  let unit = 0;
  const digits = () => (unit >= 2 ? 1 : 0);
  // Step up while the value, as it would be printed, reaches 1024.
  while (unit < UNITS.length - 1 && Number(value.toFixed(digits())) >= 1024) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(digits())} ${UNITS[unit]}`;
}

/** Share of `limit` in use, clamped to 0..100; 0 when there is no limit to measure against. */
export function usagePercent(used: number, limit: number): number {
  if (!(limit > 0))
    return 0;
  return Math.min(100, Math.max(0, (used / limit) * 100));
}
