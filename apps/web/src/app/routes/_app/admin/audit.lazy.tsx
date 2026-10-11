/* eslint-disable react-refresh/only-export-components */
import { createLazyFileRoute } from "@tanstack/react-router";
import { Download, Eye } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/components/ui/dialog";
import { Input } from "@/shared/components/ui/input";
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
import { useDebounce } from "@/shared/hooks/use-debounce";
import { formatDateTime } from "@/shared/lib/format";
import { http } from "@/shared/lib/http";

const RE_DOUBLE_QUOTE = /"/g;

export const Route = createLazyFileRoute("/_app/admin/audit")({
  component: AuditPage,
});

interface AuditEvent {
  readonly id: string;
  readonly actorId: string;
  readonly actorName: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly resourceName: string;
  readonly detail: string | null;
  readonly ip: string;
  readonly userAgent: string;
  readonly result: string;
  readonly createdAt: string;
}

interface AuditListResponse {
  success: boolean;
  data: AuditEvent[];
  meta: { total: number; page: number; limit: number };
}

const ACTION_PREFIXES = [
  "__all__",
  "auth.*",
  "user.*",
  "group.*",
  "app.*",
  "domain.*",
  "host.*",
  "tuple.*",
  "device.*",
  "dns.*",
  "traefik.*",
  "system.*",
];

function AuditPage() {
  const { t } = useTranslation("audit");
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const limit = 50;

  const [actorFilter, setActorFilter] = useState("");
  const [actionFilter, setActionFilter] = useState("__all__");
  const [resultFilter, setResultFilter] = useState("__all__");
  const debouncedActor = useDebounce(actorFilter, 300);

  const [detailEvent, setDetailEvent] = useState<AuditEvent | null>(null);

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("limit", String(limit));
      if (debouncedActor)
        params.set("actor_id", debouncedActor);
      if (actionFilter !== "__all__")
        params.set("action", actionFilter);
      if (resultFilter !== "__all__")
        params.set("result", resultFilter);

      const res = await http<AuditListResponse>(`/audit?${params.toString()}`);
      setEvents(res.data);
      setTotal(res.meta.total);
    }
    catch (err) {
      setError(err instanceof Error ? err.message : t("common.error.loadFailed"));
    }
    finally {
      setLoading(false);
    }
  }, [page, debouncedActor, actionFilter, resultFilter, t]);

  useEffect(() => {
    void fetchEvents();
  }, [fetchEvents]);

  const totalPages = Math.ceil(total / limit);

  const handleExport = () => {
    const rows = events.map(e => ({
      id: e.id,
      actor: e.actorName,
      action: e.action,
      resourceType: e.resourceType,
      resourceId: e.resourceId,
      resourceName: e.resourceName,
      result: e.result,
      ip: e.ip,
      createdAt: e.createdAt,
      detail: e.detail ?? "",
    }));
    const headers = Object.keys(rows[0] ?? {}).join(",");
    const csv = [headers, ...rows.map(r => Object.values(r).map(v => `"${String(v).replace(RE_DOUBLE_QUOTE, "\"\"")}"`).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `audit-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  function formatTime(dateStr: string) {
    try {
      return formatDateTime(dateStr) || dateStr;
    }
    catch {
      return dateStr;
    }
  }

  function parseDetail(detail: string | null): Record<string, unknown> | null {
    if (!detail)
      return null;
    try {
      return JSON.parse(detail) as Record<string, unknown>;
    }
    catch {
      return null;
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t("page.title")}</h1>
          <p className="mt-1 text-muted-foreground">{t("page.description")}</p>
        </div>
        <Button variant="outline" size="sm" onClick={handleExport} disabled={events.length === 0}>
          <Download className="mr-1 size-3" />
          {t("export")}
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>
      )}

      <div className="flex gap-2">
        <Input
          placeholder={t("searchActor")}
          value={actorFilter}
          onChange={(e) => {
            setActorFilter(e.target.value);
            setPage(1);
          }}
          className="max-w-xs"
        />
        <Select
          value={actionFilter}
          onValueChange={(v) => {
            if (v !== null) {
              setActionFilter(v);
              setPage(1);
            }
          }}
        >
          <SelectTrigger className="w-40">
            <SelectValue>
              {(v: string) => v === "__all__" ? t("allActions") : v}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">{t("allActions")}</SelectItem>
            {ACTION_PREFIXES.filter(p => p !== "__all__").map(p => (
              <SelectItem key={p} value={p}>{p}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={resultFilter}
          onValueChange={(v) => {
            if (v !== null) {
              setResultFilter(v);
              setPage(1);
            }
          }}
        >
          <SelectTrigger className="w-32">
            <SelectValue>
              {(v: string) => ({
                __all__: t("allResults"),
                success: t("success"),
                failure: t("failure"),
              }[v])}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">{t("allResults")}</SelectItem>
            <SelectItem value="success">{t("success")}</SelectItem>
            <SelectItem value="failure">{t("failure")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Detail dialog */}
      <Dialog
        open={detailEvent !== null}
        onOpenChange={(open) => {
          if (!open)
            setDetailEvent(null);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("detailTitle")}</DialogTitle>
          </DialogHeader>
          {detailEvent && (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-[100px_1fr] gap-2">
                <span className="font-medium text-muted-foreground">ID</span>
                <span className="break-all font-mono text-xs">{detailEvent.id}</span>
                <span className="font-medium text-muted-foreground">{t("col.actor")}</span>
                <span>
                  {detailEvent.actorName}
                  {" "}
                  (
                  {detailEvent.actorId}
                  )
                </span>
                <span className="font-medium text-muted-foreground">{t("col.action")}</span>
                <Badge variant="outline">{detailEvent.action}</Badge>
                <span className="font-medium text-muted-foreground">{t("col.resource")}</span>
                <span>
                  {detailEvent.resourceType}
                  /
                  {detailEvent.resourceId}
                  {" "}
                  (
                  {detailEvent.resourceName}
                  )
                </span>
                <span className="font-medium text-muted-foreground">{t("col.result")}</span>
                <Badge variant={detailEvent.result === "success" ? "default" : "destructive"}>{detailEvent.result}</Badge>
                <span className="font-medium text-muted-foreground">IP</span>
                <span className="font-mono">{detailEvent.ip}</span>
                <span className="font-medium text-muted-foreground">{t("col.time")}</span>
                <span>{formatTime(detailEvent.createdAt)}</span>
              </div>
              {detailEvent.detail && (
                <div>
                  <p className="mb-1 font-medium text-muted-foreground">{t("detail")}</p>
                  <pre className="max-h-60 overflow-auto rounded-md bg-muted p-3 text-xs">
                    {JSON.stringify(parseDetail(detailEvent.detail), null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline">{t("common.cancel")}</Button>} />
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("col.time")}</TableHead>
              <TableHead>{t("col.actor")}</TableHead>
              <TableHead>{t("col.action")}</TableHead>
              <TableHead>{t("col.resource")}</TableHead>
              <TableHead>{t("col.result")}</TableHead>
              <TableHead>{t("col.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading
              ? (
                  <TableRow><TableCell colSpan={6} className="h-24 text-center text-muted-foreground">{t("common.loading")}</TableCell></TableRow>
                )
              : events.length === 0
                ? (
                    <TableRow><TableCell colSpan={6} className="h-24 text-center text-muted-foreground">{t("noResults")}</TableCell></TableRow>
                  )
                : events.map(event => (
                    <TableRow key={event.id}>
                      <TableCell className="text-xs text-muted-foreground">{formatTime(event.createdAt)}</TableCell>
                      <TableCell className="text-sm">{event.actorName}</TableCell>
                      <TableCell><Badge variant="outline">{event.action}</Badge></TableCell>
                      <TableCell className="text-sm">
                        <span className="text-muted-foreground">
                          {event.resourceType}
                          /
                        </span>
                        {event.resourceName || event.resourceId}
                      </TableCell>
                      <TableCell>
                        <Badge variant={event.result === "success" ? "default" : "destructive"}>
                          {event.result}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Button variant="ghost" size="icon-sm" onClick={() => setDetailEvent(event)}>
                          <Eye className="size-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
          </TableBody>
        </Table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {t("totalCount", { count: total })}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
              {t("common.prev")}
            </Button>
            <span className="flex items-center px-2 text-sm">
              {page}
              {" "}
              /
              {" "}
              {totalPages}
            </span>
            <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>
              {t("common.next")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
