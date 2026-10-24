/* eslint-disable react-refresh/only-export-components */
import type { CreatedToken, Grants, RegistryToken } from "@/shared/lib/registry/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createLazyFileRoute } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
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
import { formatDate, formatDateTime } from "@/shared/lib/format";
import { revokeToken } from "@/shared/lib/registry/api";
import { registryErrorMessage } from "@/shared/lib/registry/errors";
import { describeGrants } from "@/shared/lib/registry/grants";
import { registryKeys, tokensQuery } from "@/shared/lib/registry/queries";
import { GrantLegend } from "./-grant-editor";
import { isExpired } from "./-grant-form";
import { SecretDialog } from "./-secret-dialog";
import { CreateTokenDialog, EditGrantsDialog } from "./-token-form";

export const Route = createLazyFileRoute("/_app/tokens")({
  component: TokensPage,
});

const COLUMNS = 7;
const MAX_GRANT_CHIPS = 3;

function GrantsCell({ grants }: { readonly grants: Grants }) {
  const { t } = useTranslation("grants");
  const summary = describeGrants(grants);

  if (summary.kind === "none")
    return <span className="text-muted-foreground">{t("table.noAccess")}</span>;
  if (summary.kind === "all") {
    return (
      <Badge variant="secondary">
        {t("table.all", {
          level: t(`level.${summary.access}`),
        })}
      </Badge>
    );
  }

  const hidden = summary.items.length - MAX_GRANT_CHIPS;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {summary.items.slice(0, MAX_GRANT_CHIPS).map(grant => (
        <Badge key={grant.package} variant="outline" className="font-mono text-xs">
          {t("table.package", {
            package: grant.package,
            level: t(`level.${grant.access}`),
          })}
        </Badge>
      ))}
      {hidden > 0 && <span className="text-xs text-muted-foreground">{t("table.more", { n: hidden })}</span>}
    </div>
  );
}

function TokensPage() {
  const { t } = useTranslation(["common", "grants", "regerrors"]);
  const queryClient = useQueryClient();
  const tokens = useQuery(tokensQuery());
  // Read once: expiry marks need a clock, and render must stay pure.
  const [now] = useState(() => Date.now());
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedToken | null>(null);
  const [editing, setEditing] = useState<RegistryToken | null>(null);
  const [revoking, setRevoking] = useState<RegistryToken | null>(null);

  const revoke = useMutation({
    mutationFn: (token: RegistryToken) => revokeToken(token.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: registryKeys.tokens(),
      });
      toast.success(t("grants:revoke.done"));
    },
    onError: err => toast.error(registryErrorMessage(err, t, t("common.error.deleteFailed"))),
    onSettled: () => setRevoking(null),
  });

  const hint = (text: string) => (
    <TableRow>
      <TableCell colSpan={COLUMNS} className="h-24 text-center text-muted-foreground">{text}</TableCell>
    </TableRow>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t("grants:page.title")}</h1>
          <p className="mt-1 text-muted-foreground">{t("grants:page.description")}</p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus className="mr-1 size-4" aria-hidden="true" />
          {t("grants:create.button")}
        </Button>
      </div>

      {tokens.isError && (
        <div className="flex items-center gap-3">
          <ErrorBanner className="flex-1" message={registryErrorMessage(tokens.error, t, t("common.error.loadFailed"))} />
          <Button variant="outline" size="sm" onClick={() => void tokens.refetch()}>{t("common.retry")}</Button>
        </div>
      )}

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("grants:col.name")}</TableHead>
              <TableHead>{t("grants:col.prefix")}</TableHead>
              <TableHead>{t("grants:col.grants")}</TableHead>
              <TableHead>{t("grants:col.expires")}</TableHead>
              <TableHead>{t("grants:col.lastUsed")}</TableHead>
              <TableHead>{t("grants:col.created")}</TableHead>
              <TableHead>{t("grants:col.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody aria-busy={tokens.isPending}>
            {tokens.isPending
              ? hint(t("common.loading"))
              : tokens.isError
                ? hint(t("common.error.loadFailed"))
                : tokens.data.length === 0
                  ? hint(t("grants:table.empty"))
                  : tokens.data.map(token => (
                      <TableRow key={token.id}>
                        <TableCell className="font-medium">{token.name}</TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {token.prefix}
                          …
                        </TableCell>
                        <TableCell><GrantsCell grants={token.grants} /></TableCell>
                        <TableCell>
                          {token.expires_at === null
                            ? <span className="text-muted-foreground">{t("grants:table.never")}</span>
                            : (
                                <div className="flex items-center gap-1.5">
                                  <span className="text-muted-foreground">{formatDate(token.expires_at)}</span>
                                  {isExpired(token.expires_at, now) && (
                                    <Badge variant="destructive">{t("grants:table.expired")}</Badge>
                                  )}
                                </div>
                              )}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {token.last_used_at
                            ? formatDateTime(token.last_used_at)
                            : t("grants:table.never")}
                        </TableCell>
                        <TableCell className="text-muted-foreground">{formatDate(token.created_at)}</TableCell>
                        <TableCell>
                          <div className="flex gap-1">
                            <Button variant="ghost" size="sm" onClick={() => setEditing(token)}>
                              {t("grants:edit.button")}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-destructive"
                              onClick={() => setRevoking(token)}
                            >
                              {t("grants:revoke.button")}
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
          </TableBody>
        </Table>
      </div>

      <GrantLegend />

      <CreateTokenDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(token) => {
          setCreating(false);
          setCreated(token);
        }}
      />
      <SecretDialog token={created} onClose={() => setCreated(null)} />
      <EditGrantsDialog token={editing} onClose={() => setEditing(null)} />
      <ConfirmDeleteDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open)
            setRevoking(null);
        }}
        title={t("grants:revoke.title")}
        description={t("grants:revoke.description", { name: revoking?.name })}
        confirmLabel={t("grants:revoke.confirm")}
        pending={revoke.isPending}
        onConfirm={() => {
          if (revoking)
            revoke.mutate(revoking);
        }}
      />
    </div>
  );
}
