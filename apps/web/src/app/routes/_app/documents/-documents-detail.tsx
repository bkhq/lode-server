// Document detail view (view ↔ edit).
//
// Defaults to read-only "view" mode (rendered Markdown). The pencil icon
// in the top-right toggles to edit mode (form-style title/content inputs
// with Cancel/Save). Tags live in a row below the title and are
// inline-editable in both view and edit modes — last slot is always the
// add affordance.

import type { DraftState } from "./-documents-shared";
import {
  FileText,
  Paperclip,
  Pencil,
  Share2,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { MarkdownEditor } from "@/shared/components/editor";
import {
  partitionBySize,
  ResourceFooterSections,
  useResourceAttachmentUpload,
} from "@/shared/components/resource";
import { Button } from "@/shared/components/ui/button";
import { CenteredHint } from "@/shared/components/ui/centered-hint";
import { ConfirmDeleteDialog } from "@/shared/components/ui/confirm-delete-dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/components/ui/tooltip";
import {
  DocumentVersionConflictError,
  parseTags,
  useDeleteDocument,
  useDocument,
  useDocumentUsers,
  useUpdateDocument,
} from "@/shared/lib/api/documents";
import { errorMessage } from "@/shared/lib/errors";
import { displayName } from "@/shared/lib/users";
import { cn } from "@/shared/lib/utils";
import { useAuthStore } from "@/shared/stores/auth";
import { formatLongDate } from "./-documents-shared";
import { TagsRow } from "./-documents-tags";

export function DocumentDetail({
  docId,
  onDeleted,
}: {
  readonly docId: string;
  readonly onDeleted: () => void;
}) {
  const { t } = useTranslation("documents");
  const docQuery = useDocument(docId);
  const usersQuery = useDocumentUsers();
  const updateMutation = useUpdateDocument();
  const deleteMutation = useDeleteDocument();
  const user = useAuthStore(s => s.user);
  const isAdmin = user?.role === "admin";

  // Upload flow lives in the page header so the entry stays accessible
  // even when there are no attachments yet (the section below hides
  // until the first upload lands).
  const { upload: uploadMutation, fileInputRef, limits, attachmentCount } = useResourceAttachmentUpload({
    resource: "documents",
    resourceId: docId,
    onError: err => toast.error(errorMessage(err, t("common.error.operationFailed"))),
  });
  const handleUploadFiles = useCallback((files: FileList | null) => {
    if (!files || files.length === 0)
      return;
    const selected = Array.from(files);
    const remainingSlots = limits.maxAttachmentsPerResource - attachmentCount;
    if (remainingSlots <= 0 || selected.length > remainingSlots) {
      toast.error(t("attachments.limitReached"));
      return;
    }
    const { accepted, rejected } = partitionBySize(selected, limits.maxFileSize);
    if (rejected.length > 0) {
      toast.error(t("attachments.fileTooLargeNamed", {
        names: rejected.map(f => f.name).join(", "),
      }));
      if (accepted.length === 0)
        return;
    }
    uploadMutation.mutate(accepted);
  }, [
    attachmentCount,
    limits,
    t,
    uploadMutation,
  ]);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // When the in-body H1 scrolls out of view, surface a shrunken copy
  // in the header's left slot. The body div is the scroll root, so the
  // observer needs `root` set to it (not the viewport).
  const [titleInView, setTitleInView] = useState(true);
  const bodyScrollRef = useRef<HTMLDivElement>(null);
  const bodyTitleRef = useRef<HTMLHeadingElement>(null);
  // `draft` flips from null → set when the doc finishes loading; the
  // body H1 only mounts after that, so re-run this effect when the
  // draft becomes available to make sure both refs are populated.
  const hasDraft = draft != null;
  useEffect(() => {
    if (editing || !hasDraft)
      return undefined;
    const root = bodyScrollRef.current;
    const target = bodyTitleRef.current;
    if (!root || !target)
      return undefined;
    const observer = new IntersectionObserver(
      ([entry]) => setTitleInView(entry?.isIntersecting ?? true),
      { root, threshold: 0 },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [editing, hasDraft]);

  // Seed the draft once per fetched version so a remote update reseeds,
  // but only when the user has no in-flight edits.
  const seededVersionRef = useRef<number | null>(null);
  useEffect(() => {
    const data = docQuery.data;
    if (!data)
      return;
    if (seededVersionRef.current === data.version)
      return;
    seededVersionRef.current = data.version;

    setDraft({
      title: data.title,
      content: data.content ?? "",
      tags: parseTags(data.tags),
    });
  }, [docQuery.data]);

  if (docQuery.isLoading || !draft)
    return <CenteredHint>{t("common.loading")}</CenteredHint>;
  if (docQuery.error || !docQuery.data)
    return <CenteredHint>{errorMessage(docQuery.error, t("common.error.loadFailed"))}</CenteredHint>;

  const doc = docQuery.data;
  const userMap = new Map((usersQuery.data ?? []).map(u => [u.id, u]));
  const creatorName = displayName(userMap, doc.creatorId);
  const isCreator = doc.creatorId === user?.id;

  const handleSaveTags = (next: readonly string[]) => {
    setDraft(prev => prev
      ? { ...prev, tags: next }
      : prev);
    // In view mode, persist immediately. In edit mode, defer to the
    // explicit Save button (handled in handleSave below).
    if (!editing) {
      updateMutation.mutate({ id: doc.id, version: doc.version, tags: next }, {
        onError: (err) => {
          toast.error(errorMessage(err, t("common.error.operationFailed")));
        },
      });
    }
  };

  const handleCancel = () => {
    setDraft({
      title: doc.title,
      content: doc.content ?? "",
      tags: parseTags(doc.tags),
    });
    setEditing(false);
  };

  const handleSave = () => {
    if (!draft.title.trim()) {
      toast.error(t("field.titleRequired"));
      return;
    }
    updateMutation.mutate(
      {
        id: doc.id,
        version: doc.version,
        title: draft.title.trim(),
        content: draft.content,
        tags: draft.tags,
      },
      {
        onSuccess: () => setEditing(false),
        onError: (err) => {
          // Version conflict is special: the document changed in another
          // session. Keep edit mode open and the draft untouched so the
          // user can copy their work — never clobber it with a generic
          // failure path or a cache reseed.
          if (err instanceof DocumentVersionConflictError) {
            toast.error(t("conflict.body"), { duration: 10000 });
            return;
          }
          toast.error(errorMessage(err, t("common.error.operationFailed")));
        },
      },
    );
  };

  const handleShare = () => {
    toast(t("shareComingSoon"));
  };

  const handleDelete = () => {
    deleteMutation.mutate(doc.id, {
      onSuccess: () => {
        setDeleteOpen(false);
        onDeleted();
      },
      onError: (err) => {
        toast.error(errorMessage(err, t("common.error.deleteFailed")));
      },
    });
  };

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* Header zone — fixed 45px to align its bottom border with the
          sidebar header on the left. Holds only the title and the
          variant-specific action cluster; meta + tags moved to the
          content footer at the bottom of the body. */}
      <div
        className={cn(
          "flex h-[45px] shrink-0 items-center gap-3 px-6 transition-shadow duration-200",
          editing && "border-b border-border",
          // Drop shadow only when the body H1 has scrolled out of view —
          // gives the sticky h2 a clear separation from the scrolled
          // content underneath. Custom (instead of `shadow-md`) so the
          // gradient sits squarely below the header rather than fading
          // toward the sides, which kept it reading as a flat line.
          !editing && !titleInView && "shadow-[0_6px_12px_-4px_rgba(0,0,0,0.12)]",
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {editing
            ? (
                <>
                  <FileText className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                  <input
                    value={draft.title}
                    onChange={e => setDraft(prev => prev
                      ? { ...prev, title: e.target.value }
                      : prev)}
                    placeholder={t("untitledPlaceholder")}
                    className="min-w-0 flex-1 border-0 bg-transparent px-0 text-lg font-semibold tracking-tight outline-none placeholder:text-muted-foreground/40"
                    aria-label="Document title"
                  />
                </>
              )
            : (
                <h2
                  aria-hidden={titleInView}
                  className={cn(
                    "flex min-w-0 items-center gap-2 text-xl font-semibold tracking-tight text-foreground/70 transition-opacity duration-200",
                    titleInView ? "opacity-0" : "opacity-100",
                  )}
                >
                  <FileText className="size-5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                  <span className="min-w-0 truncate">
                    {doc.title || t("untitledPlaceholder")}
                  </span>
                </h2>
              )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {editing
            ? (
                <>
                  <Button variant="outline" size="sm" onClick={handleCancel} disabled={updateMutation.isPending}>
                    {t("common.cancel")}
                  </Button>
                  <Button size="sm" onClick={handleSave} disabled={updateMutation.isPending}>
                    {t("common.save")}
                  </Button>
                </>
              )
            : (
                <>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={e => handleUploadFiles(e.target.files)}
                  />
                  <Tooltip>
                    <TooltipTrigger
                      render={(
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => fileInputRef.current?.click()}
                          disabled={uploadMutation.isPending}
                        />
                      )}
                    >
                      <Paperclip className="size-4" />
                    </TooltipTrigger>
                    <TooltipContent>{t("attachments.upload")}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger
                      render={(
                        <Button variant="ghost" size="icon-sm" onClick={handleShare} />
                      )}
                    >
                      <Share2 className="size-4" />
                    </TooltipTrigger>
                    <TooltipContent>{t("share")}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger
                      render={(
                        <Button variant="ghost" size="icon-sm" onClick={() => setEditing(true)} />
                      )}
                    >
                      <Pencil className="size-4" />
                    </TooltipTrigger>
                    <TooltipContent>{t("common.edit")}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger
                      render={(
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => setDeleteOpen(true)}
                        />
                      )}
                    >
                      <Trash2 className="size-4 text-destructive" />
                    </TooltipTrigger>
                    <TooltipContent>{t("common.delete")}</TooltipContent>
                  </Tooltip>
                </>
              )}
        </div>
      </div>

      {/* Body — diverges by mode. Edit mode is an immersive writing
          surface (floating toolbar above the editor shell); view mode
          keeps the scrollable layout that contains H1 + byline +
          content + tags + attachments + comments. */}
      {editing
        ? (
            <MarkdownEditor
              value={draft.content}
              onChange={next => setDraft(prev => prev
                ? { ...prev, content: next }
                : prev)}
              placeholder={t("field.contentPlaceholder")}
              floatingToolbar
              className="mx-auto min-h-0 w-full max-w-[1100px] flex-1 rounded-none border-0 px-6 pt-2 pb-5"
            />
          )
        : (
            <div ref={bodyScrollRef} className="md-scroll-fade min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
              <div className="mx-auto w-full max-w-[1100px] px-6 py-5">
                {/* Document-level title — distinct from prose H1s by the
                  leading icon affordance that the in-content H1s never
                  carry. */}
                <h1
                  ref={bodyTitleRef}
                  className="mb-2 flex items-center justify-center gap-2 text-xl font-semibold tracking-tight text-foreground/70"
                >
                  <FileText className="size-5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                  <span className="min-w-0 truncate">
                    {doc.title || t("untitledPlaceholder")}
                  </span>
                </h1>
                {/* Byline — centered under the title, answers "who & when"
                  before the body. Tags live after the body (below). */}
                <p className="mb-6 text-center text-[11px] text-muted-foreground">
                  {creatorName}
                  <span className="mx-1 text-muted-foreground/50">·</span>
                  {formatLongDate(doc.updatedAt)}
                </p>
                {doc.content
                  ? <MarkdownEditor value={doc.content} readOnly />
                  : <p className="text-sm italic text-muted-foreground/70">{t("field.noContent")}</p>}

                {/* Tags — sits after the body, before attachments. */}
                <div className="mt-4">
                  <TagsRow tags={draft.tags} onChange={handleSaveTags} />
                </div>

                {/* Attachment upload entry lives in the page header
                  (Paperclip icon) so it stays reachable before the first
                  upload — the attachments section below hides until then. */}
                <ResourceFooterSections
                  resource="documents"
                  resourceId={doc.id}
                  i18nNs="documents"
                  userMap={userMap}
                  commentsLocked={doc.commentsLocked}
                  commentsEnableReply
                  commentsHeaderAction={(isAdmin || isCreator) && (
                    <button
                      type="button"
                      className="rounded px-1.5 py-0.5 text-[11px] text-primary/80 hover:bg-primary/10 hover:text-primary transition-colors"
                      onClick={() => {
                        updateMutation.mutate(
                          { id: doc.id, version: doc.version, commentsLocked: !doc.commentsLocked },
                          {
                            onError: (err) => {
                              toast.error(errorMessage(err, t("common.error.operationFailed")));
                            },
                          },
                        );
                      }}
                    >
                      {doc.commentsLocked
                        ? t("comments.unlock", { defaultValue: "Unlock comments" })
                        : t("comments.lock", { defaultValue: "Lock comments" })}
                    </button>
                  )}
                  canDeleteAttachment={att => isAdmin || isCreator || att.uploadedBy === user?.id}
                  canDeleteComment={c => isAdmin || c.authorId === user?.id}
                />
              </div>
            </div>
          )}

      <ConfirmDeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t("deleteTitle")}
        description={t("deleteConfirm", { title: doc.title })}
        pending={deleteMutation.isPending}
        onConfirm={handleDelete}
      />
    </div>
  );
}
