import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/shared/components/ui/card";
import { ErrorBanner } from "@/shared/components/ui/error-banner";
import { Skeleton } from "@/shared/components/ui/skeleton";
import { registryErrorMessage } from "@/shared/lib/registry/errors";
import { formatBytes, usagePercent } from "@/shared/lib/registry/format";
import { quotaQuery } from "@/shared/lib/registry/queries";
import { cn } from "@/shared/lib/utils";

// From here up the bar turns red: the next publish or package may not fit.
const NEARLY_FULL_PERCENT = 90;

function UsageBar({ label, value, percent }: {
  readonly label: string;
  readonly value: string;
  readonly percent: number;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="font-medium tabular-nums">{value}</span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
        aria-valuetext={value}
        className="h-2 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn("h-full rounded-full", percent >= NEARLY_FULL_PERCENT ? "bg-destructive" : "bg-primary")}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

export function QuotaCard() {
  const { t } = useTranslation(["common", "packages", "regerrors"]);
  const quota = useQuery(quotaQuery());

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("packages:quota.title")}</CardTitle>
        <CardDescription>{t("packages:quota.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {quota.isPending
          ? <Skeleton className="h-24 w-full" />
          : quota.isError
            ? (
                <div className="flex items-center gap-2">
                  <ErrorBanner className="flex-1" message={registryErrorMessage(quota.error, t, t("common.error.loadFailed"))} />
                  <Button variant="outline" size="sm" onClick={() => void quota.refetch()}>{t("common.retry")}</Button>
                </div>
              )
            : (
                <>
                  <UsageBar
                    label={t("packages:quota.packages")}
                    value={t("packages:quota.of", { used: quota.data.usage.packages, limit: quota.data.limits.max_packages })}
                    percent={usagePercent(quota.data.usage.packages, quota.data.limits.max_packages)}
                  />
                  <UsageBar
                    label={t("packages:quota.storage")}
                    value={t("packages:quota.of", {
                      used: formatBytes(quota.data.usage.storage_bytes),
                      limit: formatBytes(quota.data.limits.max_storage_bytes),
                    })}
                    percent={usagePercent(quota.data.usage.storage_bytes, quota.data.limits.max_storage_bytes)}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("packages:quota.maxAsset", { size: formatBytes(quota.data.limits.max_asset_bytes) })}
                  </p>
                </>
              )}
      </CardContent>
    </Card>
  );
}
