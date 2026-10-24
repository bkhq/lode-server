/* eslint-disable react-refresh/only-export-components */
import type { AdminNamespace, Owner } from "@/shared/lib/registry/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createLazyFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { CopyButton } from "@/shared/components/copy-button";
import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import { ErrorBanner } from "@/shared/components/ui/error-banner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/components/ui/table";
import { formatDate } from "@/shared/lib/format";
import { adminRestoreNamespace, adminSuspendNamespace } from "@/shared/lib/registry/api";
import { registryErrorMessage } from "@/shared/lib/registry/errors";
import { formatBytes } from "@/shared/lib/registry/format";
import { adminNamespacesQuery, registryKeys } from "@/shared/lib/registry/queries";
import { ConfirmDialog } from "./-confirm-dialog";
import { filterRows } from "./-filter";
import { ListFilter, MessageRow } from "./-list-parts";
import { OwnerCell } from "./-owner-cell";
import { ownerLabel } from "./-owner-label";
import { QuotaDialog } from "./-quota-dialog";
import { tokenUserSearch } from "./-token-filter";
import { UserPickerDialog } from "./-user-picker-dialog";

export const Route = createLazyFileRoute("/_app/admin/registry/")({
  component: RegistryNamespacesTab,
});

const COLUMNS = 7;

// The layout in ../registry.tsx renders the page heading and the tab bar.
function RegistryNamespacesTab() {
  const { t } = useTranslation(["common", "registry", "regerrors"]);
  const queryClient = useQueryClient();
  const { data, isPending, error } = useQuery(adminNamespacesQuery());
  const [filter, setFilter] = useState("");
  const [statusTarget, setStatusTarget] = useState<AdminNamespace | null>(null);
  const [quotaUser, setQuotaUser] = useState<Owner | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const rows = useMemo(() => {
    const sorted = [
      ...(data ?? []),
    ].sort((a, b) => b.created_at.localeCompare(a.created_at));
    return filterRows(sorted, filter, n => [n.owner.name, n.owner.username, n.slug]);
  }, [data, filter]);

  const statusMutation = useMutation({
    mutationFn: (ns: AdminNamespace) =>
      ns.status === "active"
        ? adminSuspendNamespace(ns.slug)
        : adminRestoreNamespace(ns.slug),
    onSuccess: (updated) => {
      toast.success(updated.status === "suspended"
        ? t("registry:namespaces.suspended", { namespace: updated.slug })
        : t("registry:namespaces.restored", { namespace: updated.slug }));
      setStatusTarget(null);
      return queryClient.invalidateQueries({
        queryKey: registryKeys.adminNamespaces(),
      });
    },
    onError: (err) => {
      toast.error(registryErrorMessage(err, t, t("common.error.operationFailed")));
    },
  });

  const suspending = statusTarget?.status === "active";

  return (
    <div className="space-y-4">
      <ErrorBanner message={error
        ? registryErrorMessage(error, t, t("common.error.loadFailed"))
        : null}
      />

      <ListFilter value={filter} onChange={setFilter} shown={rows.length} total={data?.length ?? 0}>
        <Button variant="outline" size="sm" className="ml-auto" onClick={() => setPickerOpen(true)}>
          {t("registry:namespaces.quotaOther")}
        </Button>
      </ListFilter>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("registry:col.namespace")}</TableHead>
              <TableHead>{t("registry:col.owner")}</TableHead>
              <TableHead>{t("registry:col.status")}</TableHead>
              <TableHead className="text-right">{t("registry:col.packages")}</TableHead>
              <TableHead className="text-right">{t("registry:col.storage")}</TableHead>
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
                        ? t("registry:namespaces.empty")
                        : t("registry:filter.noMatch")}
                    </MessageRow>
                  )
                : rows.map(ns => (
                    <TableRow key={ns.slug}>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <code className="font-mono text-sm">{ns.slug}</code>
                          <CopyButton value={ns.slug} label={t("registry:namespaces.copyId")} />
                        </div>
                      </TableCell>
                      <TableCell><OwnerCell owner={ns.owner} /></TableCell>
                      <TableCell>
                        <Badge variant={ns.status === "active"
                          ? "secondary"
                          : "destructive"}
                        >
                          {ns.status === "active"
                            ? t("registry:status.active")
                            : t("registry:status.suspended")}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{ns.packages}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatBytes(ns.storage_bytes)}</TableCell>
                      <TableCell className="text-muted-foreground">{formatDate(ns.created_at)}</TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button variant="ghost" size="sm" onClick={() => setStatusTarget(ns)}>
                            {ns.status === "active"
                              ? t("registry:namespaces.suspend")
                              : t("registry:namespaces.restore")}
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => setQuotaUser(ns.owner)}>
                            {t("registry:namespaces.quota")}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            nativeButton={false}
                            render={<Link to="/admin/registry/tokens" search={tokenUserSearch(ns.owner.id)} />}
                          >
                            {t("registry:tabs.tokens")}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
          </TableBody>
        </Table>
      </div>

      <ConfirmDialog
        open={statusTarget !== null}
        onOpenChange={(open) => {
          if (!open)
            setStatusTarget(null);
        }}
        title={suspending
          ? t("registry:namespaces.suspendTitle", { namespace: statusTarget?.slug })
          : t("registry:namespaces.restoreTitle", { namespace: statusTarget?.slug })}
        description={statusTarget && (suspending
          ? t("registry:namespaces.suspendDescription", {
              owner: ownerLabel(statusTarget.owner),
            })
          : t("registry:namespaces.restoreDescription", {
              owner: ownerLabel(statusTarget.owner),
            }))}
        confirmLabel={suspending
          ? t("registry:namespaces.suspend")
          : t("registry:namespaces.restore")}
        destructive={suspending}
        pending={statusMutation.isPending}
        onConfirm={() => {
          if (statusTarget)
            statusMutation.mutate(statusTarget);
        }}
      >
        {suspending && (
          <ul className="list-disc space-y-1 pl-5 text-sm">
            <li>{t("registry:namespaces.suspendEffectFeed")}</li>
            <li>{t("registry:namespaces.suspendEffectOwner")}</li>
            <li>{t("registry:namespaces.suspendEffectTokens")}</li>
          </ul>
        )}
      </ConfirmDialog>

      <UserPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onPick={(user) => {
          setPickerOpen(false);
          setQuotaUser(user);
        }}
      />

      <QuotaDialog user={quotaUser} onClose={() => setQuotaUser(null)} />
    </div>
  );
}
