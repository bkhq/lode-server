import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/admin/audit")({
  staticData: { titleKey: "audit:page.title" },
});
