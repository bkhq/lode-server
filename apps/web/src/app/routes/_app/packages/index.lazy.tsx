/* eslint-disable react-refresh/only-export-components */
import { useQuery } from "@tanstack/react-query";
import { createLazyFileRoute, Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import { ErrorBanner } from "@/shared/components/ui/error-banner";
import { Skeleton } from "@/shared/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/components/ui/table";
import { formatDateTime } from "@/shared/lib/format";
import { registryErrorMessage } from "@/shared/lib/registry/errors";
import { namespaceQuery, packagesQuery, quotaQuery } from "@/shared/lib/registry/queries";
import { CreatePackageDialog } from "./-list-create-dialog";
import { NamespaceCard } from "./-list-namespace-card";
import { QuotaCard } from "./-list-quota-card";

export const Route = createLazyFileRoute("/_app/packages/")({
  component: PackagesPage,
});

const COLUMNS = 4;
const SKELETON_ROWS = ["a", "b", "c"] as const;

function PackagesPage() {
  const { t } = useTranslation(["common", "packages", "regerrors"]);
  const namespace = useQuery(namespaceQuery());
  const quota = useQuery(quotaQuery());
  const packages = useQuery(packagesQuery());
  const [createOpen, setCreateOpen] = useState(false);

  // Why a package cannot be created right now; the server refuses both cases too.
  const createBlocked = namespace.data?.status === "suspended"
    ? t("packages:create.blockedSuspended")
    : quota.data && quota.data.usage.packages >= quota.data.limits.max_packages
      ? t("packages:create.blockedQuota")
      : undefined;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t("packages:page.title")}</h1>
          <p className="mt-1 text-muted-foreground">{t("packages:page.description")}</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Button
            disabled={createBlocked !== undefined}
            aria-describedby={createBlocked ? "create-package-blocked" : undefined}
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="size-4" />
            {t("packages:create.open")}
          </Button>
          {createBlocked && (
            <p id="create-package-blocked" className="max-w-xs text-right text-xs text-muted-foreground">{createBlocked}</p>
          )}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <NamespaceCard />
        <QuotaCard />
      </div>

      {packages.isError && (
        <div className="flex items-center gap-2">
          <ErrorBanner className="flex-1" message={registryErrorMessage(packages.error, t, t("common.error.loadFailed"))} />
          <Button variant="outline" size="sm" onClick={() => void packages.refetch()}>{t("common.retry")}</Button>
        </div>
      )}

      {packages.data?.length === 0
        ? (
            <div className="rounded-md border px-4 py-10 text-center">
              <p className="font-medium">{t("packages:empty.title")}</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                {t("packages:empty.body")}
                {" "}
                <Link to="/tokens" className="text-primary underline-offset-4 hover:underline">{t("packages:empty.tokensLink")}</Link>
              </p>
            </div>
          )
        : (packages.isPending || packages.data) && (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("packages:col.name")}</TableHead>
                    <TableHead>{t("packages:col.package")}</TableHead>
                    <TableHead>{t("packages:col.visibility")}</TableHead>
                    <TableHead>{t("packages:col.updated")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody aria-busy={packages.isPending}>
                  {!packages.data
                    ? SKELETON_ROWS.map(row => (
                        <TableRow key={row}>
                          <TableCell colSpan={COLUMNS}><Skeleton className="h-5 w-full" /></TableCell>
                        </TableRow>
                      ))
                    : packages.data.map(pkg => (
                        <TableRow key={pkg.id}>
                          <TableCell>
                            <Link
                              to="/packages/$ns/$pkg"
                              params={{ ns: pkg.namespace, pkg: pkg.slug }}
                              className="font-medium underline-offset-4 hover:underline"
                            >
                              {pkg.name}
                            </Link>
                          </TableCell>
                          <TableCell>
                            <Link
                              to="/packages/$ns/$pkg"
                              params={{ ns: pkg.namespace, pkg: pkg.slug }}
                              className="font-mono text-sm underline-offset-4 hover:underline"
                              tabIndex={-1}
                            >
                              {`${pkg.namespace}/${pkg.slug}`}
                            </Link>
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-wrap gap-1">
                              <Badge variant={pkg.visibility === "public" ? "secondary" : "outline"}>
                                {t(`packages:visibility.${pkg.visibility}`)}
                              </Badge>
                              {pkg.require_signature && (
                                <Badge variant="outline">{t("packages:signatureRequired")}</Badge>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="text-muted-foreground">{formatDateTime(pkg.updated_at)}</TableCell>
                        </TableRow>
                      ))}
                </TableBody>
              </Table>
            </div>
          )}

      <CreatePackageDialog open={createOpen} onOpenChange={setCreateOpen} namespace={namespace.data?.slug} />
    </div>
  );
}
