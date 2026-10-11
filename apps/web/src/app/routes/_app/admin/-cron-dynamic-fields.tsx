// Dynamic per-action fieldset for the cron create drawer.
//
// Renders one form control per `ActionInput`. Replaces the hardcoded
// per-action React components: new actions registered server-side
// show up here for free as long as the registrant fills in `inputs[]`
// (per the contract in `docs/modules/cron.md` §Action injection).

import type { ReactNode } from "react";
import type { ActionCatalogEntry, ActionInput } from "./-cron-types";
import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/shared/components/ui/badge";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/components/ui/select";
import { Switch } from "@/shared/components/ui/switch";
import { Textarea } from "@/shared/components/ui/textarea";
import { resolveActionIcon } from "./-cron-form";

// ─── Meta info card ───
//
// Shows the registered metadata for the currently picked action so the
// operator knows what they are scheduling: icon, display name, action
// key, version, dangerous flag, category, description, and tags. Driven
// entirely off `ActionCatalogEntry` so external modules surface here
// the moment they register an action.

export function ActionMetaCard({ action }: { readonly action: ActionCatalogEntry }) {
  const { t } = useTranslation("cron");
  // Wrap the looked-up component in a stable holder object so the
  // linter's "components declared during render" guard doesn't trip on
  // `<Icon />`; pattern matches `PortalPage`'s `<tile.icon />`.
  const icon = { Component: resolveActionIcon(action.icon) };
  return (
    <div className="rounded-md border bg-muted/30 p-3">
      <div className="flex items-start gap-3">
        <div className="rounded-md border bg-background p-2 shrink-0">
          <icon.Component className="size-5" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{action.displayName}</span>
            <code className="font-mono text-[11px] text-muted-foreground">{action.name}</code>
            {action.version && (
              <Badge variant="outline" className="text-[10px]">
                v
                {action.version}
              </Badge>
            )}
            {action.dangerous && (
              <Badge variant="destructive" className="text-[10px] uppercase tracking-wide">
                {t("meta.dangerous")}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{action.description}</p>
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            <Badge variant="secondary" className="text-[10px]">
              {t(`actionGroup.${action.category}`, { defaultValue: action.category })}
            </Badge>
            {action.tags.map(tag => (
              <Badge key={tag} variant="outline" className="text-[10px]">{tag}</Badge>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function DynamicActionFields({
  action,
  config,
  setConfig,
}: {
  readonly action: ActionCatalogEntry;
  readonly config: Record<string, unknown>;
  readonly setConfig: (updater: (prev: Record<string, unknown>) => Record<string, unknown>) => void;
}) {
  const { t } = useTranslation("cron");
  const setKey = (key: string, value: unknown) => setConfig(prev => ({ ...prev, [key]: value }));

  // Group inputs by their declared `group` (default: "default") so the
  // SPA can lay them out in sections without hardcoding action names.
  const groups = new Map<string, ActionInput[]>();
  for (const input of action.inputs) {
    const g = input.group ?? "default";
    const bucket = groups.get(g);
    if (bucket)
      bucket.push(input);
    else
      groups.set(g, [input]);
  }

  return (
    <div className="space-y-3">
      {action.dangerous && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-2 text-xs text-amber-900 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>{t("dangerousWarning", { defaultValue: "This action runs with the API process's full privileges. Review every config before saving — there is no sandbox." })}</span>
        </div>
      )}
      {[...groups.entries()].map(([groupName, items]) => (
        <div key={groupName} className="space-y-3">
          {groupName !== "default" && (
            <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{groupName}</div>
          )}
          {items.map(input => (
            <DynamicField
              key={input.key}
              input={input}
              value={config[input.key]}
              onChange={value => setKey(input.key, value)}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function DynamicField({
  input,
  value,
  onChange,
}: {
  readonly input: ActionInput;
  readonly value: unknown;
  readonly onChange: (value: unknown) => void;
}) {
  const id = `cron-config-${input.key}`;
  const labelLine = (
    <div className="flex items-center gap-2">
      <Label htmlFor={id} className="text-xs">{input.label}</Label>
      {input.required && <span className="text-[10px] text-destructive">*</span>}
    </div>
  );

  function renderInput() {
    switch (input.type) {
      case "string":
        return (
          <Input
            id={id}
            placeholder={input.placeholder}
            value={typeof value === "string" ? value : ""}
            onChange={e => onChange(e.target.value)}
          />
        );
      case "secret":
        return (
          <Input
            id={id}
            type="password"
            autoComplete="new-password"
            placeholder={input.placeholder}
            value={typeof value === "string" ? value : ""}
            onChange={e => onChange(e.target.value)}
          />
        );
      case "textarea":
        return (
          <Textarea
            id={id}
            placeholder={input.placeholder}
            value={typeof value === "string" ? value : ""}
            onChange={e => onChange(e.target.value)}
            rows={3}
            className="font-mono text-xs"
          />
        );
      case "number":
        return (
          <Input
            id={id}
            type="number"
            min={input.min}
            max={input.max}
            placeholder={input.placeholder}
            value={value === undefined || value === null ? "" : String(value)}
            onChange={e => onChange(e.target.value === "" ? undefined : e.target.value)}
          />
        );
      case "boolean":
        return (
          <div className="flex items-center gap-2">
            <Switch
              id={id}
              checked={Boolean(value)}
              onCheckedChange={v => onChange(v)}
            />
            <Label htmlFor={id} className="cursor-pointer text-xs">{value ? "on" : "off"}</Label>
          </div>
        );
      case "select":
        return (
          <Select
            value={typeof value === "string" ? value : ""}
            onValueChange={(v) => {
              if (typeof v === "string")
                onChange(v);
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder={input.placeholder}>
                {(v: string) => {
                  const opt = input.options?.find(o => o.value === v);
                  return opt?.label ?? v;
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(input.options ?? []).map(o => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        );
      case "json":
        return (
          <Textarea
            id={id}
            placeholder={input.placeholder}
            value={typeof value === "string" ? value : JSON.stringify(value ?? {}, null, 2)}
            onChange={e => onChange(e.target.value)}
            rows={4}
            className="font-mono text-xs"
          />
        );
      default:
        return null;
    }
  }

  return (
    <div className="space-y-1">
      {labelLine}
      {renderInput()}
      {input.description && <FieldHint>{input.description}</FieldHint>}
    </div>
  );
}

function FieldHint({ children }: { readonly children: ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}
