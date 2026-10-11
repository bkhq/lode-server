// Right-side drawer (portaled to body) for creating a cron job —
// replaces the previous Dialog so the form doesn't widen the underlying
// table. The layout mirrors the issue-detail drawer: meta info on top,
// form body in the middle, submit/cancel pinned at the bottom.

import type { ReactNode } from "react";
import type { ActionCatalogEntry, FormState } from "./-cron-types";
import { AlertTriangle, X } from "lucide-react";
import { useMemo } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/components/ui/button";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/components/ui/tabs";
import { ActionMetaCard, DynamicActionFields } from "./-cron-dynamic-fields";
import { initialConfigFor } from "./-cron-form";
import { PRESET_VALUES, SCHEDULE_PRESETS } from "./-cron-types";

export function CreateJobDrawer({
  open,
  onClose,
  actions,
  supportedFormats,
  form,
  setForm,
  formError,
  submitting,
  selectedAction,
  onSubmit,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly actions: readonly ActionCatalogEntry[];
  readonly supportedFormats: readonly string[];
  readonly form: FormState;
  readonly setForm: (updater: (prev: FormState) => FormState) => void;
  readonly formError: string | null;
  readonly submitting: boolean;
  readonly selectedAction: ActionCatalogEntry | undefined;
  readonly onSubmit: () => void;
}) {
  const { t } = useTranslation("cron");

  // Cluster actions by category so the picker reads as grouped sections
  // (e.g. maintenance / network / system / custom) rather than one flat
  // list. The catalog itself is already sorted alphabetically by
  // `getActionsCatalog()` so the within-group order is stable.
  const groupedActions = useMemo(() => {
    const grouped: Record<string, ActionCatalogEntry[]> = {};
    for (const a of actions) {
      const cat = a.category ?? "custom";
      const bucket = grouped[cat];
      if (bucket)
        bucket.push(a);
      else
        grouped[cat] = [a];
    }
    return grouped;
  }, [actions]);

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm(prev => ({ ...prev, [key]: value }));
  }

  function setScheduleMode(mode: FormState["scheduleMode"]) {
    setForm((prev) => {
      // When switching modes, seed the destination field with the
      // current value so the user doesn't lose what they just typed.
      if (mode === "custom" && PRESET_VALUES.has(prev.schedulePreset)) {
        return { ...prev, scheduleMode: mode, scheduleCustom: prev.schedulePreset };
      }
      return { ...prev, scheduleMode: mode };
    });
  }

  if (!open)
    return null;

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px]"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("createJob")}
        className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l bg-background shadow-xl sm:w-[640px] md:w-[720px]"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            const target = e.target as HTMLElement;
            const isEditable = target.tagName === "INPUT" || target.tagName === "TEXTAREA";
            if (!isEditable)
              onClose();
          }
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-2 border-b border-border/60 px-4 py-3 shrink-0">
          <div className="min-w-0">
            <h2 className="text-base font-semibold tracking-tight">{t("createJob")}</h2>
            <p className="text-xs text-muted-foreground">{t("drawer.subtitle")}</p>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t("common.close", { ns: "common" })}>
            <X className="size-4" />
          </Button>
        </div>

        {/* Body — scrollable. Three sections mirror the cron model:
            (1) job metadata (name + schedule + retry — universal across
            actions), (2) the designated action, (3) per-action config
            rendered from `inputs[]`. */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6">
          {/* Section 1 — Job metadata */}
          <DrawerSection title={t("drawer.section.meta")}>
            <FieldRow>
              <Label htmlFor="cron-name">{t("form.name")}</Label>
              <Input
                id="cron-name"
                placeholder={t("form.namePlaceholder")}
                value={form.name}
                onChange={e => setField("name", e.target.value)}
              />
              <FieldHint>{t("form.nameHint")}</FieldHint>
            </FieldRow>

            <FieldRow>
              <Label>{t("form.scheduleMode")}</Label>
              <Tabs
                value={form.scheduleMode}
                onValueChange={(v) => {
                  if (v === "preset" || v === "custom")
                    setScheduleMode(v);
                }}
              >
                <TabsList>
                  <TabsTrigger value="preset">{t("form.scheduleModePreset")}</TabsTrigger>
                  <TabsTrigger value="custom">{t("form.scheduleModeCustom")}</TabsTrigger>
                </TabsList>
                <TabsContent value="preset" className="mt-3">
                  <Select
                    value={form.schedulePreset}
                    onValueChange={(v) => {
                      if (typeof v === "string")
                        setField("schedulePreset", v);
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder={t("form.schedulePreset")}>
                        {(value: string) => {
                          const preset = SCHEDULE_PRESETS.find(p => p.value === value);
                          return preset ? `${t(`presets.${preset.key}`)} · ${preset.value}` : value;
                        }}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {SCHEDULE_PRESETS.map(p => (
                        <SelectItem key={p.value} value={p.value}>
                          <span className="font-medium">{t(`presets.${p.key}`)}</span>
                          <span className="ml-2 font-mono text-xs text-muted-foreground">{p.value}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TabsContent>
                <TabsContent value="custom" className="mt-3 space-y-2">
                  <Input
                    placeholder={t("form.scheduleCustomPlaceholder")}
                    value={form.scheduleCustom}
                    onChange={e => setField("scheduleCustom", e.target.value)}
                    className="font-mono"
                  />
                  <FieldHint>{t("form.scheduleCustomHelp")}</FieldHint>
                  {supportedFormats.length > 0 && (
                    <details className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                      <summary className="cursor-pointer select-none">Supported formats</summary>
                      <ul className="mt-2 space-y-1 pl-4">
                        {supportedFormats.map(f => (
                          <li key={f} className="font-mono">{f}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </TabsContent>
              </Tabs>
            </FieldRow>

            <FieldRow>
              <Label>{t("form.retry")}</Label>
              <div className="rounded-md border bg-muted/30 p-3">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-[160px_1fr] sm:items-start">
                  <div className="space-y-1">
                    <Label htmlFor="cron-retry-max" className="text-xs">{t("form.retryMax")}</Label>
                    <Input
                      id="cron-retry-max"
                      type="number"
                      min={0}
                      max={100}
                      value={form.maxConsecutiveFailures}
                      onChange={e => setField("maxConsecutiveFailures", e.target.value)}
                    />
                  </div>
                  <FieldHint>{t("form.retryMaxHint")}</FieldHint>
                </div>
              </div>
            </FieldRow>
          </DrawerSection>

          {/* Section 2 — Designated action. The picker doubles as the
              entry point for section 3 (per-action config). When an
              action is selected its meta card is rendered inline so the
              operator can see what they're scheduling without leaving
              the form. */}
          <DrawerSection title={t("drawer.section.action")}>
            <FieldRow>
              <Label>{t("form.action")}</Label>
              <Select
                value={form.action}
                onValueChange={(v) => {
                  if (typeof v !== "string")
                    return;
                  // Seed `form.config` with the new action's defaults so
                  // the dynamic form starts with sensible values and
                  // stale per-input state from the previously selected
                  // action doesn't bleed through.
                  const next = actions.find(a => a.name === v);
                  setForm(prev => ({ ...prev, action: v, config: initialConfigFor(next) }));
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={t("form.actionPlaceholder")}>
                    {(value: string) => {
                      const a = actions.find(act => act.name === value);
                      return a?.displayName ?? value ?? t("form.actionPlaceholder");
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(groupedActions).map(([category, items]) => (
                    <SelectGroup key={category}>
                      <div className="px-2 pt-2 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                        {t(`actionGroup.${category}`, { defaultValue: category })}
                      </div>
                      {items.map(a => (
                        <SelectItem key={a.name} value={a.name}>
                          <span className="font-medium">{a.displayName}</span>
                          <span className="ml-2 text-xs text-muted-foreground">{a.description}</span>
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
              {selectedAction && selectedAction.requiredKeys.length > 0 && (
                <FieldHint>
                  {t("form.actionRequiredFields", { fields: selectedAction.requiredKeys.join(", ") })}
                </FieldHint>
              )}
            </FieldRow>
            {selectedAction && (
              <ActionMetaCard action={selectedAction} />
            )}
          </DrawerSection>

          {/* Section 3 — Per-action config. Driven entirely by the
              selected action's `inputs[]` descriptor. */}
          {selectedAction && selectedAction.inputs.length > 0 && (
            <DrawerSection title={t("drawer.section.config")}>
              <DynamicActionFields
                action={selectedAction}
                config={form.config}
                setConfig={(updater) => {
                  setForm(prev => ({ ...prev, config: updater(prev.config) }));
                }}
              />
            </DrawerSection>
          )}

          {formError && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>{formError}</span>
            </div>
          )}
        </div>

        {/* Footer — pinned to the bottom of the drawer regardless of body scroll. */}
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border/60 px-4 py-3">
          <Button type="button" variant="outline" onClick={onClose}>
            {t("form.cancel")}
          </Button>
          <Button disabled={submitting} onClick={onSubmit}>
            {submitting ? t("form.submitting") : t("form.submit")}
          </Button>
        </div>
      </div>
    </>,
    document.body,
  );
}

// ─── Small layout helpers ───

function FieldRow({ children }: { readonly children: ReactNode }) {
  return <div className="space-y-2">{children}</div>;
}

function FieldHint({ children }: { readonly children: ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

// Visual grouping used by the create-job drawer so its three sections
// (job metadata / action / per-action config) read as distinct chunks
// without nesting cards inside cards.
function DrawerSection({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      <div className="space-y-4">{children}</div>
    </section>
  );
}
