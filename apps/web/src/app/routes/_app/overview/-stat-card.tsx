import type { ReactNode } from "react";
import type { Namespace } from "@/shared/lib/registry/types";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Badge } from "@/shared/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader } from "@/shared/components/ui/card";
import { Skeleton } from "@/shared/components/ui/skeleton";
import { formatBytes, usagePercent } from "@/shared/lib/registry/format";
import { namespaceQuery, quotaQuery } from "@/shared/lib/registry/queries";
import { BlockError } from "./-block-error";

const NAMESPACE_STATUS_KEYS = {
  active: "portal:stats.namespaceStatus.active",
  suspended: "portal:stats.namespaceStatus.suspended",
} as const satisfies Record<Namespace["status"], string>;

function StatCard({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription className="text-xs">{label}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">{children}</CardContent>
    </Card>
  );
}

function StatSkeleton() {
  return <Skeleton className="h-7 w-28" />;
}

function StatValue({ value, limit }: { readonly value: ReactNode; readonly limit: ReactNode }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-2xl font-semibold tabular-nums">{value}</span>
      <span className="text-sm text-muted-foreground tabular-nums">
        {"/ "}
        {limit}
      </span>
    </div>
  );
}

/** Package count, storage against quota and the caller's namespace. */
export function StatCards() {
  const { t } = useTranslation("portal");
  const quota = useQuery(quotaQuery());
  const namespace = useQuery(namespaceQuery());

  const quotaFallback = quota.isPending
    ? <StatSkeleton />
    : quota.isError
      ? <BlockError error={quota.error} onRetry={() => void quota.refetch()} />
      : null;
  const storagePercent = quota.data
    ? usagePercent(quota.data.usage.storage_bytes, quota.data.limits.max_storage_bytes)
    : 0;

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <StatCard label={t("portal:stats.packages")}>
        {quota.data
          ? <StatValue value={quota.data.usage.packages} limit={quota.data.limits.max_packages} />
          : quotaFallback}
      </StatCard>

      <StatCard label={t("portal:stats.storage")}>
        {quota.data
          ? (
              <>
                <StatValue
                  value={formatBytes(quota.data.usage.storage_bytes)}
                  limit={formatBytes(quota.data.limits.max_storage_bytes)}
                />
                <div
                  role="progressbar"
                  aria-label={t("portal:stats.storage")}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(storagePercent)}
                  className="h-1.5 overflow-hidden rounded-full bg-muted"
                >
                  <div className="h-full rounded-full bg-primary" style={{ width: `${storagePercent}%` }} />
                </div>
              </>
            )
          : quotaFallback}
      </StatCard>

      <StatCard label={t("portal:stats.namespace")}>
        {namespace.isPending && <StatSkeleton />}
        {namespace.isError && <BlockError error={namespace.error} onRetry={() => void namespace.refetch()} />}
        {namespace.data && (
          <div className="flex items-center gap-2">
            <span className="truncate font-mono text-2xl font-semibold">{namespace.data.slug}</span>
            <Badge variant={namespace.data.status === "active"
              ? "secondary"
              : "destructive"}
            >
              {t(NAMESPACE_STATUS_KEYS[namespace.data.status])}
            </Badge>
          </div>
        )}
      </StatCard>
    </div>
  );
}
