// Shared building blocks for the admin settings page — types, helpers,
// and the generic `SettingsCard` form used by the Auth / SMTP tabs. The
// mix of exports (hook + helper functions + components) is intentional
// for this `-`-prefixed helper module; disable the react-refresh rule
// here so we keep the consumer count low.
/* eslint-disable react-refresh/only-export-components */

import { Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/components/ui/button";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import { http } from "@/shared/lib/http";

// ─── Shared types ───

export interface SettingRow {
  readonly key: string;
  readonly value: string;
  readonly updatedBy: string | null;
  readonly updatedAt: string;
}

// ─── Settings helpers ───

export function useSettingsByPrefix(prefix: string) {
  const [settings, setSettings] = useState<SettingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch_ = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await http<{ success: boolean; data: SettingRow[] }>(`/settings?prefix=${encodeURIComponent(prefix)}`);
      setSettings(res.data);
    }
    catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load settings");
    }
    finally {
      setLoading(false);
    }
  }, [prefix]);

  useEffect(() => {
    void fetch_();
  }, [fetch_]);

  return { settings, loading, error, setError, refetch: fetch_ };
}

export async function saveSetting(key: string, value: string) {
  await http(`/settings/${key}`, {
    method: "PUT",
    body: JSON.stringify({ value }),
  });
}

export async function deleteSetting(key: string) {
  await http(`/settings/${key}`, { method: "DELETE" });
}

// ─── Shared components ───

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {message}
    </div>
  );
}

export function SettingsCard({
  title,
  prefix,
  fields,
  settings,
  onSaved,
  onDeleted,
}: {
  title: string;
  prefix: string;
  fields: readonly { key: string; label: string; sensitive: boolean; placeholder: string }[];
  settings: SettingRow[];
  onSaved: () => void;
  onDeleted?: () => void;
}) {
  const { t } = useTranslation(["common", "settings"]);
  const initialValues = useMemo(() => {
    const initial: Record<string, string> = {};
    for (const field of fields) {
      const fullKey = prefix ? `${prefix}${field.key}` : field.key;
      const setting = settings.find(s => s.key === fullKey);
      initial[field.key] = setting?.value ?? "";
    }
    return initial;
  }, [fields, prefix, settings]);

  const [values, setValues] = useState<Record<string, string>>(initialValues);
  const prevInitialRef = useRef(initialValues);
  if (prevInitialRef.current !== initialValues) {
    prevInitialRef.current = initialValues;
    setValues(initialValues);
  }
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      for (const field of fields) {
        const val = values[field.key];
        if (val !== undefined && val !== "") {
          // Skip saving sensitive fields that still hold the masked placeholder
          if (field.sensitive && val === "******")
            continue;
          const fullKey = prefix ? `${prefix}${field.key}` : field.key;
          await saveSetting(fullKey, val);
        }
      }
      onSaved();
    }
    catch (err) {
      setError(err instanceof Error ? err.message : t("common.error.saveFailed"));
    }
    finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold capitalize">{title}</h3>
        {onDeleted && (
          <Button variant="ghost" size="sm" className="text-destructive" onClick={onDeleted}>
            <Trash2 className="mr-1 size-3" />
            {t("common.delete")}
          </Button>
        )}
      </div>

      {error && <ErrorBanner message={error} />}

      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map(field => (
          <div key={field.key} className="space-y-1">
            <Label className="text-xs">{t(field.label)}</Label>
            <Input
              type={field.sensitive ? "password" : "text"}
              placeholder={field.placeholder}
              value={values[field.key] ?? ""}
              onChange={e => setValues(prev => ({ ...prev, [field.key]: e.target.value }))}
            />
          </div>
        ))}
      </div>

      <div className="flex justify-end">
        <Button size="sm" disabled={saving} onClick={() => void handleSave()}>
          <Save className="mr-1 size-3" />
          {saving ? t("settings:saving") : t("common.save")}
        </Button>
      </div>
    </div>
  );
}
