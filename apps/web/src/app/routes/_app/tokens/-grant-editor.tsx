import type { GrantFormState, RowLevel } from "./-grant-form";
import type { GrantLevel, RegistryPackage } from "@/shared/lib/registry/types";
import { Link } from "@tanstack/react-router";
import { ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Label } from "@/shared/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/components/ui/select";
import { Switch } from "@/shared/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/components/ui/table";
import { GRANT_LEVELS } from "@/shared/lib/registry/grants";
import { isEmpty, packageKey } from "./-grant-form";

const ROW_LEVELS = ["none", ...GRANT_LEVELS] as const satisfies readonly RowLevel[];

function LevelSelect<T extends RowLevel>({ value, options, onChange, label }: {
  readonly value: T;
  readonly options: readonly T[];
  readonly onChange: (level: T) => void;
  readonly label: string;
}) {
  const { t } = useTranslation("grants");
  return (
    <Select
      value={value}
      onValueChange={(v) => {
        if (v !== null)
          onChange(v);
      }}
    >
      <SelectTrigger size="sm" aria-label={label} className="w-28">
        <SelectValue>{(v: T) => t(`level.${v}`)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map(level => (
          <SelectItem key={level} value={level}>{t(`level.${level}`)}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** What each level opens, and what stays closed to every token. */
export function GrantLegend() {
  const { t } = useTranslation("grants");
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div className="space-y-2 rounded-md border p-3">
        <div className="text-sm font-medium">{t("legend.title")}</div>
        <dl className="space-y-1.5 text-xs">
          {GRANT_LEVELS.map(level => (
            <div key={level} className="flex gap-2">
              <dt className="w-12 shrink-0 font-medium">{t(`level.${level}`)}</dt>
              <dd className="text-muted-foreground">{t(`legend.${level}`)}</dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-muted-foreground">{t("legend.inclusive")}</p>
      </div>
      <div role="note" className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <ShieldAlert className="size-4 text-amber-600 dark:text-amber-400" aria-hidden="true" />
          {t("limits.title")}
        </div>
        <p className="text-xs">{t("limits.body")}</p>
        <p className="text-xs text-muted-foreground">{t("limits.session")}</p>
      </div>
    </div>
  );
}

export function GrantEditor({ value, onChange, packages }: {
  readonly value: GrantFormState;
  readonly onChange: (next: GrantFormState) => void;
  readonly packages: readonly RegistryPackage[];
}) {
  const { t } = useTranslation("grants");

  return (
    <div className="space-y-3">
      <label className="flex items-start justify-between gap-3 rounded-md border px-3 py-2">
        <span className="min-w-0">
          <span className="block text-sm font-medium">{t("editor.all")}</span>
          <span className="block text-xs text-muted-foreground">{t("editor.allNote")}</span>
        </span>
        <Switch checked={value.all} onCheckedChange={all => onChange({ ...value, all })} />
      </label>

      {value.all
        ? (
            <div className="flex items-center gap-3">
              <Label>{t("editor.access")}</Label>
              <LevelSelect<GrantLevel>
                value={value.allLevel}
                options={GRANT_LEVELS}
                onChange={allLevel => onChange({ ...value, allLevel })}
                label={t("editor.access")}
              />
            </div>
          )
        : packages.length === 0
          ? (
              <p className="rounded-md border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
                {t("editor.noPackages")}
                {" "}
                <Link to="/packages" className="text-foreground underline underline-offset-4">
                  {t("editor.noPackagesLink")}
                </Link>
              </p>
            )
          : (
              <div className="max-h-64 overflow-y-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("editor.package")}</TableHead>
                      <TableHead className="w-32">{t("editor.access")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {packages.map((pkg) => {
                      const key = packageKey(pkg);
                      return (
                        <TableRow key={key}>
                          <TableCell>
                            <div className="font-mono text-xs">{key}</div>
                            <div className="text-xs text-muted-foreground">{pkg.name}</div>
                          </TableCell>
                          <TableCell>
                            <LevelSelect<RowLevel>
                              value={value.perPackage[key] ?? "none"}
                              options={ROW_LEVELS}
                              onChange={level => onChange({
                                ...value,
                                perPackage: { ...value.perPackage, [key]: level },
                              })}
                              label={t("editor.accessFor", { package: key })}
                            />
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}

      {isEmpty(value) && (
        <p role="status" className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
          {t("editor.emptyWarning")}
        </p>
      )}

      <GrantLegend />
    </div>
  );
}
