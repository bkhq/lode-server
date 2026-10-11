/* eslint-disable react-refresh/only-export-components */
// Generic attachments UI for any resource exposing
// `/api/{resource}/{id}/attachments` (+ `?inline=true` for preview).
// Lists the resource's attachments as a compact grid of cards with
// inline preview (image / PDF / text) and delete confirmation. Upload
// is intentionally owned by the parent — this section is display-only.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileUp, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/shared/components/ui/button";
import { ConfirmDeleteDialog } from "@/shared/components/ui/confirm-delete-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/components/ui/dialog";
import { ErrorBanner } from "@/shared/components/ui/error-banner";
import { errorMessage } from "@/shared/lib/errors";
import { formatDate } from "@/shared/lib/format";
import { BASE_PATH, http } from "@/shared/lib/http";

export interface ResourceAttachment {
  readonly id: string;
  readonly filename: string;
  readonly mimetype: string;
  readonly size: number;
  readonly uploadedBy: string;
  readonly createdAt: string;
}

export function attachmentsQueryKey(resource: string, resourceId: string) {
  return [resource, resourceId, "attachments"] as const;
}

function isPreviewable(mimetype: string): boolean {
  return (
    mimetype.startsWith("image/")
    || mimetype === "application/pdf"
    || mimetype.startsWith("text/")
    || mimetype === "application/json"
    || mimetype === "application/xml"
  );
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024)
    return `${bytes} B`;
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface ResourceAttachmentSectionProps {
  /** Path prefix, e.g. "documents" or "issues". */
  readonly resource: string;
  readonly resourceId: string;
  readonly canDelete: (att: ResourceAttachment) => boolean;
  readonly i18nNs: string;
}

export function ResourceAttachmentSection({
  resource,
  resourceId,
  canDelete,
  i18nNs,
}: ResourceAttachmentSectionProps) {
  const { t } = useTranslation(i18nNs);
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ResourceAttachment | null>(null);
  const [previewTarget, setPreviewTarget] = useState<ResourceAttachment | null>(null);

  const attachmentsQuery = useQuery({
    queryKey: attachmentsQueryKey(resource, resourceId),
    queryFn: () => http<{ data: ResourceAttachment[] }>(`/${resource}/${resourceId}/attachments`).then(r => r.data),
  });
  const attachments = attachmentsQuery.data ?? [];

  const remove = useMutation({
    mutationFn: async (att: ResourceAttachment) => {
      await http(`/${resource}/${resourceId}/attachments/${att.id}`, { method: "DELETE" });
    },
    onSuccess: () => {
      setDeleteTarget(null);
      void qc.invalidateQueries({ queryKey: attachmentsQueryKey(resource, resourceId) });
    },
    onError: err => setError(errorMessage(err, t("common.error.deleteFailed"))),
  });

  const handleDownload = (att: ResourceAttachment) => {
    const a = document.createElement("a");
    a.href = `${BASE_PATH}/api/${resource}/${resourceId}/attachments/${att.id}`;
    a.download = att.filename;
    a.click();
  };

  // Render-nothing when no attachments — callers decide whether to show
  // a header above this section based on the same shared query.
  if (attachments.length === 0 && !attachmentsQuery.isLoading)
    return null;

  return (
    <div>
      <ErrorBanner message={error} className="mb-2" />

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {attachmentsQuery.isLoading
          ? null
          : attachments.map((att) => {
              const isImage = att.mimetype.startsWith("image/");
              const inlineUrl = `${BASE_PATH}/api/${resource}/${resourceId}/attachments/${att.id}?inline=true`;
              const canPreview = isPreviewable(att.mimetype);
              return (
                <div
                  key={att.id}
                  className="group relative flex h-12 cursor-pointer items-center gap-2 overflow-hidden rounded-md border bg-card pr-2 transition-colors hover:bg-accent/20"
                  onClick={() => (canPreview ? setPreviewTarget(att) : handleDownload(att))}
                  title={att.filename}
                >
                  {isImage
                    ? (
                        <div
                          className="size-12 shrink-0 bg-cover bg-center"
                          style={{ backgroundImage: `url(${inlineUrl})` }}
                        />
                      )
                    : (
                        <div className="flex size-12 shrink-0 items-center justify-center bg-muted/30">
                          <FileUp className="size-4 text-muted-foreground/60" strokeWidth={1.5} />
                        </div>
                      )}
                  <div className="flex min-w-0 flex-1 flex-col justify-center py-1">
                    <div className="truncate text-[12px] font-medium leading-tight">{att.filename}</div>
                    <div className="truncate text-[10px] text-muted-foreground">
                      {formatFileSize(att.size)}
                      <span className="mx-1 text-muted-foreground/50">·</span>
                      {formatDate(att.createdAt)}
                    </div>
                  </div>
                  <div className="pointer-events-none flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="size-7"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDownload(att);
                      }}
                      title={t("attachments.download")}
                    >
                      <Download className="size-3.5" />
                    </Button>
                    {canDelete(att) && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="size-7 hover:bg-destructive/10 hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteTarget(att);
                        }}
                        title={t("common.delete")}
                      >
                        <X className="size-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
      </div>

      <ConfirmDeleteDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open)
            setDeleteTarget(null);
        }}
        title={t("attachments.deleteTitle")}
        description={t("attachments.deleteConfirm", { filename: deleteTarget?.filename })}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget)}
      />

      {previewTarget && (
        <ResourceAttachmentPreviewDialog
          resource={resource}
          resourceId={resourceId}
          attachment={previewTarget}
          i18nNs={i18nNs}
          onClose={() => setPreviewTarget(null)}
          onDownload={() => handleDownload(previewTarget)}
        />
      )}
    </div>
  );
}

// ── Preview dialog ──

function ResourceAttachmentPreviewDialog({
  resource,
  resourceId,
  attachment,
  i18nNs,
  onClose,
  onDownload,
}: {
  readonly resource: string;
  readonly resourceId: string;
  readonly attachment: ResourceAttachment;
  readonly i18nNs: string;
  readonly onClose: () => void;
  readonly onDownload: () => void;
}) {
  const { t } = useTranslation(i18nNs);
  const url = `${BASE_PATH}/api/${resource}/${resourceId}/attachments/${attachment.id}?inline=true`;
  const isImage = attachment.mimetype.startsWith("image/");
  const isPdf = attachment.mimetype === "application/pdf";
  const isText
    = attachment.mimetype.startsWith("text/")
      || attachment.mimetype === "application/json"
      || attachment.mimetype === "application/xml";

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent showCloseButton={false} className="flex max-h-[90vh] w-[min(960px,92vw)] max-w-none flex-col gap-0 p-0 sm:max-w-none">
        <DialogHeader className="flex shrink-0 flex-row items-center justify-between gap-3 border-b px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-sm font-semibold">{attachment.filename}</DialogTitle>
            <DialogDescription className="text-[11px] text-muted-foreground">
              {formatFileSize(attachment.size)}
              <span className="mx-1 text-muted-foreground/50">·</span>
              {attachment.mimetype}
            </DialogDescription>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <Button variant="ghost" size="icon-sm" onClick={onDownload} title={t("attachments.download")}>
              <Download className="size-4" />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={onClose} title={t("common.close")}>
              <X className="size-4" />
            </Button>
          </div>
        </DialogHeader>
        <div className="flex-1 overflow-hidden bg-muted/10">
          {isImage && (
            <div className="flex h-full items-center justify-center p-4">
              <img
                src={url}
                alt={attachment.filename}
                className="max-h-full max-w-full object-contain"
              />
            </div>
          )}
          {isPdf && (
            <iframe
              src={url}
              title={attachment.filename}
              className="h-[80vh] w-full"
            />
          )}
          {isText && <TextPreview url={url} i18nNs={i18nNs} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TextPreview({ url, i18nNs }: { readonly url: string; readonly i18nNs: string }) {
  const { t } = useTranslation(i18nNs);
  const query = useQuery({
    queryKey: ["attachment-text-preview", url],
    queryFn: async () => {
      // Direct fetch (not the shared `httpRaw` helper) because the URL
      // is *also* used by `<img src>` / `<iframe src>` siblings — the
      // attachment endpoint may 302 to a presigned download URL on a
      // different origin, and a same-origin POST through `httpRaw`
      // wouldn't follow the redirect with credentials cleanly. GET +
      // no CSRF surface, so the only loss vs `httpRaw` is the global
      // `system-locked` / `unauthorized` event emission — acceptable
      // for a read-only preview that gracefully degrades to an error.
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok)
        throw new Error(`HTTP ${res.status}`);
      return await res.text();
    },
    staleTime: 60_000,
  });
  if (query.isLoading) {
    return <div className="flex h-[60vh] items-center justify-center text-sm text-muted-foreground">{t("common.loading")}</div>;
  }
  if (query.error || query.data === undefined) {
    return (
      <div className="flex h-[60vh] items-center justify-center text-sm text-destructive">
        {query.error instanceof Error ? query.error.message : t("common.error.loadFailed")}
      </div>
    );
  }
  return (
    <pre className="h-[80vh] overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs leading-relaxed">
      {query.data}
    </pre>
  );
}
