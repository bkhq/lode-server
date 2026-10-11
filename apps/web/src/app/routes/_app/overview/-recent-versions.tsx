import type { RegistryPackage, Version } from "@/shared/lib/registry/types";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Badge } from "@/shared/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/components/ui/card";
import { Skeleton } from "@/shared/components/ui/skeleton";
import { formatDateTime } from "@/shared/lib/format";
import { packagesQuery, versionsQuery } from "@/shared/lib/registry/queries";
import { BlockError } from "./-block-error";
import { FirstRun } from "./-first-run";
import { pickRecentPackages, recentVersions } from "./-recent";

const RECENT_LIMIT = 5;

const VERSION_STATUS_KEYS = {
  draft: "portal:recent.status.draft",
  published: "portal:recent.status.published",
  yanked: "portal:recent.status.yanked",
} as const satisfies Record<Version["status"], string>;

const VERSION_STATUS_VARIANTS = {
  draft: "outline",
  published: "secondary",
  yanked: "destructive",
} as const satisfies Record<Version["status"], string>;

function RecentSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-5 w-full" />)}
    </div>
  );
}

function RecentList({ packages }: { readonly packages: readonly RegistryPackage[] }) {
  const { t } = useTranslation("portal");
  const results = useQueries({
    queries: packages.map(pkg => versionsQuery(pkg.namespace, pkg.slug)),
  });

  if (results.some(r => r.isPending))
    return <RecentSkeleton />;

  const failed = results.filter(r => r.isError);
  const retry = () => failed.forEach(r => void r.refetch());
  // Every package failed: nothing to show but the error itself.
  if (failed.length === packages.length)
    return <BlockError error={failed[0]?.error} onRetry={retry} />;

  const entries = packages.flatMap((pkg, i) => {
    const data = results[i]?.data;
    return data ? [{ package: pkg, versions: data.versions }] : [];
  });
  const recent = recentVersions(entries, RECENT_LIMIT);

  return (
    <div className="space-y-3">
      {failed.length > 0 && <BlockError error={failed[0]?.error} onRetry={retry} />}
      {recent.length === 0
        ? <p className="text-sm text-muted-foreground">{t("portal:recent.empty")}</p>
        : (
            <ul className="divide-y">
              {recent.map(({ package: pkg, version, at }) => (
                <li key={`${pkg.id}/${version.id}`}>
                  <Link
                    to="/packages/$ns/$pkg"
                    params={{ ns: pkg.namespace, pkg: pkg.slug }}
                    className="-mx-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-2 py-2 transition-colors hover:bg-muted/50"
                  >
                    <span className="min-w-0 truncate font-medium">{pkg.name}</span>
                    <span className="font-mono text-xs text-muted-foreground">{version.version}</span>
                    <Badge variant={VERSION_STATUS_VARIANTS[version.status]}>
                      {t(VERSION_STATUS_KEYS[version.status])}
                    </Badge>
                    <time dateTime={at} className="ml-auto text-xs text-muted-foreground">
                      {formatDateTime(at)}
                    </time>
                  </Link>
                </li>
              ))}
            </ul>
          )}
    </div>
  );
}

/**
 * The newest versions across the caller's packages, or the first-run steps
 * when there is no package yet.
 */
export function RecentVersions() {
  const { t } = useTranslation("portal");
  const packages = useQuery(packagesQuery());

  if (packages.data?.length === 0)
    return <FirstRun />;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("portal:recent.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        {packages.isPending && <RecentSkeleton />}
        {packages.isError && <BlockError error={packages.error} onRetry={() => void packages.refetch()} />}
        {packages.data && <RecentList packages={pickRecentPackages(packages.data, RECENT_LIMIT)} />}
      </CardContent>
    </Card>
  );
}
