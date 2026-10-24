/* eslint-disable react-refresh/only-export-components */
import type { AdminNamespace, Grants, RegistryToken } from "@/shared/lib/registry/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createLazyFileRoute, Link } from "@tanstack/react-router";
import { X } from "lucide-react";
import { useMemo, useState } from "react";
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
import { adminRevokeToken } from "@/shared/lib/registry/api";
import { registryErrorMessage } from "@/shared/lib/registry/errors";
import { describeGrants } from "@/shared/lib/registry/grants";
import { adminNamespacesQuery, adminTokensQuery, registryKeys } from "@/shared/lib/registry/queries";
import { filterRows } from "./-filter";
import { ListFilter, MessageRow } from "./-list-parts";
import { OwnerCell } from "./-owner-cell";
import { ownerLabel } from "./-owner-label";
import { useTokenUserFilter } from "./-token-filter";

export const Route = createLazyFileRoute("/_app/admin/registry/tokens")({
  component: RegistryTokensTab,
});

const COLUMNS = 8;

// The layout in ../registry.tsx renders the page heading and the tab bar.
function RegistryTokensTab() {
  const { t } = useTranslation(["common", "registry", "regerrors"]);
  const queryClient = useQueryClient();
  const userId = useTokenUserFilter();
  const { data, isPending, error } = useQuery(adminTokensQuery(userId));
  // A token carries only its owner's user id; the namespace list knows who that is.
  const { data: namespaces } = useQuery(adminNamespacesQuery());
  const [filter, setFilter] = useState("");
  const [revokeTarget, setRevokeTarget] = useState<RegistryToken | null>(null);

  const owners = useMemo(
    () => new Map<string, AdminNamespace>((namespaces ?? []).map(ns => [ns.owner.id, ns])),
    [namespaces],
  );

  const rows = useMemo(() => {
    const sorted = [
      ...(data ?? []),
    ].sort((a, b) => b.created_at.localeCompare(a.created_at));
    return filterRows(sorted, filter, (token) => {
      const ns = owners.get(token.user_id);
      return [
        ns?.owner.name,
        ns?.owner.username,
        ns?.slug,
        token.user_id,
        token.name,
        token.prefix,
      ];
    });
  }, [data, filter, owners]);

  const describeOwner = (id: string) => {
    const ns = owners.get(id);
    return ns
      ? ownerLabel(ns.owner)
      : id;
  };

  const revokeMutation = useMutation({
    mutationFn: (token: RegistryToken) => adminRevokeToken(token.id),
    onSuccess: (_, token) => {
      toast.success(t("registry:tokens.revoked", { name: token.name }));
      setRevokeTarget(null);
      return queryClient.invalidateQueries({
        queryKey: registryKeys.adminTokens(),
      });
    },
    onError: (err) => {
      toast.error(registryErrorMessage(err, t, t("common.error.operationFailed")));
    },
  });

  // Read once: expiry badges need not tick while the tab is open.
  const [now] = useState(() => Date.now());

  return (
    <div className="space-y-4">
      <ErrorBanner message={error
        ? registryErrorMessage(error, t, t("common.error.loadFailed"))
        : null}
      />

      <ListFilter value={filter} onChange={setFilter} shown={rows.length} total={data?.length ?? 0}>
        {userId && (
          <Badge variant="outline" className="h-7 gap-1 pr-1">
            {t("registry:tokens.onlyOwner", {
              owner: describeOwner(userId),
            })}
            <Button
              variant="ghost"
              size="icon-xs"
              title={t("registry:tokens.showAll")}
              nativeButton={false}
              render={<Link to="/admin/registry/tokens" />}
            >
              <X />
            </Button>
          </Badge>
        )}
      </ListFilter>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("registry:col.owner")}</TableHead>
              <TableHead>{t("registry:col.token")}</TableHead>
              <TableHead>{t("registry:col.prefix")}</TableHead>
              <TableHead>{t("registry:col.grants")}</TableHead>
              <TableHead>{t("registry:col.expires")}</TableHead>
              <TableHead>{t("registry:col.lastUsed")}</TableHead>
              <TableHead>{t("registry:col.created")}</TableHead>
              <TableHead>{t("registry:col.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody aria-busy={isPending}>
            {!data
              ? !error && <MessageRow colSpan={COLUMNS}>{t("common.loading")}</MessageRow>
              : rows.length === 0
                ? (
                    <MessageRow colSpan={COLUMNS}>
                      {data.length === 0
                        ? t("registry:tokens.empty")
                        : t("registry:filter.noMatch")}
                    </MessageRow>
                  )
                : rows.map((token) => {
                    const ns = owners.get(token.user_id);
                    const expired = token.expires_at !== null && new Date(token.expires_at).getTime() <= now;
                    return (
                      <TableRow key={token.id}>
                        <TableCell>
                          {ns
                            ? (
                                <div className="flex flex-col">
                                  <OwnerCell owner={ns.owner} />
                                  <code className="font-mono text-xs text-muted-foreground">{ns.slug}</code>
                                </div>
                              )
                            : <code className="font-mono text-xs">{token.user_id}</code>}
                        </TableCell>
                        <TableCell className="font-medium">{token.name}</TableCell>
                        <TableCell><code className="font-mono text-xs">{token.prefix}</code></TableCell>
                        <TableCell><GrantsCell grants={token.grants} /></TableCell>
                        <TableCell className="text-muted-foreground">
                          {token.expires_at === null
                            ? t("registry:tokens.noExpiry")
                            : (
                                <div className="flex items-center gap-1.5">
                                  {formatDate(token.expires_at)}
                                  {expired && <Badge variant="destructive">{t("registry:tokens.expired")}</Badge>}
                                </div>
                              )}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {token.last_used_at
                            ? formatDateTime(token.last_used_at)
                            : t("registry:tokens.neverUsed")}
                        </TableCell>
                        <TableCell className="text-muted-foreground">{formatDate(token.created_at)}</TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            onClick={() => setRevokeTarget(token)}
                          >
                            {t("registry:tokens.revoke")}
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
          </TableBody>
        </Table>
      </div>

      <ConfirmDeleteDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open)
            setRevokeTarget(null);
        }}
        title={t("registry:tokens.revokeTitle")}
        description={revokeTarget && t("registry:tokens.revokeDescription", {
          name: revokeTarget.name,
          owner: describeOwner(revokeTarget.user_id),
        })}
        confirmLabel={t("registry:tokens.revoke")}
        pending={revokeMutation.isPending}
        onConfirm={() => {
          if (revokeTarget)
            revokeMutation.mutate(revokeTarget);
        }}
      />
    </div>
  );
}

function GrantsCell({ grants }: { readonly grants: Grants }) {
  const { t } = useTranslation(["common", "registry"]);
  const levels = {
    read: t("registry:level.read"),
    write: t("registry:level.write"),
    admin: t("registry:level.admin"),
  };
  const summary = describeGrants(grants);

  if (summary.kind === "none")
    return <span className="text-muted-foreground">{t("registry:tokens.grantsNone")}</span>;
  if (summary.kind === "all")
    return <Badge variant="secondary">{t("registry:tokens.grantsAll", { level: levels[summary.access] })}</Badge>;
  return (
    <div className="flex max-w-xs flex-wrap gap-1">
      {summary.items.map(grant => (
        <Badge key={grant.package} variant="outline" className="font-mono">
          {grant.package}
          <span className="font-sans text-muted-foreground">{levels[grant.access]}</span>
        </Badge>
      ))}
    </div>
  );
}
