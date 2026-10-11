/* eslint-disable react-refresh/only-export-components */
import { createFileRoute, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Tabs, TabsList, TabsTrigger } from "@/shared/components/ui/tabs";

export const Route = createFileRoute("/_app/admin/users")({
  staticData: { titleKey: "users:page.title" },
  component: UsersLayout,
});

function UsersLayout() {
  const { t } = useTranslation(["common", "users"]);
  const navigate = useNavigate();
  const pathname = useRouterState({ select: s => s.location.pathname });

  const currentTab = pathname.includes("/users/groups") ? "groups" : "users";

  const handleTabChange = (value: string | null) => {
    if (!value)
      return;
    if (value === "groups") {
      void navigate({ to: "/admin/users/groups" });
    }
    else {
      void navigate({ to: "/admin/users" });
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t("users:page.title")}</h1>
        <p className="mt-1 text-muted-foreground">{t("users:page.description")}</p>
      </div>

      <Tabs value={currentTab} onValueChange={handleTabChange}>
        <TabsList variant="line">
          <TabsTrigger value="users">{t("users:tabs.users")}</TabsTrigger>
          <TabsTrigger value="groups">{t("users:tabs.groups")}</TabsTrigger>
        </TabsList>
      </Tabs>

      <Outlet />
    </div>
  );
}
