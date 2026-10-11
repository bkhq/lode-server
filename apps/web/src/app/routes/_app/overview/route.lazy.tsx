/* eslint-disable react-refresh/only-export-components */
import type { LucideIcon } from "lucide-react";
import { createLazyFileRoute, Link } from "@tanstack/react-router";
import { Package, Ticket } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Card, CardDescription, CardHeader, CardTitle } from "@/shared/components/ui/card";
import { useAuthStore } from "@/shared/stores/auth";
import { RecentVersions } from "./-recent-versions";
import { StatCards } from "./-stat-card";

export const Route = createLazyFileRoute("/_app/overview")({
  component: PortalPage,
});

interface QuickLink {
  readonly path: "/packages" | "/tokens";
  readonly icon: LucideIcon;
  readonly titleKey: `portal:links.${string}.title`;
  readonly descriptionKey: `portal:links.${string}.description`;
}

const QUICK_LINKS: readonly QuickLink[] = [
  {
    path: "/packages",
    icon: Package,
    titleKey: "portal:links.packages.title",
    descriptionKey: "portal:links.packages.description",
  },
  {
    path: "/tokens",
    icon: Ticket,
    titleKey: "portal:links.tokens.title",
    descriptionKey: "portal:links.tokens.description",
  },
];

function PortalPage() {
  const { t } = useTranslation("portal");
  const user = useAuthStore(s => s.user);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">
          {t("portal:welcome", { name: user?.name ?? user?.username ?? "" })}
        </h1>
        <p className="mt-1 text-muted-foreground">{t("portal:page.description")}</p>
      </div>

      <StatCards />

      <RecentVersions />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {QUICK_LINKS.map(link => (
          <Link key={link.path} to={link.path}>
            <Card size="sm" className="h-full cursor-pointer transition-colors hover:bg-muted/50">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <link.icon className="size-5" />
                  </div>
                  <div>
                    <CardTitle className="text-sm">{t(link.titleKey)}</CardTitle>
                    <CardDescription className="text-xs">{t(link.descriptionKey)}</CardDescription>
                  </div>
                </div>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
