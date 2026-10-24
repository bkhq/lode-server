import type { SigningKey } from "@/shared/lib/registry/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ClipboardCopy } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { CopyButton } from "@/shared/components/copy-button";
import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import { ConfirmDeleteDialog } from "@/shared/components/ui/confirm-delete-dialog";
import { ErrorBanner } from "@/shared/components/ui/error-banner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/components/ui/table";
import { formatDateTime } from "@/shared/lib/format";
import { revokeKey } from "@/shared/lib/registry/api";
import { registryErrorMessage } from "@/shared/lib/registry/errors";
import { keysQuery, registryKeys } from "@/shared/lib/registry/queries";
import { RegisterKeyDialog } from "./-detail-key-register";

const COLUMNS = 6;
const COPIED_MS = 2000;

interface KeysTabProps {
  readonly ns: string;
  readonly pkg: string;
  /** Revoking is for the owner and administrators. */
  readonly canRevoke: boolean;
}

export function KeysTab({ ns, pkg, canRevoke }: KeysTabProps) {
  const { t } = useTranslation(["common", "keys", "regerrors"]);
  const queryClient = useQueryClient();
  const { data: keys, isPending, error, refetch } = useQuery(keysQuery(ns, pkg));
  const [registerOpen, setRegisterOpen] = useState(false);
  const [revoking, setRevoking] = useState<SigningKey | null>(null);

  const revokeMutation = useMutation({
    mutationFn: (key: SigningKey) => revokeKey(ns, pkg, key.id),
    onSuccess: (_data, key) => {
      void queryClient.invalidateQueries({
        queryKey: registryKeys.keys(ns, pkg),
      });
      toast.success(t("keys:toast.revoked", { name: key.name }));
    },
    onError: err => toast.error(registryErrorMessage(err, t, t("common:common.error.operationFailed"))),
    onSettled: () => setRevoking(null),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="text-sm text-muted-foreground">{t("keys:page.description")}</p>
        <Button onClick={() => setRegisterOpen(true)}>{t("keys:register.open")}</Button>
      </div>

      <div className="space-y-1 rounded-md border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
        <p>{t("keys:intro.optional")}</p>
        <p>{t("keys:intro.publicOnly")}</p>
        <p>{t("keys:intro.ci")}</p>
        <p>{t("keys:intro.algorithm")}</p>
      </div>

      {error && (
        <div className="flex items-center gap-3">
          <ErrorBanner className="flex-1" message={registryErrorMessage(error, t, t("common:common.error.loadFailed"))} />
          <Button variant="outline" size="sm" onClick={() => void refetch()}>{t("common:common.retry")}</Button>
        </div>
      )}

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("keys:col.name")}</TableHead>
              <TableHead>{t("keys:col.keyId")}</TableHead>
              <TableHead>{t("keys:col.algorithm")}</TableHead>
              <TableHead>{t("keys:col.created")}</TableHead>
              <TableHead>{t("keys:col.status")}</TableHead>
              <TableHead>{t("keys:col.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody aria-busy={isPending}>
            {keys === undefined || keys.length === 0
              ? (
                  <TableRow>
                    <TableCell colSpan={COLUMNS} className="h-24 text-center text-muted-foreground">
                      {isPending
                        ? t("common:common.loading")
                        : error
                          ? t("common:common.error.loadFailed")
                          : t("keys:empty")}
                    </TableCell>
                  </TableRow>
                )
              : keys.map(key => (
                  <TableRow key={key.id}>
                    <TableCell className="font-medium">{key.name}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <code className="font-mono text-xs">{key.key_id}</code>
                        <CopyButton value={key.key_id} label={t("keys:copyKeyId")} />
                      </div>
                    </TableCell>
                    <TableCell>{key.alg}</TableCell>
                    <TableCell className="text-muted-foreground">{formatDateTime(key.created_at)}</TableCell>
                    <TableCell>
                      {key.revoked_at === null
                        ? <Badge>{t("keys:status.active")}</Badge>
                        : (
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge variant="destructive">{t("keys:status.revoked")}</Badge>
                              <span className="text-xs text-muted-foreground">{formatDateTime(key.revoked_at)}</span>
                            </div>
                          )}
                    </TableCell>
                    <TableCell>
                      {key.revoked_at === null && (
                        <div className="flex gap-1">
                          <CopyTrustedKeyButton value={`${key.key_id}:${key.public_key}`} />
                          {canRevoke && (
                            <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setRevoking(key)}>
                              {t("keys:revoke.action")}
                            </Button>
                          )}
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
          </TableBody>
        </Table>
      </div>

      <RegisterKeyDialog ns={ns} pkg={pkg} open={registerOpen} onOpenChange={setRegisterOpen} />

      <ConfirmDeleteDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open)
            setRevoking(null);
        }}
        title={t("keys:revoke.title", { name: revoking?.name })}
        description={t("keys:revoke.description")}
        confirmLabel={t("keys:revoke.confirm")}
        pending={revokeMutation.isPending}
        onConfirm={() => {
          if (revoking)
            revokeMutation.mutate(revoking);
        }}
      />
    </div>
  );
}

function CopyTrustedKeyButton({ value }: { readonly value: string }) {
  const { t } = useTranslation("keys");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied)
      return;
    const timer = setTimeout(setCopied, COPIED_MS, false);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    }
    catch {
      toast.error(t("copyFailed"));
    }
  };

  return (
    <Button variant="ghost" size="sm" onClick={() => void copy()}>
      {copied
        ? <Check className="size-3.5" />
        : <ClipboardCopy className="size-3.5" />}
      {t("copyTrustedKey")}
    </Button>
  );
}
