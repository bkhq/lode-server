/* eslint-disable react-refresh/only-export-components */
import type { AdminPackage } from "@/shared/lib/registry/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createLazyFileRoute, Link } from "@tanstack/react-router";
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
import { formatDate } from "@/shared/lib/format";
import { deletePackage, updatePackage } from "@/shared/lib/registry/api";
import { registryErrorMessage } from "@/shared/lib/registry/errors";
import { formatBytes } from "@/shared/lib/registry/format";
import { adminPackagesQuery, registryKeys } from "@/shared/lib/registry/queries";
import { ConfirmDialog } from "./-confirm-dialog";
import { filterRows } from "./-filter";
import { ListFilter, MessageRow } from "./-list-parts";
import { OwnerCell } from "./-owner-cell";
import { ownerLabel } from "./-owner-label";

export const Route = createLazyFileRoute("/_app/admin/registry/packages")({
  component: RegistryPackagesTab,
});

const COLUMNS = 6;

function fullName(pkg: AdminPackage): string {
  return `${pkg.namespace}/${pkg.slug}`;
}

// The layout in ../registry.tsx renders the page heading and the tab bar.
function RegistryPackagesTab() {
  const { t } = useTranslation(["common", "registry", "regerrors"]);
  const queryClient = useQueryClient();
  const { data, isPending, error } = useQuery(adminPackagesQuery());
  const [filter, setFilter] = useState("");
  const [privateTarget, setPrivateTarget] = useState<AdminPackage | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AdminPackage | null>(null);

  const rows = useMemo(() => {
    const sorted = [
      ...(data ?? []),
    ].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return filterRows(sorted, filter, p => [
      p.owner.name,
      p.owner.username,
      p.namespace,
      p.slug,
      p.name,
      fullName(p),
    ]);
  }, [data, filter]);

  // A package change shows in both admin lists (package count and storage of
  // the namespace) and in the ordinary package pages.
  const invalidate = () => Promise.all([
    queryClient.invalidateQueries({
      queryKey: registryKeys.adminPackages(),
    }),
    queryClient.invalidateQueries({
      queryKey: registryKeys.adminNamespaces(),
    }),
    queryClient.invalidateQueries({
      queryKey: registryKeys.packages(),
    }),
  ]);
  const onError = (err: unknown) => {
    toast.error(registryErrorMessage(err, t, t("common.error.operationFailed")));
  };

  const privateMutation = useMutation({
    mutationFn: (pkg: AdminPackage) => updatePackage(pkg.namespace, pkg.slug, { visibility: "private" }),
    onSuccess: (_, pkg) => {
      toast.success(t("registry:packages.madePrivate", {
        package: fullName(pkg),
      }));
      setPrivateTarget(null);
      return invalidate();
    },
    onError,
  });

  const deleteMutation = useMutation({
    mutationFn: (pkg: AdminPackage) => deletePackage(pkg.namespace, pkg.slug),
    onSuccess: (_, pkg) => {
      toast.success(t("registry:packages.deleted", {
        package: fullName(pkg),
      }));
      setDeleteTarget(null);
      return invalidate();
    },
    onError,
  });

  return (
    <div className="space-y-4">
      <ErrorBanner message={error
        ? registryErrorMessage(error, t, t("common.error.loadFailed"))
        : null}
      />

      <p className="text-sm text-muted-foreground">
        {t("registry:packages.hint")}
        {" "}
        <Link to="/admin/registry" className="text-primary underline-offset-4 hover:underline">
          {t("registry:packages.hintLink")}
        </Link>
      </p>

      <ListFilter value={filter} onChange={setFilter} shown={rows.length} total={data?.length ?? 0} />

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("registry:col.package")}</TableHead>
              <TableHead>{t("registry:col.owner")}</TableHead>
              <TableHead>{t("registry:col.visibility")}</TableHead>
              <TableHead className="text-right">{t("registry:col.storage")}</TableHead>
              <TableHead>{t("registry:col.updated")}</TableHead>
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
                        ? t("registry:packages.empty")
                        : t("registry:filter.noMatch")}
                    </MessageRow>
                  )
                : rows.map(pkg => (
                    <TableRow key={pkg.id}>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="font-medium">{pkg.name}</span>
                          <code className="font-mono text-xs text-muted-foreground">{fullName(pkg)}</code>
                        </div>
                      </TableCell>
                      <TableCell><OwnerCell owner={pkg.owner} /></TableCell>
                      <TableCell>
                        <Badge variant={pkg.visibility === "public"
                          ? "secondary"
                          : "outline"}
                        >
                          {pkg.visibility === "public"
                            ? t("registry:visibility.public")
                            : t("registry:visibility.private")}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatBytes(pkg.storage_bytes)}</TableCell>
                      <TableCell className="text-muted-foreground">{formatDate(pkg.updated_at)}</TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            nativeButton={false}
                            render={<Link to="/packages/$ns/$pkg" params={{ ns: pkg.namespace, pkg: pkg.slug }} />}
                          >
                            {t("registry:packages.open")}
                          </Button>
                          {pkg.visibility === "public" && (
                            <Button variant="ghost" size="sm" onClick={() => setPrivateTarget(pkg)}>
                              {t("registry:packages.makePrivate")}
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            onClick={() => setDeleteTarget(pkg)}
                          >
                            {t("common.delete")}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
          </TableBody>
        </Table>
      </div>

      <ConfirmDialog
        open={privateTarget !== null}
        onOpenChange={(open) => {
          if (!open)
            setPrivateTarget(null);
        }}
        title={t("registry:packages.makePrivateTitle")}
        description={privateTarget && t("registry:packages.makePrivateDescription", {
          package: fullName(privateTarget),
          owner: ownerLabel(privateTarget.owner),
        })}
        confirmLabel={t("registry:packages.makePrivate")}
        pending={privateMutation.isPending}
        onConfirm={() => {
          if (privateTarget)
            privateMutation.mutate(privateTarget);
        }}
      />

      <ConfirmDeleteDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open)
            setDeleteTarget(null);
        }}
        title={t("registry:packages.deleteTitle")}
        description={deleteTarget && t("registry:packages.deleteDescription", {
          package: fullName(deleteTarget),
          owner: ownerLabel(deleteTarget.owner),
        })}
        pending={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteTarget)
            deleteMutation.mutate(deleteTarget);
        }}
      />
    </div>
  );
}
