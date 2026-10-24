// Documents-only share dialog. The comment/attachment sections that
// used to live here moved to the generic shared/components/resource
// implementations; both modules (documents + issues) now consume them.

import type {
  Document,
  DocumentShare,
  SimpleGroup,
  SimpleUser,
} from "@/shared/lib/api/documents";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/shared/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/components/ui/dialog";
import { ErrorBanner } from "@/shared/components/ui/error-banner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/components/ui/select";
import { documentsKeys } from "@/shared/lib/api/documents";
import { errorMessage } from "@/shared/lib/errors";
import { http } from "@/shared/lib/http";
import { displayName } from "@/shared/lib/users";
import { cn } from "@/shared/lib/utils";

export function ShareDialog({
  doc,
  users,
  groups,
  userMap,
  onClose,
}: {
  readonly doc: Document;
  readonly users: readonly SimpleUser[];
  readonly groups: readonly SimpleGroup[];
  readonly userMap: Map<string, SimpleUser>;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation("documents");
  const qc = useQueryClient();
  const [targetType, setTargetType] = useState<"user" | "group">("user");
  const [targetId, setTargetId] = useState("");
  const [permission, setPermission] = useState<"viewer" | "editor">("viewer");
  const [error, setError] = useState<string | null>(null);

  const sharesQuery = useQuery({
    queryKey: documentsKeys.shares(doc.id),
    queryFn: () => http<{ data: DocumentShare[] }>(`/documents/${doc.id}/shares`).then(r => r.data),
  });

  const addShare = useMutation({
    mutationFn: async () => {
      await http(`/documents/${doc.id}/shares`, {
        method: "POST",
        body: JSON.stringify({ targetType, targetId, permission }),
      });
    },
    onSuccess: () => {
      setTargetId("");
      void qc.invalidateQueries({
        queryKey: documentsKeys.shares(doc.id),
      });
    },
    onError: err => setError(errorMessage(err, t("common.error.operationFailed"))),
  });

  const removeShare = useMutation({
    mutationFn: async (shareId: string) => {
      await http(`/documents/${doc.id}/shares/${shareId}`, { method: "DELETE" });
    },
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: documentsKeys.shares(doc.id),
      });
    },
    onError: err => setError(errorMessage(err, t("common.error.deleteFailed"))),
  });

  const groupMap = new Map(groups.map(g => [g.id, g]));
  const shares = sharesQuery.data ?? [];
  const targetName = (share: DocumentShare) => {
    if (share.targetType === "user")
      return displayName(userMap, share.targetId);
    return displayName(groupMap, share.targetId);
  };

  // Filter out targets that already have a *direct* (non-inherited) grant
  // on this doc. Targets that hold only an inherited grant remain
  // selectable so the user can escalate (e.g. inherited viewer → editor).
  const availableTargets = targetType === "user"
    ? users.filter(u => u.id !== doc.creatorId && !shares.some(s => s.targetType === "user" && s.targetId === u.id && s.inheritedFrom === null))
    : groups.filter(g => !shares.some(s => s.targetType === "group" && s.targetId === g.id && s.inheritedFrom === null));

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open)
          onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("shareTitle")}</DialogTitle>
          <DialogDescription>{t("shareDescription")}</DialogDescription>
        </DialogHeader>

        <ErrorBanner message={error} />

        <div className="space-y-3">
          <div className="flex gap-2">
            <Select
              value={targetType}
              onValueChange={(v) => {
                setTargetType(v as "user" | "group");
                setTargetId("");
              }}
            >
              <SelectTrigger size="sm" className="w-24">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="user">{t("targetUser")}</SelectItem>
                <SelectItem value="group">{t("targetGroup")}</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={targetId || "__none__"}
              onValueChange={v => setTargetId(!v || v === "__none__"
                ? ""
                : v)}
            >
              <SelectTrigger size="sm" className="flex-1">
                <SelectValue>
                  {(v: string) => {
                    if (v === "__none__") {
                      return targetType === "user"
                        ? t("targetUser")
                        : t("targetGroup");
                    }
                    if (targetType === "user")
                      return displayName(userMap, v);
                    return displayName(groupMap, v);
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__" disabled>--</SelectItem>
                {availableTargets.map(item => (
                  <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex gap-2">
            <Select value={permission} onValueChange={v => setPermission(v as "viewer" | "editor")}>
              <SelectTrigger size="sm" className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="viewer">{t("viewer")}</SelectItem>
                <SelectItem value="editor">{t("editor")}</SelectItem>
              </SelectContent>
            </Select>
            <Button size="sm" disabled={!targetId || addShare.isPending} onClick={() => addShare.mutate()}>
              {t("addShare")}
            </Button>
          </div>
        </div>

        <div className="space-y-2 mt-2">
          {sharesQuery.isLoading
            ? <div className="text-sm text-muted-foreground text-center py-3">{t("common.loading")}</div>
            : shares.length === 0
              ? <div className="text-sm text-muted-foreground text-center py-3">{t("noShares")}</div>
              : shares.map(share => (
                  <div
                    key={share.id}
                    className={cn(
                      "flex items-center gap-2 rounded-md border px-3 py-2",
                      share.inheritedFrom && "bg-muted/40",
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">{targetName(share)}</div>
                      <div className="text-xs text-muted-foreground">
                        {share.targetType === "user"
                          ? t("targetUser")
                          : t("targetGroup")}
                        {" · "}
                        {share.permission === "editor"
                          ? t("editor")
                          : t("viewer")}
                        {share.inheritedFrom && (
                          <>
                            {" · "}
                            <span className="italic">{t("inheritedFrom", { title: share.inheritedFrom.title })}</span>
                          </>
                        )}
                      </div>
                    </div>
                    {share.inheritedFrom
                      ? (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            disabled
                            title={t("inheritedNotRemovable")}
                            className="opacity-50 cursor-not-allowed"
                          >
                            <Lock className="size-4 text-muted-foreground" />
                          </Button>
                        )
                      : (
                          <Button variant="ghost" size="icon-sm" onClick={() => removeShare.mutate(share.id)}>
                            <X className="size-4 text-destructive" />
                          </Button>
                        )}
                  </div>
                ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("common.close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
