/* eslint-disable react-refresh/only-export-components */
import type {
  ActionCatalogEntry,
  ActionsResponse,
  CronJob,
  FormState,
  JobOneResponse,
  JobsListResponse,
  StatusFilter,
  StatusFilterKey,
} from "./-cron-types";
import { createLazyFileRoute } from "@tanstack/react-router";
import { AlertTriangle, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import { ConfirmDeleteDialog } from "@/shared/components/ui/confirm-delete-dialog";
import { Label } from "@/shared/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/components/ui/table";
import { http } from "@/shared/lib/http";
import { CreateJobDrawer } from "./-cron-create-drawer";
import { buildPayload, errorMessage, formatTime } from "./-cron-form";
import { LogsDialog } from "./-cron-logs-dialog";
import { CronRowActions } from "./-cron-row-actions";
import {
  INITIAL_FORM,
  STATUS_FILTER_ORDER,
  STATUS_FILTERS,
  STATUS_VARIANT,
} from "./-cron-types";

export const Route = createLazyFileRoute("/_app/admin/cron")({
  component: CronPage,
});

// ─── Component ───

function CronPage() {
  const { t } = useTranslation("cron");

  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [actions, setActions] = useState<ActionCatalogEntry[]>([]);
  const [supportedFormats, setSupportedFormats] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  // Compound status filter — maps to /api/cron/jobs `deleted` +
  // `lastStatus` query params per STATUS_FILTERS below.
  const [statusFilter, setStatusFilter] = useState<StatusFilterKey>("active");
  // Type filter — `cron_jobs.task_type`, populated from the action
  // catalog's `category` values. `__all__` means no filter.
  const [typeFilter, setTypeFilter] = useState<string>("__all__");

  const [createOpen, setCreateOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [formError, setFormError] = useState<string | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<CronJob | null>(null);
  const [logsTarget, setLogsTarget] = useState<CronJob | null>(null);
  // Mirrors `data.schedulerEnabled` from /cron/actions. The page keeps
  // working in either state (data writes always succeed); when this is
  // false an amber banner explains that jobs land in the DB but the
  // scheduler is not firing ticks.
  const [schedulerEnabled, setSchedulerEnabled] = useState<boolean | null>(null);

  const fetchJobs = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "100" });
      const filter: StatusFilter = STATUS_FILTERS[statusFilter];
      if (filter.deleted !== undefined)
        params.set("deleted", filter.deleted);
      if (filter.lastStatus !== undefined)
        params.set("lastStatus", filter.lastStatus);
      if (typeFilter !== "__all__")
        params.set("taskType", typeFilter);
      const res = await http<JobsListResponse>(`/cron/jobs?${params.toString()}`);
      setJobs(res.data.jobs);
    }
    catch (err) {
      toast.error(errorMessage(err, t("common.error.loadFailed", { ns: "common" })));
    }
    finally {
      setLoading(false);
    }
  }, [statusFilter, typeFilter, t]);

  const fetchActions = useCallback(async () => {
    try {
      const res = await http<ActionsResponse>("/cron/actions");
      setActions(res.data.actions);
      setSupportedFormats(res.data.cronFormats);
      setSchedulerEnabled(res.data.schedulerEnabled);
    }
    catch (err) {
      toast.error(errorMessage(err, t("common.error.loadFailed", { ns: "common" })));
    }
  }, [t]);

  useEffect(() => {
    void fetchJobs();
  }, [fetchJobs]);

  useEffect(() => {
    void fetchActions();
  }, [fetchActions]);

  const selectedAction = useMemo(
    () => actions.find(a => a.name === form.action),
    [actions, form.action],
  );

  // Distinct task-type categories surfaced in the toolbar dropdown.
  // Derived from the action catalog so the options reflect whatever
  // actions are registered in the current API process (custom modules
  // can extend the set via `registerAction(..., { category })`).
  const typeOptions = useMemo<readonly string[]>(() => {
    const seen = new Set<string>();
    for (const a of actions) {
      if (a.category)
        seen.add(a.category);
    }
    return [...seen].sort();
  }, [actions]);

  function resetForm() {
    setForm(INITIAL_FORM);
    setFormError(null);
  }

  async function handleCreate() {
    const payload = buildPayload(form, selectedAction);
    if (!payload.ok) {
      setFormError(payload.error);
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const res = await http<JobOneResponse>("/cron/jobs", {
        method: "POST",
        body: JSON.stringify(payload.body),
      });
      toast.success(t("toast.created", { name: res.data.name }));
      setCreateOpen(false);
      resetForm();
      void fetchJobs();
    }
    catch (err) {
      setFormError(errorMessage(err, t("common.error.saveFailed", { ns: "common" })));
    }
    finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(job: CronJob) {
    try {
      await http<{ success: true }>(`/cron/jobs/${job.id}`, { method: "DELETE" });
      toast.success(t("toast.deleted", { name: job.name }));
      setDeleteTarget(null);
      void fetchJobs();
    }
    catch (err) {
      toast.error(errorMessage(err, t("common.error.deleteFailed", { ns: "common" })));
    }
  }

  async function handlePause(job: CronJob) {
    try {
      await http<{ success: true }>(`/cron/jobs/${job.id}/pause`, { method: "POST" });
      toast.success(t("toast.paused", { name: job.name }));
      void fetchJobs();
    }
    catch (err) {
      toast.error(errorMessage(err, t("common.error.operationFailed", { ns: "common" })));
    }
  }

  async function handleResume(job: CronJob) {
    try {
      await http<{ success: true }>(`/cron/jobs/${job.id}/resume`, { method: "POST" });
      toast.success(t("toast.resumed", { name: job.name }));
      void fetchJobs();
    }
    catch (err) {
      toast.error(errorMessage(err, t("common.error.operationFailed", { ns: "common" })));
    }
  }

  async function handleTrigger(job: CronJob) {
    try {
      const res = await http<{ data: { triggered: boolean; log: { status: string } | null } }>(
        `/cron/jobs/${job.id}/trigger`,
        { method: "POST" },
      );
      toast.success(t("toast.triggered", {
        name: job.name,
        logStatus: res.data.log?.status ?? "—",
      }));
      void fetchJobs();
    }
    catch (err) {
      toast.error(errorMessage(err, t("common.error.operationFailed", { ns: "common" })));
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{t("page.title")}</h1>
          <p className="mt-1 text-muted-foreground">{t("page.description")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void fetchJobs()} disabled={loading}>
            <RefreshCw className={`mr-1 size-3 ${loading ? "animate-spin" : ""}`} />
            {t("refresh")}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              resetForm();
              setCreateOpen(true);
            }}
          >
            <Plus className="mr-1 size-3" />
            {t("createJob")}
          </Button>
        </div>
      </div>

      {/* Status hint: scheduler is off (data routes still work). */}
      {schedulerEnabled === false && (
        <div className="flex items-start gap-3 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-300" />
          <div className="space-y-1">
            <p className="font-medium">{t("schedulerDisabled.title")}</p>
            <p className="text-xs text-muted-foreground">{t("schedulerDisabled.body")}</p>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
        <span>{t("totalCount", { count: jobs.length })}</span>

        <div className="flex items-center gap-2">
          <Label className="cursor-pointer">{t("filter.label")}</Label>
          <Select
            value={statusFilter}
            onValueChange={(v) => {
              if (typeof v === "string" && (STATUS_FILTER_ORDER as readonly string[]).includes(v))
                setStatusFilter(v as StatusFilterKey);
            }}
          >
            <SelectTrigger size="sm" className="w-32">
              <SelectValue>
                {(value: string) => t(`filter.${value}`, { defaultValue: value })}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {STATUS_FILTER_ORDER.map(key => (
                <SelectItem key={key} value={key}>{t(`filter.${key}`)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2">
          <Label className="cursor-pointer">{t("typeFilter.label")}</Label>
          <Select
            value={typeFilter}
            onValueChange={(v) => {
              if (typeof v === "string")
                setTypeFilter(v);
            }}
          >
            <SelectTrigger size="sm" className="w-36">
              <SelectValue>
                {(value: string) => value === "__all__"
                  ? t("typeFilter.all")
                  : t(`typeFilter.cat.${value}`, { defaultValue: value })}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">{t("typeFilter.all")}</SelectItem>
              {typeOptions.map(cat => (
                <SelectItem key={cat} value={cat}>
                  {t(`typeFilter.cat.${cat}`, { defaultValue: cat })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("col.name")}</TableHead>
              <TableHead>{t("col.action")}</TableHead>
              <TableHead>{t("col.schedule")}</TableHead>
              <TableHead>{t("col.next")}</TableHead>
              <TableHead>{t("col.lastRun")}</TableHead>
              <TableHead>{t("col.status")}</TableHead>
              <TableHead className="w-12 text-right">{t("col.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {jobs.length === 0
              ? (
                  <TableRow>
                    <TableCell colSpan={7} className="h-32 text-center text-muted-foreground">
                      {loading ? t("common.loading", { ns: "common" }) : t("noJobs")}
                    </TableCell>
                  </TableRow>
                )
              : jobs.map(job => (
                  <TableRow key={job.id}>
                    <TableCell className="font-medium">{job.name}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{(job.taskConfig.action as string | undefined) ?? job.taskType}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{job.cron}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatTime(job.nextExecution)}</TableCell>
                    <TableCell className="text-xs">
                      {job.lastRun
                        ? (
                            <div className="space-y-0.5">
                              <Badge variant={STATUS_VARIANT[job.lastRun.status] ?? "outline"}>
                                {t(`status.${job.lastRun.status}`, { defaultValue: job.lastRun.status })}
                              </Badge>
                              <div className="text-muted-foreground">{formatTime(job.lastRun.startedAt)}</div>
                            </div>
                          )
                        : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell>
                      <div className="space-y-1">
                        <Badge variant={STATUS_VARIANT[job.status] ?? "outline"}>
                          {t(`status.${job.status}`, { defaultValue: job.status })}
                        </Badge>
                        {job.maxConsecutiveFailures === 0 && (
                          // Surfaced because auto-pause is off — operators
                          // need to spot this when triaging long failure
                          // streaks.
                          <Badge variant="destructive" className="block w-fit text-[10px] uppercase tracking-wide">
                            no auto-pause
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <CronRowActions
                        job={job}
                        onTrigger={() => void handleTrigger(job)}
                        onPause={() => void handlePause(job)}
                        onResume={() => void handleResume(job)}
                        onDelete={() => setDeleteTarget(job)}
                        onViewLogs={() => setLogsTarget(job)}
                      />
                    </TableCell>
                  </TableRow>
                ))}
          </TableBody>
        </Table>
      </div>

      <CreateJobDrawer
        open={createOpen}
        onClose={() => {
          setCreateOpen(false);
          resetForm();
        }}
        actions={actions}
        supportedFormats={supportedFormats}
        form={form}
        setForm={setForm}
        formError={formError}
        submitting={submitting}
        selectedAction={selectedAction}
        onSubmit={() => void handleCreate()}
      />

      <ConfirmDeleteDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open)
            setDeleteTarget(null);
        }}
        title={t("confirm.deleteTitle")}
        description={t("confirm.deleteBody", { name: deleteTarget?.name ?? "" })}
        confirmLabel={t("confirm.deleteConfirm")}
        onConfirm={() => {
          if (deleteTarget)
            void handleDelete(deleteTarget);
        }}
      />

      <LogsDialog
        target={logsTarget}
        onOpenChange={(open) => {
          if (!open)
            setLogsTarget(null);
        }}
      />
    </div>
  );
}
