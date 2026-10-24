import type { Channel, Version } from "@/shared/lib/registry/types";
import { useMutation } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/shared/components/ui/button";
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
import { setChannel } from "@/shared/lib/registry/api";
import { registryErrorMessage } from "@/shared/lib/registry/errors";
import { useInvalidatePackages } from "./-detail-shared";
import { channelNameError, MAX_ID_LENGTH, publishedVersions } from "./-detail-validate";

interface ChannelsTabProps {
  readonly ns: string;
  readonly pkg: string;
  readonly canWrite: boolean;
  readonly versions: readonly Version[];
  readonly channels: readonly Channel[];
}

/** The dialog either moves an existing pointer (`channel` set) or adds one. */
interface Editing {
  readonly channel: string | null;
}

export function ChannelsTab({ ns, pkg, canWrite, versions, channels }: ChannelsTabProps) {
  const { t } = useTranslation(["package", "common", "regerrors"]);
  const invalidate = useInvalidatePackages();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [name, setName] = useState("");
  const [version, setVersion] = useState("");

  const published = publishedVersions(versions);
  const idErrorLabel = {
    empty: t("package:validation.empty"),
    leading: t("package:validation.leading"),
    charset: t("package:validation.charset"),
    tooLong: t("package:validation.tooLong", { max: MAX_ID_LENGTH }),
  };

  const target = editing?.channel ?? name;
  const nameError = editing?.channel === null
    ? channelNameError(name)
    : undefined;

  const mutation = useMutation({
    mutationFn: () => setChannel(ns, pkg, target, version),
    onSuccess: async (pointer) => {
      toast.success(t("package:channels.dialog.success", { channel: pointer.name, version: pointer.version }));
      setEditing(null);
      await invalidate();
    },
    onError: err => toast.error(registryErrorMessage(err, t, t("common:common.error.operationFailed"))),
  });

  const open = (channel: Channel | null) => {
    const current = published.find(v => v.version === channel?.version);
    setName("");
    setVersion((current ?? published[0])?.version ?? "");
    setEditing({ channel: channel?.name ?? null });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl space-y-1 text-sm text-muted-foreground">
          <p>{t("package:channels.intro")}</p>
          {canWrite && published.length === 0 && <p>{t("package:channels.noPublished")}</p>}
        </div>
        {canWrite && (
          <Button size="sm" disabled={published.length === 0} onClick={() => open(null)}>
            <Plus />
            {t("package:channels.add")}
          </Button>
        )}
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("package:channels.col.name")}</TableHead>
              <TableHead>{t("package:channels.col.version")}</TableHead>
              <TableHead>{t("package:channels.col.updated")}</TableHead>
              <TableHead>{canWrite && t("package:channels.col.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {channels.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                  {t("package:channels.empty")}
                </TableCell>
              </TableRow>
            )}
            {channels.map(c => (
              <TableRow key={c.name}>
                <TableCell className="font-mono font-medium">{c.name}</TableCell>
                <TableCell className="font-mono">{c.version}</TableCell>
                <TableCell className="text-muted-foreground">{formatDateTime(c.updated_at)}</TableCell>
                <TableCell>
                  {canWrite && (
                    <Button variant="ghost" size="sm" disabled={published.length === 0} onClick={() => open(c)}>
                      {t("package:channels.move")}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog
        open={editing !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen)
            setEditing(null);
        }}
      >
        {editing && (
          <DialogContent>
            <form
              className="contents"
              onSubmit={(e) => {
                e.preventDefault();
                if (!nameError && version)
                  mutation.mutate();
              }}
            >
              <DialogHeader>
                <DialogTitle>
                  {editing.channel === null
                    ? t("package:channels.dialog.addTitle")
                    : t("package:channels.dialog.moveTitle", { channel: editing.channel })}
                </DialogTitle>
                <DialogDescription>{t("package:channels.dialog.description")}</DialogDescription>
              </DialogHeader>
              {editing.channel === null && (
                <div className="space-y-2">
                  <Label htmlFor="channel-name">{t("package:channels.dialog.name")}</Label>
                  <Input
                    id="channel-name"
                    className="font-mono"
                    value={name}
                    placeholder={t("package:channels.dialog.namePlaceholder")}
                    aria-invalid={name !== "" && nameError !== undefined}
                    onChange={e => setName(e.target.value)}
                  />
                  {name !== "" && nameError && <p className="text-xs text-destructive">{idErrorLabel[nameError]}</p>}
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="channel-version">{t("package:channels.dialog.version")}</Label>
                <Select
                  value={version}
                  onValueChange={(v) => {
                    if (v !== null)
                      setVersion(v);
                  }}
                >
                  <SelectTrigger id="channel-version" className="w-full font-mono">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {published.map(v => (
                      <SelectItem key={v.id} value={v.version}>{v.version}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <DialogFooter>
                <DialogClose render={<Button type="button" variant="outline">{t("common:common.cancel")}</Button>} />
                <Button type="submit" disabled={mutation.isPending || nameError !== undefined || !version}>
                  {t("package:channels.dialog.submit")}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
