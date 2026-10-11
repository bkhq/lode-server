import { useQuery } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { CopyButton } from "@/shared/components/copy-button";
import { Button } from "@/shared/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/shared/components/ui/card";
import { ErrorBanner } from "@/shared/components/ui/error-banner";
import { Skeleton } from "@/shared/components/ui/skeleton";
import { registryErrorMessage } from "@/shared/lib/registry/errors";
import { namespaceQuery } from "@/shared/lib/registry/queries";
import { useAuthStore } from "@/shared/stores/auth";

export function NamespaceCard() {
  const { t } = useTranslation(["common", "packages", "regerrors"]);
  const user = useAuthStore(s => s.user);
  const namespace = useQuery(namespaceQuery());

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("packages:namespace.title")}</CardTitle>
        <CardDescription>{t("packages:namespace.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {namespace.isPending
          ? <Skeleton className="h-10 w-full" />
          : namespace.isError
            ? (
                <div className="flex items-center gap-2">
                  <ErrorBanner className="flex-1" message={registryErrorMessage(namespace.error, t, t("common.error.loadFailed"))} />
                  <Button variant="outline" size="sm" onClick={() => void namespace.refetch()}>{t("common.retry")}</Button>
                </div>
              )
            : (
                <>
                  <dl className="grid grid-cols-2 gap-4">
                    <div>
                      <dt className="text-xs text-muted-foreground">{t("packages:namespace.id")}</dt>
                      <dd className="flex items-center gap-1">
                        <code className="font-mono text-base font-medium">{namespace.data.slug}</code>
                        <CopyButton value={namespace.data.slug} label={t("packages:namespace.copy")} />
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-xs text-muted-foreground">{t("packages:namespace.owner")}</dt>
                      <dd className="flex h-6 items-center gap-1.5">
                        <span className="truncate font-medium">{user?.name}</span>
                        <span className="truncate text-muted-foreground">{user ? `@${user.username}` : ""}</span>
                      </dd>
                    </div>
                  </dl>
                  {namespace.data.status === "suspended" && (
                    <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                      <div>
                        <p className="font-medium">{t("packages:namespace.suspendedTitle")}</p>
                        <p>{t("packages:namespace.suspendedBody")}</p>
                      </div>
                    </div>
                  )}
                </>
              )}
      </CardContent>
    </Card>
  );
}
