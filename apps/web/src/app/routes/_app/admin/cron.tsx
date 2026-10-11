import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/admin/cron")({
  staticData: { titleKey: "cron:page.title" },
});
