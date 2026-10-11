import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Badge } from "@/shared/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/components/ui/dialog";
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
import { formatDateTime } from "@/shared/lib/format";
import { http } from "@/shared/lib/http";

// Shape mirrored from `apps/api/src/modules/cron/serialize.ts`. Duplicated
// here to keep this sibling component self-contained; the parent route
// passes a `target` whose `id`, `name`, `cron`, `taskType`, and
// `taskConfig.action` are the only fields actually read here.
export interface CronJobTarget {
  readonly id: string;
  readonly name: string;
  readonly cron: string;
  readonly taskType: string;
  readonly taskConfig: Record<string, unknown>;
}

interface LogRow {
  readonly id: string;
  readonly jobId: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly status: string;
  readonly result: string | null;
  readonly error: string | null;
}

interface LogsResponse {
  success: true;
  data: { logs: LogRow[] };
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  running: "default",
  stopped: "secondary",
  paused: "secondary",
  error: "destructive",
  disabled: "outline",
  not_loaded: "outline",
  success: "default",
  failed: "destructive",
};

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error)
    return err.message || fallback;
  return fallback;
}

function formatDuration(ms: number | null | undefined): string {
  if (ms == null)
    return "—";
  if (ms < 1000)
    return `${ms} ms`;
  if (ms < 60_000)
    return `${(ms / 1000).toFixed(2)} s`;
  return `${(ms / 60_000).toFixed(2)} min`;
}

function formatTime(value: string | null | undefined): string {
  if (!value)
    return "—";
  try {
    return formatDateTime(value) || value;
  }
  catch {
    return value;
  }
}

export function LogsDialog({
  target,
  onOpenChange,
}: {
  readonly target: CronJobTarget | null;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("cron");
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!target) {
      // eslint-disable-next-line react/set-state-in-effect -- reset cached rows when the dialog closes.
      setLogs([]);
      return;
    }
    let cancelled = false;
    // eslint-disable-next-line react/set-state-in-effect -- show spinner while the logs fetch settles.
    setLoading(true);
    const params = new URLSearchParams({ limit: "100" });
    if (filter !== "all")
      params.set("status", filter);
    http<LogsResponse>(`/cron/jobs/${target.id}/logs?${params.toString()}`)
      .then((res) => {
        if (!cancelled)
          setLogs(res.data.logs);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          toast.error(errorMessage(err, t("common.error.loadFailed", { ns: "common" })));
      })
      .finally(() => {
        if (!cancelled)
          setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [target, filter, t]);

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("logs.title", { name: target?.name ?? "" })}</DialogTitle>
          <DialogDescription>
            {target && (
              <span className="font-mono text-xs">
                {target.cron}
                {" · "}
                {(target.taskConfig.action as string | undefined) ?? target.taskType}
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Label className="text-xs">{t("logs.filter")}</Label>
            <Select
              value={filter}
              onValueChange={(v) => {
                if (typeof v === "string")
                  setFilter(v);
              }}
            >
              <SelectTrigger size="sm" className="w-40">
                <SelectValue>
                  {(value: string) => ({
                    all: t("logs.filterAll"),
                    running: t("logs.filterRunning"),
                    success: t("logs.filterSuccess"),
                    failed: t("logs.filterFailed"),
                  }[value] ?? value)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("logs.filterAll")}</SelectItem>
                <SelectItem value="running">{t("logs.filterRunning")}</SelectItem>
                <SelectItem value="success">{t("logs.filterSuccess")}</SelectItem>
                <SelectItem value="failed">{t("logs.filterFailed")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("logs.col.startedAt")}</TableHead>
                  <TableHead>{t("logs.col.duration")}</TableHead>
                  <TableHead>{t("logs.col.status")}</TableHead>
                  <TableHead>{t("logs.col.result")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.length === 0
                  ? (
                      <TableRow>
                        <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                          {loading ? t("common.loading", { ns: "common" }) : t("logs.empty")}
                        </TableCell>
                      </TableRow>
                    )
                  : logs.map(row => (
                      <TableRow key={row.id}>
                        <TableCell className="font-mono text-xs">{formatTime(row.startedAt)}</TableCell>
                        <TableCell className="text-xs">{formatDuration(row.durationMs)}</TableCell>
                        <TableCell>
                          <Badge variant={STATUS_VARIANT[row.status] ?? "outline"}>
                            {t(`status.${row.status}`, { defaultValue: row.status })}
                          </Badge>
                        </TableCell>
                        <TableCell className="max-w-md truncate text-xs">
                          {row.status === "failed" && row.error
                            ? <span className="text-destructive">{row.error}</span>
                            : (row.result ?? <span className="text-muted-foreground">—</span>)}
                        </TableCell>
                      </TableRow>
                    ))}
              </TableBody>
            </Table>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
