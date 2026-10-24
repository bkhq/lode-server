/* eslint-disable react-refresh/only-export-components */
import { useQuery } from "@tanstack/react-query";
import { createLazyFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CopyButton } from "@/shared/components/copy-button";
import { Badge } from "@/shared/components/ui/badge";
import { ErrorBanner } from "@/shared/components/ui/error-banner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/components/ui/tabs";
import { errorMessage } from "@/shared/lib/errors";
import { HttpError } from "@/shared/lib/http";
import {
  adminPackagesQuery,
  namespaceQuery,
  packageQuery,
  versionsQuery,
} from "@/shared/lib/registry/queries";
import { useAuthStore } from "@/shared/stores/auth";
import { ChannelsTab } from "./-detail-channels";
import { CommitsTab } from "./-detail-commits";
import { InstallTab } from "./-detail-install";
import { KeysTab } from "./-detail-keys";
import { ObserveTab } from "./-detail-observe";
import { SettingsTab } from "./-detail-settings";
import { VersionsTab } from "./-detail-versions";

export const Route = createLazyFileRoute("/_app/packages/$ns/$pkg")({
  component: PackagePage,
});

function BackLink() {
  const { t } = useTranslation(["package"]);
  return (
    <Link to="/packages" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="size-4" />
      {t("package:header.back")}
    </Link>
  );
}

function PackagePage() {
  const { ns, pkg: slug } = Route.useParams();
  const { t } = useTranslation(["package", "common"]);
  const user = useAuthStore(s => s.user);
  const [tab, setTab] = useState("versions");

  const pkgQuery = useQuery(packageQuery(ns, slug));
  const namespace = useQuery(namespaceQuery());
  const isAdmin = user?.role === "admin";
  const isOwner = namespace.data?.slug === ns;
  // The package response carries no owner; only the administrator's list does.
  const adminPackages = useQuery({
    ...adminPackagesQuery(),
    enabled: isAdmin && namespace.isSuccess && !isOwner,
  });
  const versions = useQuery({
    ...versionsQuery(ns, slug),
    enabled: pkgQuery.isSuccess,
  });

  if (pkgQuery.isPending) {
    return (
      <div className="space-y-4">
        <BackLink />
        <p className="text-sm text-muted-foreground">{t("common:common.loading")}</p>
      </div>
    );
  }

  if (pkgQuery.isError) {
    const notFound = pkgQuery.error instanceof HttpError && pkgQuery.error.status === 404;
    return (
      <div className="space-y-4">
        <BackLink />
        {notFound
          ? (
              <div>
                <h1 className="text-2xl font-bold">{t("package:notFound.title")}</h1>
                <p className="mt-1 text-muted-foreground">{t("package:notFound.description")}</p>
              </div>
            )
          : <ErrorBanner message={errorMessage(pkgQuery.error, t("common:common.error.loadFailed"))} />}
      </div>
    );
  }

  const pkg = pkgQuery.data;
  const canWrite = isOwner || isAdmin;
  const owner = isOwner
    ? user
    : adminPackages.data?.find(p => p.namespace === ns && p.slug === slug)?.owner;
  const id = `${pkg.namespace}/${pkg.slug}`;
  const versionList = versions.data?.versions ?? [];
  const channelList = versions.data?.channels ?? [];

  return (
    <div className="space-y-4">
      <BackLink />

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold">{pkg.name}</h1>
          <Badge variant={pkg.visibility === "public"
            ? "secondary"
            : "outline"}
          >
            {pkg.visibility === "public"
              ? t("package:visibility.public")
              : t("package:visibility.private")}
          </Badge>
          {pkg.require_signature && <Badge variant="outline">{t("package:header.signatureRequired")}</Badge>}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <code className="font-mono text-foreground">{id}</code>
            <CopyButton value={id} label={t("package:header.copyId")} />
          </span>
          {owner && <span>{t("package:header.owner", { name: owner.name, username: owner.username })}</span>}
        </div>
        {pkg.description && <p className="max-w-3xl text-muted-foreground">{pkg.description}</p>}
        {namespace.isSuccess && !canWrite && (
          <p className="text-sm text-muted-foreground">{t("package:header.readOnly")}</p>
        )}
      </div>

      <Tabs value={tab} onValueChange={value => setTab(String(value))}>
        <TabsList>
          <TabsTrigger value="versions">{t("package:tabs.versions")}</TabsTrigger>
          <TabsTrigger value="channels">{t("package:tabs.channels")}</TabsTrigger>
          <TabsTrigger value="commits">{t("package:tabs.commits")}</TabsTrigger>
          {canWrite && <TabsTrigger value="keys">{t("package:tabs.keys")}</TabsTrigger>}
          <TabsTrigger value="install">{t("package:tabs.install")}</TabsTrigger>
          <TabsTrigger value="observe">{t("package:tabs.observe")}</TabsTrigger>
          <TabsTrigger value="settings">{t("package:tabs.settings")}</TabsTrigger>
        </TabsList>

        {versions.isError && (
          <ErrorBanner message={errorMessage(versions.error, t("common:common.error.loadFailed"))} />
        )}

        <TabsContent value="versions">
          {versions.isPending
            ? <p className="text-sm text-muted-foreground">{t("common:common.loading")}</p>
            : <VersionsTab ns={ns} pkg={slug} canWrite={canWrite} versions={versionList} channels={channelList} />}
        </TabsContent>
        <TabsContent value="channels">
          {versions.isPending
            ? <p className="text-sm text-muted-foreground">{t("common:common.loading")}</p>
            : <ChannelsTab ns={ns} pkg={slug} canWrite={canWrite} versions={versionList} channels={channelList} />}
        </TabsContent>
        <TabsContent value="commits">
          <CommitsTab ns={ns} pkg={slug} />
        </TabsContent>
        <TabsContent value="install">
          <InstallTab pkg={pkg} versions={versionList} channels={channelList} canWrite={canWrite} onOpenKeys={() => setTab("keys")} />
        </TabsContent>
        <TabsContent value="observe">
          <ObserveTab ns={ns} pkg={slug} />
        </TabsContent>
        {canWrite && (
          <TabsContent value="keys">
            <KeysTab ns={ns} pkg={slug} canRevoke={canWrite} />
          </TabsContent>
        )}
        <TabsContent value="settings">
          <SettingsTab key={pkg.updated_at} pkg={pkg} canWrite={canWrite} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
