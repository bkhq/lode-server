import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpCircle, CheckCircle2, History, PauseCircle, PlayCircle, RefreshCw, RotateCcw, RotateCw, Settings2, XCircle } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/shared/components/ui/card";
import { CenteredHint } from "@/shared/components/ui/centered-hint";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/components/ui/dialog";
import { ErrorBanner } from "@/shared/components/ui/error-banner";
import { Input } from "@/shared/components/ui/input";
import { http } from "@/shared/lib/http";

interface SystemVersion {
  readonly version: string | null;
  readonly commit: string | null;
  readonly buildTime: string | null;
  readonly lode?: LodeStatus | null;
}

interface LodeHistoryEntry {
  readonly version: string;
  readonly at: string;
  readonly result: "good" | "bad";
}

interface LodeStatus {
  readonly supervised?: boolean | null;
  readonly active?: boolean | null;
  readonly stateAvailable?: boolean | null;
  readonly status?: string | null;
  readonly current?: string | null;
  readonly lastGood?: string | null;
  readonly available?: string | null;
  readonly channel?: string | null;
  readonly activeVersion?: string | null;
  readonly readinessMode?: string | null;
  readonly ready?: boolean | null;
  readonly hold?: boolean | null;
  readonly configChanged?: boolean | null;
  readonly lastCheckAt?: string | null;
  readonly lastError?: string | null;
  readonly history?: readonly LodeHistoryEntry[] | null;
  readonly updateAvailable?: boolean | null;
  readonly rollbackTarget?: string | null;
  readonly config?: LodeConfig | null;
}

interface LodeConfig {
  readonly status?: string | null;
  readonly app?: string | null;
  readonly sourceType?: string | null;
  readonly source?: string | null;
  readonly asset?: string | null;
  readonly channel?: string | null;
  readonly policy?: string | null;
  readonly checkInterval?: number | null;
  readonly keepVersions?: number | null;
  readonly pin?: string | null;
  readonly requireSignature?: string | null;
  readonly runtime?: string | null;
  readonly runtimeVersion?: string | null;
}

type Confirmation
  = | { readonly kind: "restart" }
    | { readonly kind: "update"; readonly target: string }
    | { readonly kind: "rollback"; readonly target?: string };

const versionQueryKey = ["system", "version"] as const;

async function fetchVersion(): Promise<SystemVersion> {
  return (await http<{ data: SystemVersion }>("/system/version")).data;
}

export function AboutSettingsTab() {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  const versionQuery = useQuery({ queryKey: versionQueryKey, queryFn: fetchVersion });
  const [confirm, setConfirm] = useState<Confirmation | null>(null);

  const version = versionQuery.data;

  function onError(err: unknown) {
    toast.error(err instanceof Error ? err.message : t("about.lode.actionFailed"));
  }
  function onDone(message: string) {
    toast.success(message);
    setConfirm(null);
    void qc.invalidateQueries({ queryKey: versionQueryKey });
  }

  const restartMutation = useMutation({
    mutationFn: () => http("/system/lode/restart", { method: "POST" }),
    onSuccess: () => onDone(t("about.lode.restartRequested")),
    onError,
  });
  const updateMutation = useMutation({
    mutationFn: (target: string) => http("/system/lode/update", { method: "POST", body: JSON.stringify({ target }) }),
    onSuccess: (_d, target) => onDone(t("about.lode.updateRequested", { target })),
    onError,
  });
  const rollbackMutation = useMutation({
    mutationFn: (target?: string) => http("/system/lode/rollback", { method: "POST", body: JSON.stringify(target ? { version: target } : {}) }),
    onSuccess: () => onDone(t("about.lode.rollbackRequested")),
    onError,
  });
  const holdMutation = useMutation({
    mutationFn: (hold: boolean) => http("/system/lode/hold", { method: "POST", body: JSON.stringify({ hold }) }),
    onSuccess: (_d, hold) => onDone(hold ? t("about.lode.holdSet") : t("about.lode.holdReleased")),
    onError,
  });

  const pending = restartMutation.isPending || updateMutation.isPending || rollbackMutation.isPending || holdMutation.isPending;

  function runConfirmed() {
    if (!confirm)
      return;
    if (confirm.kind === "restart")
      restartMutation.mutate();
    else if (confirm.kind === "update")
      updateMutation.mutate(confirm.target);
    else
      rollbackMutation.mutate(confirm.target);
  }

  return (
    <div className="space-y-4 pt-4">
      {versionQuery.error && (
        <ErrorBanner message={versionQuery.error instanceof Error ? versionQuery.error.message : t("about.loadFailed")} />
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t("about.title")}</CardTitle>
          <CardDescription>{t("about.description")}</CardDescription>
          <CardAction>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void versionQuery.refetch()}
              disabled={versionQuery.isFetching}
            >
              <RefreshCw className={versionQuery.isFetching ? "animate-spin" : undefined} />
              {t("about.refresh")}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {versionQuery.isLoading
            ? <CenteredHint>{t("about.loading")}</CenteredHint>
            : (
                <div className="grid gap-3 sm:grid-cols-3">
                  <InfoField label={t("about.version")} value={version?.version} />
                  <InfoField label={t("about.commit")} value={version?.commit} mono />
                  <InfoField label={t("about.buildTime")} value={formatBuildTime(version?.buildTime)} />
                </div>
              )}
        </CardContent>
      </Card>

      <LodeCard
        lode={version?.lode}
        pending={pending}
        onRestart={() => setConfirm({ kind: "restart" })}
        onUpdate={target => setConfirm({ kind: "update", target })}
        onRollback={target => setConfirm(target ? { kind: "rollback", target } : { kind: "rollback" })}
        onHold={held => holdMutation.mutate(held)}
      />

      <ConfirmDialog
        confirm={confirm}
        pending={pending}
        onCancel={() => setConfirm(null)}
        onConfirm={runConfirmed}
      />
    </div>
  );
}

interface LodeCardProps {
  readonly lode: LodeStatus | null | undefined;
  readonly pending: boolean;
  readonly onRestart: () => void;
  readonly onUpdate: (target: string) => void;
  readonly onRollback: (target?: string) => void;
  readonly onHold: (held: boolean) => void;
}

function LodeCard({ lode, pending, onRestart, onUpdate, onRollback, onHold }: LodeCardProps) {
  const { t } = useTranslation("settings");
  const [versionInput, setVersionInput] = useState("");
  const active = lode?.active === true;
  const held = lode?.hold === true;
  const rollbackTarget = safeText(lode?.rollbackTarget);

  const rows = [
    { label: t("about.lode.status"), value: held ? t("about.lode.statusHeld") : safeText(lode?.status) },
    { label: t("about.lode.current"), value: safeText(lode?.current) },
    { label: t("about.lode.lastGood"), value: safeText(lode?.lastGood) },
    { label: t("about.lode.available"), value: safeText(lode?.available) },
    { label: t("about.lode.activeVersion"), value: safeText(lode?.activeVersion) },
    { label: t("about.lode.readiness"), value: lode?.ready == null ? null : boolText(lode.ready, t) },
    { label: t("about.lode.lastCheck"), value: safeText(lode?.lastCheckAt) },
    { label: t("about.lode.lastError"), value: safeText(lode?.lastError) },
  ].filter(row => row.value != null);

  const cfg = lode?.config;
  const configRows = [
    { label: t("about.lode.source"), value: cfg?.source ? `${cfg.sourceType ?? ""} ${cfg.source}`.trim() : null },
    { label: t("about.lode.asset"), value: safeText(cfg?.asset) },
    { label: t("about.lode.channel"), value: safeText(cfg?.channel) },
    { label: t("about.lode.policy"), value: safeText(cfg?.policy) },
    { label: t("about.lode.pin"), value: safeText(cfg?.pin) },
    { label: t("about.lode.checkInterval"), value: cfg?.checkInterval == null ? null : t("about.lode.seconds", { n: cfg.checkInterval }) },
    { label: t("about.lode.keepVersions"), value: cfg?.keepVersions == null ? null : String(cfg.keepVersions) },
    { label: t("about.lode.signature"), value: safeText(cfg?.requireSignature) },
    { label: t("about.lode.runtime"), value: cfg?.runtime ? `${cfg.runtime}${cfg.runtimeVersion ? ` ${cfg.runtimeVersion}` : ""}` : null },
  ].filter(row => row.value != null);
  // Show the config section when lode.toml is present (even if some fields are
  // absent); flag a present-but-unreadable file.
  const configProblem = cfg && cfg.status != null && cfg.status !== "available" && cfg.status !== "not_configured";

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("about.lode.title")}</CardTitle>
        <CardDescription>{t("about.lode.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!active && <p className="text-sm text-muted-foreground">{t("about.lode.unavailable")}</p>}

        {lode?.updateAvailable && (
          <Banner tone="primary" icon={<ArrowUpCircle className="size-4 shrink-0 text-primary" />} text={t("about.lode.updateAvailable", { version: lode.available, current: lode.current ?? "?" })}>
            <Button type="button" size="sm" disabled={pending || !active} onClick={() => lode.available && onUpdate(lode.available)}>
              <ArrowUpCircle />
              {t("about.lode.updateNow")}
            </Button>
          </Banner>
        )}

        {lode?.configChanged && (
          <Banner tone="amber" icon={<Settings2 className="size-4 shrink-0 text-amber-600" />} text={t("about.lode.configChanged")}>
            <Button type="button" size="sm" variant="outline" disabled={pending || !active} onClick={onRestart}>
              <RotateCw />
              {t("about.lode.applyConfig")}
            </Button>
          </Banner>
        )}

        {held && (
          <Banner tone="amber" icon={<PauseCircle className="size-4 shrink-0 text-amber-600" />} text={t("about.lode.holdActive")}>
            <Button type="button" size="sm" variant="outline" disabled={pending || !active} onClick={() => onHold(false)}>
              <PlayCircle />
              {t("about.lode.release")}
            </Button>
          </Banner>
        )}

        <div className="flex flex-wrap gap-2">
          <BooleanBadge label={t("about.lode.supervised")} value={lode?.supervised} />
          <BooleanBadge label={t("about.lode.active")} value={lode?.active} />
        </div>

        <InfoSection title={t("about.lode.lifecycle")} rows={rows} />

        {(configRows.length > 0 || configProblem) && (
          <div className="space-y-2">
            <InfoSection title={t("about.lode.config")} rows={configRows} />
            {configProblem && <p className="text-sm text-muted-foreground">{t("about.lode.configUnavailable")}</p>}
          </div>
        )}

        {lode?.history && lode.history.length > 0 && (
          <HistorySection entries={lode.history} />
        )}

        <div className="flex flex-wrap gap-2 border-t pt-4">
          <Button type="button" variant="outline" disabled={pending || !active} onClick={onRestart}>
            <RotateCw />
            {t("about.lode.restart")}
          </Button>
          <Button type="button" variant="outline" disabled={pending || !active} onClick={() => onUpdate("latest")}>
            <ArrowUpCircle />
            {t("about.lode.updateLatest")}
          </Button>
          {rollbackTarget && (
            <Button type="button" variant="outline" disabled={pending || !active} onClick={() => onRollback()}>
              <RotateCcw />
              {t("about.lode.rollback", { version: rollbackTarget })}
            </Button>
          )}
          {!held && (
            <Button type="button" variant="outline" disabled={pending || !active} onClick={() => onHold(true)}>
              <PauseCircle />
              {t("about.lode.hold")}
            </Button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={versionInput}
            onChange={e => setVersionInput(e.target.value)}
            placeholder={t("about.lode.versionPlaceholder")}
            disabled={pending || !active}
            className="h-9 w-44"
          />
          <Button
            type="button"
            variant="outline"
            disabled={pending || !active || !versionInput.trim()}
            onClick={() => onUpdate(versionInput.trim())}
          >
            <ArrowUpCircle />
            {t("about.lode.switchVersion")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Banner({ tone, icon, text, children }: { readonly tone: "primary" | "amber"; readonly icon: ReactNode; readonly text: string; readonly children: ReactNode }) {
  const border = tone === "primary" ? "border-primary/30 bg-primary/5" : "border-amber-500/40 bg-amber-500/10";
  return (
    <div className={`flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm ${border}`}>
      {icon}
      <span className="min-w-0 flex-1">{text}</span>
      {children}
    </div>
  );
}

function HistorySection({ entries }: { readonly entries: readonly LodeHistoryEntry[] }) {
  const { t } = useTranslation("settings");
  return (
    <div className="rounded-lg border">
      <div className="flex items-center gap-1.5 border-b px-3 py-2 text-sm font-medium">
        <History className="size-4" />
        {t("about.lode.history")}
      </div>
      <div className="divide-y">
        {entries.slice(0, 10).map(e => (
          <div key={`${e.version}@${e.at}`} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
            <span className="font-mono">{e.version}</span>
            <span className="flex items-center gap-2">
              <span className="text-muted-foreground">{formatBuildTime(e.at) ?? e.at}</span>
              <Badge variant={e.result === "good" ? "secondary" : "outline"}>
                {e.result === "good" ? <CheckCircle2 /> : <XCircle />}
                {e.result === "good" ? t("about.lode.historyGood") : t("about.lode.historyBad")}
              </Badge>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ConfirmDialog({
  confirm,
  pending,
  onCancel,
  onConfirm,
}: {
  readonly confirm: Confirmation | null;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const { t } = useTranslation("settings");
  const title = confirm?.kind === "restart"
    ? t("about.lode.restartConfirmTitle")
    : confirm?.kind === "update"
      ? t("about.lode.updateConfirmTitle")
      : t("about.lode.rollbackConfirmTitle");
  const description = confirm?.kind === "restart"
    ? t("about.lode.restartConfirmDescription")
    : confirm?.kind === "update"
      ? t("about.lode.updateConfirmDescription", { target: confirm.target })
      : t("about.lode.rollbackConfirmDescription", { target: confirm?.kind === "rollback" ? confirm.target ?? t("about.lode.lastGoodVersion") : "" });
  return (
    <Dialog open={confirm !== null} onOpenChange={open => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
            {t("about.lode.cancel")}
          </Button>
          <Button type="button" onClick={onConfirm} disabled={pending}>
            {t("about.lode.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InfoSection({ title, rows }: { readonly title: string; readonly rows: readonly { readonly label: string; readonly value: ReactNode }[] }) {
  const { t } = useTranslation("settings");
  return (
    <div className="rounded-lg border">
      <div className="border-b px-3 py-2 text-sm font-medium">{title}</div>
      {rows.length > 0
        ? (
            <div className="divide-y">
              {rows.map(row => (
                <div key={row.label} className="grid gap-1 px-3 py-2 text-sm sm:grid-cols-[11rem_1fr]">
                  <div className="text-muted-foreground">{row.label}</div>
                  <div className="min-w-0 break-words">{row.value}</div>
                </div>
              ))}
            </div>
          )
        : <div className="px-3 py-2 text-sm text-muted-foreground">{t("about.empty")}</div>}
    </div>
  );
}

function InfoField({ label, value, mono = false }: { readonly label: string; readonly value: string | null | undefined; readonly mono?: boolean }) {
  return (
    <div className="rounded-lg border bg-muted/30 p-3">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className={mono ? "mt-1 break-all font-mono text-sm" : "mt-1 break-words text-sm font-medium"}>
        {safeText(value) ?? "—"}
      </div>
    </div>
  );
}

function BooleanBadge({ label, value }: { readonly label: string; readonly value: boolean | null | undefined }) {
  const { t } = useTranslation("settings");
  const enabled = value === true;
  return (
    <Badge variant={enabled ? "secondary" : "outline"}>
      {enabled ? <CheckCircle2 /> : <XCircle />}
      <span>{`${label}:`}</span>
      <span>{boolText(value, t)}</span>
    </Badge>
  );
}

function boolText(value: boolean | null | undefined, t: (key: string) => string) {
  if (value === true)
    return t("about.yes");
  if (value === false)
    return t("about.no");
  return t("about.unknown");
}

function safeText(value: string | null | undefined) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || null;
}

function formatBuildTime(value: string | null | undefined) {
  const text = safeText(value);
  if (!text)
    return null;
  const timestamp = Date.parse(text);
  if (Number.isNaN(timestamp))
    return text;
  return new Date(timestamp).toLocaleString();
}
