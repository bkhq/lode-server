import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/admin/settings")({
  staticData: { titleKey: "settings:page.title" },
});
