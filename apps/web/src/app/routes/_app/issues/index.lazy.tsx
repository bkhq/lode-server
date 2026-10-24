/* eslint-disable react-refresh/only-export-components */
import type { CSSProperties, PointerEvent } from "react";
import type { Issue, SimpleUser } from "./-issue-panel";
import { createLazyFileRoute, useNavigate } from "@tanstack/react-router";
import {
  AlertTriangle,
  CalendarDays,
  CircleUser,
  Plus,
  SignalHigh,
  SignalLow,
  SignalMedium,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import { ConfirmDeleteDialog } from "@/shared/components/ui/confirm-delete-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/shared/components/ui/dialog";
import { ErrorBanner } from "@/shared/components/ui/error-banner";
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
import { errorMessage } from "@/shared/lib/errors";
import { http } from "@/shared/lib/http";
import { displayName } from "@/shared/lib/users";
import { cn } from "@/shared/lib/utils";
import { useAuthStore } from "@/shared/stores/auth";
import {
  IssuePanel,
  priorityKey,

  priorityVariants,
  statusKey,

  statusVariants,
} from "./-issue-panel";

export const Route = createLazyFileRoute("/_app/issues/")({
  component: IssuesListPage,
});

interface ListResponse { success: boolean; data: Issue[]; meta: { total: number; page: number; limit: number } }
interface UsersResponse { success: boolean; data: SimpleUser[]; meta: { total: number } }

const DEFAULT_DRAWER_WIDTH = 672;
const MIN_DRAWER_WIDTH = 360;
const MAX_DRAWER_VIEWPORT_RATIO = 0.92;

function clampDrawerWidth(width: number): number {
  if (typeof window === "undefined")
    return width;
  const maxWidth = Math.max(MIN_DRAWER_WIDTH, Math.floor(window.innerWidth * MAX_DRAWER_VIEWPORT_RATIO));
  return Math.min(Math.max(width, MIN_DRAWER_WIDTH), maxWidth);
}

function IssuesListPage() {
  const { t } = useTranslation("issues");
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const isAdmin = user?.role === "admin";

  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("__all__");
  const [priorityFilter, setPriorityFilter] = useState("__all__");
  const [page, setPage] = useState(1);
  const [meta, setMeta] = useState({ total: 0, page: 1, limit: 20 });
  const debouncedSearch = useDebounce(search, 300);

  const [users, setUsers] = useState<SimpleUser[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [drawerIssueId, setDrawerIssueId] = useState<string | null>(null);
  const [drawerWidth, setDrawerWidth] = useState(DEFAULT_DRAWER_WIDTH);
  const [deleteConfirm, setDeleteConfirm] = useState<Issue | null>(null);

  const fetchIssues = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (debouncedSearch)
        params.set("q", debouncedSearch);
      if (statusFilter !== "__all__")
        params.set("status", statusFilter);
      if (priorityFilter !== "__all__")
        params.set("priority", priorityFilter);
      params.set("page", String(page));
      params.set("limit", "20");
      const res = await http<ListResponse>(`/issues?${params}`);
      setIssues(res.data);
      setMeta(res.meta);
    }
    catch (err) {
      setError(errorMessage(err, t("common.error.loadFailed")));
    }
    finally {
      setLoading(false);
    }
  }, [
    debouncedSearch,
    statusFilter,
    priorityFilter,
    page,
    t,
  ]);

  const fetchUsers = useCallback(async () => {
    try {
      const res = await http<UsersResponse>("/account/visible-users");
      setUsers(res.data);
    }
    catch { /* ignore */ }
  }, []);

  useEffect(() => {
    void fetchIssues();
  }, [fetchIssues]);
  useEffect(() => {
    void fetchUsers();
  }, [fetchUsers]);

  useEffect(() => {
    const handleResize = () => setDrawerWidth(width => clampDrawerWidth(width));
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const confirmDelete = async () => {
    if (!deleteConfirm)
      return;
    try {
      await http(`/issues/${deleteConfirm.id}`, { method: "DELETE" });
      setDeleteConfirm(null);
      if (drawerIssueId === deleteConfirm.id)
        setDrawerIssueId(null);
      void fetchIssues();
    }
    catch (err) {
      setError(errorMessage(err, t("common.error.deleteFailed")));
      setDeleteConfirm(null);
    }
  };

  const userMap = new Map(users.map(u => [u.id, u]));
  const totalPages = Math.ceil(meta.total / meta.limit);
  const canDelete = (issue: Issue) => isAdmin || issue.creatorId === user?.id;

  const closeDrawer = (opts?: { deleted?: boolean }) => {
    setDrawerIssueId(null);
    if (opts?.deleted)
      void fetchIssues();
  };

  const openFullscreen = (id: string) => {
    void navigate({
      to: "/issues/$issueId",
      params: { issueId: id },
    });
  };

  const handleDrawerResizeStart = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0)
      return;

    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startWidth = drawerWidth;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
      setDrawerWidth(clampDrawerWidth(startWidth + startX - moveEvent.clientX));
    };

    const handlePointerUp = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
  }, [drawerWidth]);

  const drawerStyle = {
    "--issue-drawer-width": `${drawerWidth}px`,
  } as CSSProperties;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t("page.title")}</h1>
          <p className="mt-1 text-muted-foreground">{t("page.description")}</p>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger render={(
            <Button>
              <Plus className="mr-1 size-4" />
              {t("create")}
            </Button>
          )}
          />
          <DialogContent className="max-h-[85vh] gap-0 overflow-hidden p-0 sm:max-w-xl" showCloseButton={false}>
            <CreateIssueForm
              users={users}
              onCancel={() => setCreateOpen(false)}
              onCreated={(id) => {
                setCreateOpen(false);
                void fetchIssues();
                setDrawerIssueId(id);
              }}
            />
          </DialogContent>
        </Dialog>
      </div>

      <ErrorBanner message={error} />

      <div className="flex gap-2">
        <Input
          placeholder={t("searchPlaceholder")}
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <Select
          value={statusFilter}
          onValueChange={(v) => {
            if (v === null)
              return;
            setStatusFilter(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-40">
            <SelectValue>
              {(v: string) => ({
                __all__: t("allStatuses"),
                open: t("statusOpen"),
                in_progress: t("statusInProgress"),
                done: t("statusDone"),
                cancelled: t("statusCancelled"),
              }[v])}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">{t("allStatuses")}</SelectItem>
            <SelectItem value="open">{t("statusOpen")}</SelectItem>
            <SelectItem value="in_progress">{t("statusInProgress")}</SelectItem>
            <SelectItem value="done">{t("statusDone")}</SelectItem>
            <SelectItem value="cancelled">{t("statusCancelled")}</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={priorityFilter}
          onValueChange={(v) => {
            if (v === null)
              return;
            setPriorityFilter(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-40">
            <SelectValue>
              {(v: string) => ({
                __all__: t("allPriorities"),
                low: t("priorityLow"),
                medium: t("priorityMedium"),
                high: t("priorityHigh"),
                urgent: t("priorityUrgent"),
              }[v])}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">{t("allPriorities")}</SelectItem>
            <SelectItem value="low">{t("priorityLow")}</SelectItem>
            <SelectItem value="medium">{t("priorityMedium")}</SelectItem>
            <SelectItem value="high">{t("priorityHigh")}</SelectItem>
            <SelectItem value="urgent">{t("priorityUrgent")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <ConfirmDeleteDialog
        open={deleteConfirm !== null}
        onOpenChange={(open) => {
          if (!open)
            setDeleteConfirm(null);
        }}
        title={t("deleteTitle")}
        description={t("deleteConfirm", { title: deleteConfirm?.title })}
        onConfirm={() => void confirmDelete()}
      />

      {/* Table */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("col.title")}</TableHead>
              <TableHead>{t("col.status")}</TableHead>
              <TableHead>{t("col.priority")}</TableHead>
              <TableHead>{t("col.assignee")}</TableHead>
              {isAdmin && <TableHead>{t("col.creator")}</TableHead>}
              <TableHead>{t("col.dueDate")}</TableHead>
              <TableHead>{t("col.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading
              ? <TableRow><TableCell colSpan={isAdmin ? 7 : 6} className="h-24 text-center text-muted-foreground">{t("common.loading")}</TableCell></TableRow>
              : issues.length === 0
                ? <TableRow><TableCell colSpan={isAdmin ? 7 : 6} className="h-24 text-center text-muted-foreground">{t("noResults")}</TableCell></TableRow>
                : issues.map(issue => (
                    <TableRow
                      key={issue.id}
                      className={`cursor-pointer ${drawerIssueId === issue.id
                        ? "bg-muted/60"
                        : ""}`}
                      onClick={() => setDrawerIssueId(issue.id)}
                    >
                      <TableCell>
                        <div className="font-medium">{issue.title}</div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={statusVariants[issue.status]} className="text-xs">
                          {t(`status${statusKey(issue.status)}`)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={priorityVariants[issue.priority]}>
                          {t(`priority${priorityKey(issue.priority)}`)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm">
                        {issue.assigneeId
                          ? displayName(userMap, issue.assigneeId)
                          : <span className="text-muted-foreground">{t("unassigned")}</span>}
                      </TableCell>
                      {isAdmin && (
                        <TableCell className="text-sm">
                          {displayName(userMap, issue.creatorId)}
                        </TableCell>
                      )}
                      <TableCell className="text-sm">{issue.dueDate ?? "—"}</TableCell>
                      <TableCell>
                        <div className="flex gap-1" onClick={e => e.stopPropagation()}>
                          {canDelete(issue) && (
                            <Button variant="ghost" size="icon-sm" onClick={() => setDeleteConfirm(issue)}>
                              <Trash2 className="size-4 text-destructive" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
          </TableBody>
        </Table>
        {totalPages > 1 && (
          <div className="flex items-center justify-between border-t px-3 py-2">
            <span className="text-xs text-muted-foreground">{t("totalCount", { count: meta.total })}</span>
            <div className="flex gap-1">
              <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>{t("common.prev")}</Button>
              <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>{t("common.next")}</Button>
            </div>
          </div>
        )}
      </div>

      {/* Drawer — portaled to body so `fixed inset-0` always covers the full
          viewport regardless of any ancestor that may have created a new
          containing block (transform / filter / contain). */}
      {drawerIssueId && createPortal(
        <>
          <div
            className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px]"
            onClick={() => closeDrawer()}
          />
          <div
            role="dialog"
            aria-modal="true"
            className="fixed inset-y-0 right-0 z-50 w-full border-l bg-background shadow-xl sm:w-[min(var(--issue-drawer-width),92vw)]"
            style={drawerStyle}
          >
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={t("resizeDrawer")}
              className="group absolute inset-y-0 left-0 hidden w-3 -translate-x-1/2 cursor-col-resize touch-none items-center justify-center sm:flex"
              onPointerDown={handleDrawerResizeStart}
            >
              <div className="h-full w-px bg-border transition-colors group-hover:bg-primary group-active:bg-primary" />
            </div>
            <IssuePanel
              key={drawerIssueId}
              issueId={drawerIssueId}
              variant="drawer"
              onClose={closeDrawer}
              onMaximize={() => {
                const id = drawerIssueId;
                setDrawerIssueId(null);
                openFullscreen(id);
              }}
              onMutated={() => void fetchIssues()}
            />
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}

// ── Create Issue Form (Linear-style) ──

const PRIORITY_META = {
  low: { Icon: SignalLow, tone: "text-muted-foreground", labelKey: "priorityLow" },
  medium: { Icon: SignalMedium, tone: "text-muted-foreground", labelKey: "priorityMedium" },
  high: { Icon: SignalHigh, tone: "text-amber-500", labelKey: "priorityHigh" },
  urgent: { Icon: AlertTriangle, tone: "text-destructive", labelKey: "priorityUrgent" },
} as const;

type PriorityKey = keyof typeof PRIORITY_META;
const PRIORITY_KEYS: readonly PriorityKey[] = ["low", "medium", "high", "urgent"];

const CHIP_CLASS
  = "h-7 gap-1.5 rounded-full border-dashed px-2.5 text-xs text-muted-foreground hover:text-foreground data-placeholder:text-muted-foreground";

function CreateIssueForm({
  users,
  onCreated,
  onCancel,
}: {
  readonly users: SimpleUser[];
  readonly onCreated: (id: string) => void;
  readonly onCancel: () => void;
}) {
  const { t } = useTranslation("issues");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<PriorityKey>("medium");
  const [assigneeId, setAssigneeId] = useState("__none__");
  const [dueDate, setDueDate] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dueDateRef = useRef<HTMLInputElement>(null);

  const submit = async () => {
    if (!title.trim() || submitting)
      return;
    setSubmitting(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        title: title.trim(),
        priority,
      };
      if (description.trim())
        body.description = description.trim();
      if (assigneeId !== "__none__")
        body.assigneeId = assigneeId;
      if (dueDate)
        body.dueDate = dueDate;
      const res = await http<{ success: boolean; data: Issue }>("/issues", {
        method: "POST",
        body: JSON.stringify(body),
      });
      onCreated(res.data.id);
    }
    catch (err) {
      setError(errorMessage(err, t("common.error.operationFailed")));
    }
    finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void submit();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  };

  const currentPriority = PRIORITY_META[priority];
  const PriorityIcon = currentPriority.Icon;

  const assigneeLabel = assigneeId === "__none__"
    ? t("field.assignee")
    : (() => {
        const u = users.find(item => item.id === assigneeId);
        return u
          ? u.name
          : t("field.assignee");
      })();

  return (
    <form onSubmit={handleSubmit} onKeyDown={handleKeyDown} className="flex flex-col">
      <DialogTitle className="sr-only">{t("createTitle")}</DialogTitle>
      <DialogDescription className="sr-only">{t("createDescription")}</DialogDescription>

      <div className="flex flex-col gap-1 px-4 pt-4 pb-2">
        <input
          autoFocus
          type="text"
          required
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder={t("field.title")}
          aria-label={t("field.title")}
          className="w-full border-none bg-transparent p-0 text-lg font-semibold tracking-tight outline-none placeholder:font-semibold placeholder:text-muted-foreground/50"
        />
        <textarea
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder={t("field.descriptionPlaceholder")}
          aria-label={t("field.description")}
          rows={3}
          className="max-h-60 w-full resize-none border-none bg-transparent p-0 text-sm leading-relaxed outline-none placeholder:text-muted-foreground/60"
        />
      </div>

      {error && (
        <div className="px-4 pb-2">
          <ErrorBanner message={error} />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5 px-4 pb-4">
        <Select value={priority} onValueChange={v => v !== null && setPriority(v as PriorityKey)}>
          <SelectTrigger size="sm" className={CHIP_CLASS} aria-label={t("field.priority")}>
            <PriorityIcon className={cn("size-3.5", currentPriority.tone)} />
            <SelectValue>
              {(v: string) => t(PRIORITY_META[v as PriorityKey].labelKey)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {PRIORITY_KEYS.map((p) => {
              const meta = PRIORITY_META[p];
              const Icon = meta.Icon;
              return (
                <SelectItem key={p} value={p}>
                  <Icon className={cn("size-3.5", meta.tone)} />
                  {t(meta.labelKey)}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>

        <Select value={assigneeId} onValueChange={v => v !== null && setAssigneeId(v)}>
          <SelectTrigger
            size="sm"
            className={cn(CHIP_CLASS, assigneeId !== "__none__" && "text-foreground")}
            aria-label={t("field.assignee")}
          >
            <CircleUser className="size-3.5" />
            <span className="truncate max-w-[10rem]">{assigneeLabel}</span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">{t("unassigned")}</SelectItem>
            {users.map(u => (
              <SelectItem key={u.id} value={u.id}>{`${u.name} (${u.username})`}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="relative">
          <button
            type="button"
            onClick={() => {
              const el = dueDateRef.current;
              if (!el)
                return;
              if (typeof el.showPicker === "function")
                el.showPicker();
              else
                el.focus();
            }}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-full border border-dashed border-input bg-transparent px-2.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
              dueDate && "text-foreground",
            )}
            aria-label={t("field.dueDate")}
          >
            <CalendarDays className="size-3.5" />
            {dueDate || t("field.dueDate")}
          </button>
          <input
            ref={dueDateRef}
            type="date"
            value={dueDate}
            onChange={e => setDueDate(e.target.value)}
            tabIndex={-1}
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 size-full opacity-0"
          />
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t bg-muted/40 px-4 py-2.5">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={submitting || !title.trim()}>
          {t("create")}
        </Button>
      </div>
    </form>
  );
}
