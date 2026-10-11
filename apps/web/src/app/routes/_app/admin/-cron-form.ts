// Form helpers for the cron admin page — pure functions split out of
// `cron.lazy.tsx` so the route file stays focused on layout and state.

import type { LucideIcon } from "lucide-react";
import type { ActionCatalogEntry, FormState } from "./-cron-types";
import {
  Eraser,
  Globe,
  Settings2,
  Terminal,
  Trash2,
} from "lucide-react";
import { formatDateTime } from "@/shared/lib/format";
import { NAME_REGEX } from "./-cron-types";

// Small lookup so the action catalog's free-form `icon` string (e.g.
// `"Globe"`) resolves to an actual component without pulling all of
// lucide-react into the bundle. Add a new entry when a new action ships
// an icon outside this set; unknown values fall back to `Settings2`.
const ACTION_ICON_MAP: Readonly<Record<string, LucideIcon>> = {
  Eraser,
  Globe,
  Terminal,
  Trash2,
  Settings2,
};

export function resolveActionIcon(name: string | null | undefined): LucideIcon {
  if (name && name in ACTION_ICON_MAP)
    return ACTION_ICON_MAP[name]!;
  return Settings2;
}

function safeJsonParse(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  }
  catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Build the initial config object for an action: every input gets its
 * declared `default` (or the empty value for its type). The result is
 * what we seed `form.config` with when the user picks a new action.
 */
export function initialConfigFor(action: ActionCatalogEntry | undefined): Record<string, unknown> {
  if (!action)
    return {};
  const out: Record<string, unknown> = {};
  for (const input of action.inputs) {
    if (input.default !== undefined) {
      out[input.key] = input.default;
    }
  }
  return out;
}

export function buildPayload(
  form: FormState,
  action: ActionCatalogEntry | undefined,
): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  if (!NAME_REGEX.test(form.name))
    return { ok: false, error: "Name must be alphanumeric, underscore, or hyphen only." };
  if (!form.action || !action)
    return { ok: false, error: "Pick an action." };

  const cron = form.scheduleMode === "preset" ? form.schedulePreset : form.scheduleCustom.trim();
  if (!cron)
    return { ok: false, error: "Schedule is required." };

  // Walk the action's declared inputs and normalise each into the wire
  // shape. Empty / unset values are dropped so the server defaults
  // win. The server's `validateActionConfig` is the final authority.
  const config: Record<string, unknown> = {};
  for (const input of action.inputs) {
    const raw = form.config[input.key];
    if (raw === undefined || raw === null || raw === "") {
      if (input.required)
        return { ok: false, error: `config.${input.key} is required.` };
      continue;
    }
    switch (input.type) {
      case "string":
      case "secret":
      case "textarea":
        config[input.key] = String(raw);
        break;
      case "number": {
        const n = Number(raw);
        if (!Number.isFinite(n))
          return { ok: false, error: `config.${input.key} must be a number.` };
        if (input.min !== undefined && n < input.min)
          return { ok: false, error: `config.${input.key} must be >= ${input.min}.` };
        if (input.max !== undefined && n > input.max)
          return { ok: false, error: `config.${input.key} must be <= ${input.max}.` };
        config[input.key] = n;
        break;
      }
      case "boolean":
        config[input.key] = Boolean(raw);
        break;
      case "select":
        config[input.key] = String(raw);
        break;
      case "json": {
        if (typeof raw !== "string") {
          if (!isPlainObject(raw))
            return { ok: false, error: `config.${input.key} must be a JSON object.` };
          config[input.key] = raw;
          break;
        }
        const parsed = safeJsonParse(raw);
        if (!parsed.ok)
          return { ok: false, error: `config.${input.key} JSON: ${parsed.error}` };
        if (!isPlainObject(parsed.value))
          return { ok: false, error: `config.${input.key} must be a JSON object.` };
        config[input.key] = parsed.value;
        break;
      }
    }
  }

  const body: Record<string, unknown> = { name: form.name, cron, action: form.action, config };
  const retryRaw = form.maxConsecutiveFailures.trim();
  if (retryRaw.length > 0) {
    const n = Number(retryRaw);
    if (!Number.isInteger(n) || n < 0 || n > 100)
      return { ok: false, error: "maxConsecutiveFailures must be an integer between 0 and 100." };
    body.maxConsecutiveFailures = n;
  }
  return { ok: true, body };
}

export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error)
    return err.message || fallback;
  return fallback;
}

export function formatTime(value: string | null | undefined): string {
  if (!value)
    return "—";
  try {
    return formatDateTime(value) || value;
  }
  catch {
    return value;
  }
}
