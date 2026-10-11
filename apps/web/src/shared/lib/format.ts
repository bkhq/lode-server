// Locale-aware date formatting. Drives output off the active i18n language
// instead of the browser locale, so a zh-CN user with navigator.language=en
// still sees Chinese dates.

import i18n from "@/app/i18n";

function lang(): string {
  return i18n?.language || "en";
}

export function formatDate(value: Date | string | number): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime()))
    return "";
  return new Intl.DateTimeFormat(lang(), {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(d);
}

export function formatDateTime(value: Date | string | number): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime()))
    return "";
  return new Intl.DateTimeFormat(lang(), {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}
