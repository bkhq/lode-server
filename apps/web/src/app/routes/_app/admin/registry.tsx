/* eslint-disable react-refresh/only-export-components */
import { createFileRoute, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Tabs, TabsList, TabsTrigger } from "@/shared/components/ui/tabs";

export const Route = createFileRoute("/_app/admin/registry")({
  staticData: { titleKey: "registry:page.title" },
  component: RegistryLayout,
});

function RegistryLayout() {
  const { t } = useTranslation(["common", "registry"]);
  const navigate = useNavigate();
  const pathname = useRouterState({
    select: s => s.location.pathname,
  });

  const currentTab = pathname.includes("/registry/packages")
    ? "packages"
    : pathname.includes("/registry/tokens")
      ? "tokens"
      : "namespaces";

  const handleTabChange = (value: string | null) => {
    if (!value)
      return;
    if (value === "packages") {
      void navigate({ to: "/admin/registry/packages" });
    }
    else if (value === "tokens") {
      void navigate({ to: "/admin/registry/tokens" });
    }
    else {
      void navigate({ to: "/admin/registry" });
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t("registry:page.title")}</h1>
        <p className="mt-1 text-muted-foreground">{t("registry:page.description")}</p>
      </div>

      <Tabs value={currentTab} onValueChange={handleTabChange}>
        <TabsList variant="line">
          <TabsTrigger value="namespaces">{t("registry:tabs.namespaces")}</TabsTrigger>
          <TabsTrigger value="packages">{t("registry:tabs.packages")}</TabsTrigger>
          <TabsTrigger value="tokens">{t("registry:tabs.tokens")}</TabsTrigger>
        </TabsList>
      </Tabs>

      <Outlet />
    </div>
  );
}
