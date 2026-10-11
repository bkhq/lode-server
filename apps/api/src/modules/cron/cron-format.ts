import { Cron } from "cronbake";

const EVERY_UNITS = new Set(["seconds", "minutes", "hours", "dayOfMonth", "months", "dayOfWeek"]);
const SHORT_UNIT_MAP: Record<string, string> = { s: "seconds", m: "minutes", h: "hours", d: "dayOfMonth" };
const NAMED_ALIASES = new Set([
  "@every_second",
  "@every_minute",
  "@hourly",
  "@daily",
  "@weekly",
  "@monthly",
  "@yearly",
  "@annually",
]);
const EVERY_SHORTHAND_RE = /^@every_(\d+)([smhd])$/;
const DIGITS_ONLY_RE = /^\d+$/;
const WHITESPACE_RE = /\s+/;

export const SUPPORTED_CRON_FORMATS = [
  "5-field standard: \"* * * * *\" (min hour dom month dow)",
  "6-field with seconds: \"* * * * * *\" (sec min hour dom month dow)",
  "@every_<N><unit>: unit = s | m | h | d",
  "@every_<N>_<unit>: unit = seconds | minutes | hours | dayOfMonth | months | dayOfWeek",
  "Aliases: @every_second, @every_minute, @hourly, @daily, @weekly, @monthly, @yearly, @annually",
];

function normalizeEveryExpr(expr: string): string | null {
  if (NAMED_ALIASES.has(expr))
    return expr;

  const shortMatch = expr.match(EVERY_SHORTHAND_RE);
  if (shortMatch) {
    const unit = SHORT_UNIT_MAP[shortMatch[2]!]!;
    return `@every_${shortMatch[1]}_${unit}`;
  }

  const segments = expr.split("_");
  if (segments.length === 3 && DIGITS_ONLY_RE.test(segments[1]!) && EVERY_UNITS.has(segments[2]!)) {
    return expr;
  }

  return null;
}

export function normalizeCron(expr: string): string {
  const trimmed = expr.trim();
  if (trimmed.startsWith("@")) {
    if (!trimmed.startsWith("@every_"))
      return trimmed;
    return normalizeEveryExpr(trimmed) ?? trimmed;
  }
  const parts = trimmed.split(WHITESPACE_RE);
  if (parts.length === 5)
    return `0 ${parts.join(" ")}`;
  return trimmed;
}

export function isValidCron(expr: string): boolean {
  const trimmed = expr.trim();

  if (trimmed.startsWith("@")) {
    if (NAMED_ALIASES.has(trimmed))
      return true;
    if (trimmed.startsWith("@every_"))
      return normalizeEveryExpr(trimmed) !== null;
    return false;
  }

  const parts = trimmed.split(WHITESPACE_RE);
  if (parts.length !== 5 && parts.length !== 6)
    return false;

  return Cron.isValid(normalizeCron(trimmed));
}
