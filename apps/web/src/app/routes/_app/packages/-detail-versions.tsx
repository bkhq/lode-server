import type { Asset, Channel, Version } from "@/shared/lib/registry/types";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { CopyButton } from "@/shared/components/copy-button";
import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import { ConfirmDeleteDialog } from "@/shared/components/ui/confirm-delete-dialog";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/components/ui/dialog";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/components/ui/table";
import { Textarea } from "@/shared/components/ui/textarea";
import { formatDateTime } from "@/shared/lib/format";
import {
  createVersion,
  deleteVersion,
  publishVersion,
  restoreVersion,
  yankVersion,
} from "@/shared/lib/registry/api";
import { registryErrorMessage } from "@/shared/lib/registry/errors";
import { formatBytes } from "@/shared/lib/registry/format";
import { useInvalidatePackages } from "./-detail-shared";
import {
  channelNameError,
  channelsOf,
  MAX_ID_LENGTH,
  MAX_NOTES_LENGTH,
  shortHash,
  totalSize,
  versionError,
} from "./-detail-validate";

interface VersionsTabProps {
  readonly ns: string;
  readonly pkg: string;
  readonly canWrite: boolean;
  readonly versions: readonly Version[];
  readonly channels: readonly Channel[];
}

type ActionKind = "publish" | "yank" | "restore" | "delete";

interface Action {
  readonly kind: ActionKind;
  readonly version: string;
}

const DEFAULT_CHANNEL = "stable";
const COLUMNS = 8;

const STATUS_VARIANT = {
  draft: "outline",
  published: "default",
  yanked: "destructive",
} as const;

export function VersionsTab({ ns, pkg, canWrite, versions, channels }: VersionsTabProps) {
  const { t } = useTranslation(["package", "common", "regerrors"]);
  const invalidate = useInvalidatePackages();
  const [expanded, setExpanded] = useState<readonly string[]>([]);
  const [action, setAction] = useState<Action | null>(null);
  const [channel, setChannel] = useState(DEFAULT_CHANNEL);
  const [createOpen, setCreateOpen] = useState(false);

  const statusLabel = {
    draft: t("package:status.draft"),
    published: t("package:status.published"),
    yanked: t("package:status.yanked"),
  };
  const idErrorLabel = {
    empty: t("package:validation.empty"),
    leading: t("package:validation.leading"),
    charset: t("package:validation.charset"),
    tooLong: t("package:validation.tooLong", { max: MAX_ID_LENGTH }),
  };
  const dialogText = {
    publish: {
      title: "package:versions.publishDialog.title",
      description: t("package:versions.publishDialog.description"),
    },
    yank: {
      title: "package:versions.yankDialog.title",
      description: t("package:versions.yankDialog.description"),
    },
    restore: {
      title: "package:versions.restoreDialog.title",
      description: t("package:versions.restoreDialog.description"),
    },
    delete: {
      title: "package:versions.deleteDialog.title",
      description: t("package:versions.deleteDialog.description"),
    },
  };
  const successKey = {
    publish: "package:versions.publishDialog.success",
    yank: "package:versions.yankDialog.success",
    restore: "package:versions.restoreDialog.success",
    delete: "package:versions.deleteDialog.success",
  };
  const actionLabel = {
    publish: t("package:versions.publish"),
    yank: t("package:versions.yank"),
    restore: t("package:versions.restore"),
    delete: t("common:common.delete"),
  };

  const mutation = useMutation({
    mutationFn: (a: Action): Promise<unknown> => {
      switch (a.kind) {
        case "publish": return publishVersion(ns, pkg, a.version, channel);
        case "yank": return yankVersion(ns, pkg, a.version);
        case "restore": return restoreVersion(ns, pkg, a.version);
        case "delete": return deleteVersion(ns, pkg, a.version);
      }
    },
    onSuccess: async (_, a) => {
      toast.success(t(successKey[a.kind], { version: a.version }));
      setAction(null);
      await invalidate();
    },
    onError: err => toast.error(registryErrorMessage(err, t, t("common:common.error.operationFailed"))),
  });

  const open = (kind: ActionKind, version: string) => {
    setChannel(DEFAULT_CHANNEL);
    setAction({ kind, version });
  };
  const close = (isOpen: boolean) => {
    if (!isOpen)
      setAction(null);
  };
  const toggle = (id: string) =>
    setExpanded(ids => (ids.includes(id)
      ? ids.filter(i => i !== id)
      : [...ids, id]));

  const channelError = action?.kind === "publish"
    ? channelNameError(channel)
    : undefined;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t("package:versions.uploadNotice")}
          {" "}
          <Link to="/tokens" className="text-primary underline-offset-4 hover:underline">
            {t("package:versions.tokensLink")}
          </Link>
        </p>
        {canWrite && (
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus />
            {t("package:versions.new")}
          </Button>
        )}
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>{t("package:versions.col.version")}</TableHead>
              <TableHead>{t("package:versions.col.status")}</TableHead>
              <TableHead>{t("package:versions.col.published")}</TableHead>
              <TableHead>{t("package:versions.col.assets")}</TableHead>
              <TableHead>{t("package:versions.col.size")}</TableHead>
              <TableHead>{t("package:versions.col.channels")}</TableHead>
              <TableHead>{canWrite && t("package:versions.col.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {versions.length === 0 && (
              <TableRow>
                <TableCell colSpan={COLUMNS} className="h-24 text-center text-muted-foreground">
                  {t("package:versions.empty")}
                </TableCell>
              </TableRow>
            )}
            {versions.map((v) => {
              const isOpen = expanded.includes(v.id);
              return (
                <Fragment key={v.id}>
                  <TableRow>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-expanded={isOpen}
                        aria-label={isOpen
                          ? t("package:versions.collapse")
                          : t("package:versions.expand")}
                        onClick={() => toggle(v.id)}
                      >
                        {isOpen
                          ? <ChevronDown />
                          : <ChevronRight />}
                      </Button>
                    </TableCell>
                    <TableCell className="font-mono font-medium">{v.version}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[v.status]}>{statusLabel[v.status]}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {v.published_at
                        ? formatDateTime(v.published_at)
                        : "-"}
                    </TableCell>
                    <TableCell>{v.assets.length}</TableCell>
                    <TableCell>{formatBytes(totalSize(v.assets))}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {channelsOf(v.version, channels).map(name => (
                          <Badge key={name} variant="secondary">{name}</Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>
                      {canWrite && (
                        <div className="flex items-center gap-1">
                          {v.status === "draft" && (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={v.assets.length === 0}
                              onClick={() => open("publish", v.version)}
                            >
                              {actionLabel.publish}
                            </Button>
                          )}
                          {v.status === "published" && (
                            <Button variant="ghost" size="sm" onClick={() => open("yank", v.version)}>
                              {actionLabel.yank}
                            </Button>
                          )}
                          {v.status === "yanked" && (
                            <Button variant="ghost" size="sm" onClick={() => open("restore", v.version)}>
                              {actionLabel.restore}
                            </Button>
                          )}
                          <Button variant="ghost" size="sm" onClick={() => open("delete", v.version)}>
                            {actionLabel.delete}
                          </Button>
                          {v.status === "draft" && v.assets.length === 0 && (
                            <span className="text-xs text-muted-foreground">
                              {t("package:versions.publishNeedsAssets")}
                            </span>
                          )}
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                  {isOpen && (
                    <TableRow className="bg-muted/30 hover:bg-muted/30">
                      <TableCell />
                      <TableCell colSpan={COLUMNS - 1} className="space-y-3 whitespace-normal">
                        {v.notes && (
                          <div>
                            <div className="text-xs font-medium text-muted-foreground">{t("package:versions.notes")}</div>
                            <p className="mt-1 whitespace-pre-wrap text-sm">{v.notes}</p>
                          </div>
                        )}
                        {v.assets.length === 0
                          ? <p className="text-sm text-muted-foreground">{t("package:versions.noAssets")}</p>
                          : <AssetTable assets={v.assets} />}
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <CreateDraftDialog ns={ns} pkg={pkg} open={createOpen} onOpenChange={setCreateOpen} />

      <ConfirmDeleteDialog
        open={action?.kind === "delete"}
        onOpenChange={close}
        title={t(dialogText.delete.title, { version: action?.version })}
        description={dialogText.delete.description}
        pending={mutation.isPending}
        onConfirm={() => action && mutation.mutate(action)}
      />

      <Dialog open={action !== null && action.kind !== "delete"} onOpenChange={close}>
        {action && action.kind !== "delete" && (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t(dialogText[action.kind].title, { version: action.version })}</DialogTitle>
              <DialogDescription>{dialogText[action.kind].description}</DialogDescription>
            </DialogHeader>
            {action.kind === "publish" && (
              <div className="space-y-2">
                <Label htmlFor="publish-channel">{t("package:versions.publishDialog.channel")}</Label>
                <Input
                  id="publish-channel"
                  className="font-mono"
                  value={channel}
                  aria-invalid={channelError !== undefined}
                  onChange={e => setChannel(e.target.value)}
                />
                {channelError && <p className="text-xs text-destructive">{idErrorLabel[channelError]}</p>}
              </div>
            )}
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline">{t("common:common.cancel")}</Button>} />
              <Button
                variant={action.kind === "yank"
                  ? "destructive"
                  : "default"}
                disabled={mutation.isPending || channelError !== undefined}
                onClick={() => mutation.mutate(action)}
              >
                {actionLabel[action.kind]}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}

function AssetTable({ assets }: { readonly assets: readonly Asset[] }) {
  const { t } = useTranslation(["package", "common"]);
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("package:versions.asset.name")}</TableHead>
          <TableHead>{t("package:versions.asset.size")}</TableHead>
          <TableHead>{t("package:versions.asset.sha256")}</TableHead>
          <TableHead>{t("package:versions.asset.signature")}</TableHead>
          <TableHead>{t("package:versions.asset.launch")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {assets.map(a => (
          <TableRow key={a.name}>
            <TableCell className="font-mono">{a.name}</TableCell>
            <TableCell>{formatBytes(a.size)}</TableCell>
            <TableCell>
              <div className="flex items-center gap-1">
                <span className="font-mono text-xs" title={a.sha256}>{shortHash(a.sha256)}</span>
                <CopyButton value={a.sha256} label={t("package:versions.asset.copySha256")} />
              </div>
            </TableCell>
            <TableCell>
              {a.key_id === null
                ? <Badge variant="outline">{t("package:versions.asset.unsigned")}</Badge>
                : (
                    <div className="flex items-center gap-1.5">
                      <Badge variant="secondary">{t("package:versions.asset.signed")}</Badge>
                      <span className="font-mono text-xs text-muted-foreground">{a.key_id}</span>
                    </div>
                  )}
            </TableCell>
            <TableCell className="font-mono text-xs whitespace-normal">
              {a.run !== null && <div>{`run = ${a.run}`}</div>}
              {a.exec !== null && <div>{`exec = ${a.exec}`}</div>}
              {a.run === null && a.exec === null && "-"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function CreateDraftDialog({ ns, pkg, open, onOpenChange }: {
  readonly ns: string;
  readonly pkg: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["package", "common", "regerrors"]);
  const invalidate = useInvalidatePackages();
  const [version, setVersion] = useState("");
  const [notes, setNotes] = useState("");

  const idErrorLabel = {
    empty: t("package:validation.empty"),
    leading: t("package:validation.leading"),
    charset: t("package:validation.charset"),
    tooLong: t("package:validation.tooLong", { max: MAX_ID_LENGTH }),
  };
  const error = versionError(version);

  const mutation = useMutation({
    mutationFn: () => createVersion(ns, pkg, {
      version,
      ...(notes.trim()
        ? { notes }
        : {}),
    }),
    onSuccess: async (created) => {
      toast.success(t("package:versions.create.success", { version: created.version }));
      setVersion("");
      setNotes("");
      onOpenChange(false);
      await invalidate();
    },
    onError: err => toast.error(registryErrorMessage(err, t, t("common:common.error.operationFailed"))),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            if (!error)
              mutation.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("package:versions.create.title")}</DialogTitle>
            <DialogDescription>{t("package:versions.create.description")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="draft-version">{t("package:versions.create.version")}</Label>
            <Input
              id="draft-version"
              className="font-mono"
              value={version}
              placeholder={t("package:versions.create.versionPlaceholder")}
              aria-invalid={version !== "" && error !== undefined}
              onChange={e => setVersion(e.target.value)}
            />
            {version !== "" && error && <p className="text-xs text-destructive">{idErrorLabel[error]}</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="draft-notes">{t("package:versions.create.notes")}</Label>
            <Textarea
              id="draft-notes"
              value={notes}
              maxLength={MAX_NOTES_LENGTH}
              onChange={e => setNotes(e.target.value)}
            />
          </div>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline">{t("common:common.cancel")}</Button>} />
            <Button type="submit" disabled={mutation.isPending || error !== undefined}>
              {t("package:versions.create.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
