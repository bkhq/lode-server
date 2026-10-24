/* eslint-disable react-refresh/only-export-components */
import {
  ArrowLeft,
  Maximize2,
  Paperclip,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { MarkdownEditor } from "@/shared/components/editor";
import {
  ResourceFooterSections,
  useResourceAttachmentUpload,
  validateAttachmentSelection,
} from "@/shared/components/resource";
import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import { CenteredHint } from "@/shared/components/ui/centered-hint";
import { ConfirmDeleteDialog } from "@/shared/components/ui/confirm-delete-dialog";
import { ErrorBanner } from "@/shared/components/ui/error-banner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/components/ui/select";
import { errorMessage } from "@/shared/lib/errors";
import { formatDateTime } from "@/shared/lib/format";
import { http } from "@/shared/lib/http";
import { displayName } from "@/shared/lib/users";
import { useAuthStore } from "@/shared/stores/auth";

// ── Types ──

export interface Issue {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly status: "open" | "in_progress" | "done" | "cancelled";
  readonly priority: "low" | "medium" | "high" | "urgent";
  readonly creatorId: string;
  readonly assigneeId: string | null;
  readonly dueDate: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SimpleUser {
  readonly id: string;
  readonly name: string;
  readonly username: string;
}

// ── Helpers ──

export const statusVariants: Record<string, "default" | "outline" | "secondary"> = {
  open: "outline",
  in_progress: "default",
  done: "secondary",
  cancelled: "secondary",
};

export const priorityVariants: Record<string, "default" | "outline" | "secondary" | "destructive"> = {
  low: "secondary",
  medium: "outline",
  high: "default",
  urgent: "destructive",
};

export function statusKey(s: string) {
  const map: Record<string, string> = {
    open: "Open",
    in_progress: "InProgress",
    done: "Done",
    cancelled: "Cancelled",
  };
  return map[s] ?? s;
}

export function priorityKey(p: string) {
  const map: Record<string, string> = {
    low: "Low",
    medium: "Medium",
    high: "High",
    urgent: "Urgent",
  };
  return map[p] ?? p;
}

const STATUSES = [
  "open",
  "in_progress",
  "done",
  "cancelled",
] as const;
const PRIORITIES = ["low", "medium", "high", "urgent"] as const;

// ── IssuePanel ──

interface IssuePanelProps {
  readonly issueId: string;
  readonly variant: "drawer" | "fullscreen";
  readonly onClose: (opts?: { deleted?: boolean }) => void;
  readonly onMaximize?: () => void;
  readonly onMutated?: () => void;
}

export function IssuePanel({ issueId, variant, onClose, onMaximize, onMutated }: IssuePanelProps) {
  const { t } = useTranslation("issues");
  const { user } = useAuthStore();
  const isAdmin = user?.role === "admin";

  const [issue, setIssue] = useState<Issue | null>(null);
  const [users, setUsers] = useState<SimpleUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [descDraft, setDescDraft] = useState("");
  const [editingDesc, setEditingDesc] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const dueDateInputRef = useRef<HTMLInputElement>(null);

  const fetchIssue = useCallback(async () => {
    setLoading(true);
    try {
      const res = await http<{ success: boolean; data: Issue }>(`/issues/${issueId}`);
      setIssue(res.data);
      setTitleDraft(res.data.title);
      setDescDraft(res.data.description ?? "");
    }
    catch (err) {
      setError(errorMessage(err, t("common.error.loadFailed")));
    }
    finally {
      setLoading(false);
    }
  }, [issueId, t]);

  const fetchUsers = useCallback(async () => {
    try {
      const res = await http<{ success: boolean; data: SimpleUser[] }>("/account/visible-users");
      setUsers(res.data);
    }
    catch { /* ignore */ }
  }, []);

  useEffect(() => {
    void fetchIssue();
  }, [fetchIssue]);

  useEffect(() => {
    void fetchUsers();
  }, [fetchUsers]);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const { upload, fileInputRef, limits, attachmentCount } = useResourceAttachmentUpload({
    resource: "issues",
    resourceId: issueId,
    onError: err => setError(errorMessage(err, t("common.error.uploadFailed"))),
  });

  const handleUpload = (files: FileList | null) => {
    if (!files || files.length === 0 || upload.isPending)
      return;
    setError(null);
    const selected = Array.from(files);
    const validation = validateAttachmentSelection(selected, attachmentCount, limits.maxFileSize, limits.maxAttachmentsPerResource);
    if (validation === "limit") {
      setError(t("attachments.limitReached"));
      if (fileInputRef.current)
        fileInputRef.current.value = "";
      return;
    }
    if (validation === "size") {
      setError(t("attachments.fileTooLarge"));
      if (fileInputRef.current)
        fileInputRef.current.value = "";
      return;
    }
    upload.mutate(selected);
  };

  const patch = useCallback(async (body: Record<string, unknown>) => {
    try {
      const res = await http<{ success: boolean; data: Issue }>(`/issues/${issueId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setIssue(res.data);
      onMutated?.();
    }
    catch (err) {
      setError(errorMessage(err, t("common.error.operationFailed")));
    }
  }, [issueId, t, onMutated]);

  const confirmDelete = async () => {
    try {
      await http(`/issues/${issueId}`, { method: "DELETE" });
      setDeleteOpen(false);
      onClose({ deleted: true });
    }
    catch (err) {
      setError(errorMessage(err, t("common.error.deleteFailed")));
      setDeleteOpen(false);
    }
  };

  const permissions = useMemo(() => {
    if (!issue || !user)
      return { canEditAll: false, canEditStatus: false, canDelete: false };
    const isCreator = issue.creatorId === user.id;
    const isAssignee = issue.assigneeId === user.id;
    const canEditAll = isAdmin || isCreator;
    return {
      canEditAll,
      canEditStatus: canEditAll || isAssignee,
      canDelete: canEditAll,
    };
  }, [issue, user, isAdmin]);

  const userMap = useMemo(() => new Map(users.map(u => [u.id, u])), [users]);

  const canUploadAttachment = !!issue && (permissions.canEditAll || issue.assigneeId === user?.id);

  const saveTitle = () => {
    const trimmed = titleDraft.trim();
    if (issue && trimmed && trimmed !== issue.title) {
      void patch({ title: trimmed });
    }
    else if (issue) {
      setTitleDraft(issue.title);
    }
    setEditingTitle(false);
  };

  const saveDesc = () => {
    if (!issue)
      return;
    const next = descDraft;
    const current = issue.description ?? "";
    if (next !== current) {
      void patch(next.trim()
        ? { description: next }
        : { description: null });
    }
    setEditingDesc(false);
  };

  const cancelDesc = () => {
    setDescDraft(issue?.description ?? "");
    setEditingDesc(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      const target = e.target as HTMLElement;
      const isEditable = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
      if (isEditable) {
        target.blur();
        e.stopPropagation();
      }
      else if (variant === "drawer") {
        onClose();
      }
    }
  };

  if (loading && !issue)
    return <CenteredHint>{t("common.loading")}</CenteredHint>;

  if (!issue)
    return <CenteredHint tone="destructive">{error ?? t("common.error.loadFailed")}</CenteredHint>;

  const creatorName = displayName(userMap, issue.creatorId);

  return (
    <div
      ref={panelRef}
      className="flex h-full flex-col bg-background outline-none"
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2 shrink-0">
        {variant === "fullscreen" && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onClose()}
            className="-ml-1 gap-1 text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            {t("backToList")}
          </Button>
        )}
        <div className="min-w-0 flex-1">
          {editingTitle && permissions.canEditAll
            ? (
                <input
                  className="w-full bg-transparent text-base font-semibold tracking-tight outline-none border-b-2 border-primary"
                  value={titleDraft}
                  autoFocus
                  onChange={e => setTitleDraft(e.target.value)}
                  onBlur={saveTitle}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      saveTitle();
                    }
                    else if (e.key === "Escape") {
                      setTitleDraft(issue.title);
                      setEditingTitle(false);
                    }
                  }}
                />
              )
            : (
                <h1
                  className={`truncate text-base font-semibold tracking-tight ${permissions.canEditAll ? "cursor-pointer hover:text-primary" : ""}`}
                  onClick={() => permissions.canEditAll && setEditingTitle(true)}
                  title={permissions.canEditAll
                    ? t("clickToEditTitle")
                    : issue.title}
                >
                  {issue.title}
                </h1>
              )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {permissions.canDelete && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setDeleteOpen(true)}
              title={t("common.delete")}
            >
              <Trash2 className="size-4 text-destructive" />
            </Button>
          )}
          {variant === "drawer" && onMaximize && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onMaximize}
              title={t("openFullPage")}
            >
              <Maximize2 className="size-4" />
            </Button>
          )}
          {variant === "drawer" && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onClose()}
              title={t("common.close")}
            >
              <X className="size-4" />
            </Button>
          )}
        </div>
      </div>

      {/* Body — scrollable */}
      <div className="flex-1 overflow-y-auto px-4 py-2 flex flex-col gap-2">
        <ErrorBanner message={error} />

        {/* Meta row */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          {/* Status */}
          {permissions.canEditStatus
            ? (
                <Select value={issue.status} onValueChange={v => v !== null && void patch({ status: v })}>
                  <SelectTrigger className="h-auto border-0 bg-transparent p-0 shadow-none gap-1 [&>svg:last-child]:size-3">
                    <Badge variant={statusVariants[issue.status]} className="cursor-pointer">
                      {t(`status${statusKey(issue.status)}`)}
                    </Badge>
                  </SelectTrigger>
                  <SelectContent>
                    {STATUSES.map(s => (
                      <SelectItem key={s} value={s}>{t(`status${statusKey(s)}`)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )
            : <Badge variant={statusVariants[issue.status]}>{t(`status${statusKey(issue.status)}`)}</Badge>}

          {/* Priority */}
          {permissions.canEditAll
            ? (
                <Select value={issue.priority} onValueChange={v => v !== null && void patch({ priority: v })}>
                  <SelectTrigger className="h-auto border-0 bg-transparent p-0 shadow-none gap-1 [&>svg:last-child]:size-3">
                    <Badge variant={priorityVariants[issue.priority]} className="cursor-pointer">
                      {t(`priority${priorityKey(issue.priority)}`)}
                    </Badge>
                  </SelectTrigger>
                  <SelectContent>
                    {PRIORITIES.map(p => (
                      <SelectItem key={p} value={p}>{t(`priority${priorityKey(p)}`)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )
            : <Badge variant={priorityVariants[issue.priority]}>{t(`priority${priorityKey(issue.priority)}`)}</Badge>}

          <span className="mx-1 text-muted-foreground/50">·</span>

          {/* Assignee */}
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <span>
              {t("field.assignee")}
              :
            </span>
            {permissions.canEditAll
              ? (
                  <Select
                    value={issue.assigneeId ?? "__none__"}
                    onValueChange={(v) => {
                      if (v === null)
                        return;
                      void patch({
                        assigneeId: v === "__none__"
                          ? null
                          : v,
                      });
                    }}
                  >
                    <SelectTrigger className="h-auto border-0 bg-transparent p-0 shadow-none gap-1 text-xs text-foreground hover:text-primary [&>svg:last-child]:size-3">
                      <SelectValue>
                        {(v: string) => {
                          if (v === "__none__")
                            return <span className="text-muted-foreground">{t("unassigned")}</span>;
                          return displayName(userMap, v);
                        }}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">{t("unassigned")}</SelectItem>
                      {users.map(u => (
                        <SelectItem key={u.id} value={u.id}>{`${u.name} (${u.username})`}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )
              : (
                  <span className="text-foreground">
                    {issue.assigneeId
                      ? displayName(userMap, issue.assigneeId)
                      : t("unassigned")}
                  </span>
                )}
          </span>

          <span className="mx-1 text-muted-foreground/50">·</span>

          {/* Due date */}
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <span>
              {t("field.dueDate")}
              :
            </span>
            {permissions.canEditAll
              ? (
                  <span className="relative inline-flex items-center">
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 text-xs text-foreground hover:text-primary"
                      onClick={() => dueDateInputRef.current?.showPicker()}
                    >
                      {issue.dueDate ?? (
                        <span className="inline-flex items-center gap-0.5 text-muted-foreground">
                          {t("notSet")}
                          <Pencil className="size-2.5" />
                        </span>
                      )}
                    </button>
                    <input
                      ref={dueDateInputRef}
                      type="date"
                      className="sr-only"
                      tabIndex={-1}
                      value={issue.dueDate ?? ""}
                      onChange={e => void patch({ dueDate: e.target.value || null })}
                    />
                  </span>
                )
              : <span className="text-foreground">{issue.dueDate ?? "—"}</span>}
          </span>

          <div className="ml-auto inline-flex items-center gap-0.5">
            {canUploadAttachment && (
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                onClick={() => fileInputRef.current?.click()}
                title={t("attachments.upload")}
              >
                <Paperclip className="size-3" />
                {upload.isPending
                  ? t("attachments.uploading")
                  : t("attachments.upload")}
              </button>
            )}
            {permissions.canEditAll && !editingDesc && (
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                onClick={() => setEditingDesc(true)}
              >
                <Pencil className="size-3" />
                {t("common.edit")}
              </button>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={e => handleUpload(e.target.files)}
          />
        </div>

        {/* Description */}
        <div>
          {editingDesc && permissions.canEditAll
            ? (
                <div key="description-edit" className="space-y-2">
                  <MarkdownEditor
                    value={descDraft}
                    onChange={setDescDraft}
                    placeholder={t("field.descriptionPlaceholder")}
                    minHeight={160}
                  />
                  <div className="flex items-center justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={cancelDesc}>
                      {t("common.cancel")}
                    </Button>
                    <Button size="sm" onClick={saveDesc}>
                      {t("common.save")}
                    </Button>
                  </div>
                </div>
              )
            : issue.description
              ? (
                  <div key="description-readonly" className="rounded-md bg-muted/40 px-2 py-1">
                    <MarkdownEditor value={issue.description} readOnly />
                  </div>
                )
              : permissions.canEditAll
                ? (
                    <button
                      type="button"
                      onClick={() => setEditingDesc(true)}
                      className="w-full rounded-md border border-dashed bg-muted/30 px-2 py-1 text-left text-sm italic text-muted-foreground leading-snug hover:bg-muted/50 hover:text-foreground transition-colors"
                    >
                      {t("field.noDescription")}
                    </button>
                  )
                : (
                    <div className="rounded-md border border-dashed bg-muted/30 px-2 py-1 text-sm italic text-muted-foreground leading-snug">
                      {t("field.noDescription")}
                    </div>
                  )}
        </div>

        {/* Creator + timestamps — subtle footer-style strip above the
            attachments section, right-aligned and toned down so it
            reads as auxiliary info rather than primary content. */}
        <div className="mt-4 flex flex-wrap items-center justify-end gap-x-2 gap-y-1 text-[11px] text-muted-foreground/80">
          <span className="inline-flex items-center gap-1">
            <span className="text-muted-foreground/60">{t("col.creator")}</span>
            <span className="text-foreground/70">{creatorName}</span>
          </span>
          <span className="text-muted-foreground/40">·</span>
          <span className="inline-flex items-center gap-1">
            <span className="text-muted-foreground/60">{t("col.createdAt")}</span>
            <span className="text-foreground/70">{formatDateTime(issue.createdAt)}</span>
          </span>
          <span className="text-muted-foreground/40">·</span>
          <span className="inline-flex items-center gap-1">
            <span className="text-muted-foreground/60">{t("updatedAt")}</span>
            <span className="text-foreground/70">{formatDateTime(issue.updatedAt)}</span>
          </span>
        </div>

        <ResourceFooterSections
          resource="issues"
          resourceId={issue.id}
          i18nNs="issues"
          userMap={userMap}
          commentsEnableReply
          sectionSpacingClassName="mt-4"
          canDeleteAttachment={att => !!isAdmin || issue.creatorId === user?.id || att.uploadedBy === user?.id}
          canDeleteComment={c => !!isAdmin || c.authorId === user?.id}
        />
      </div>

      <ConfirmDeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t("deleteTitle")}
        description={t("deleteConfirm", { title: issue.title })}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}
