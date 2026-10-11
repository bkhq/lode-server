import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/admin/policies")({
  staticData: { titleKey: "policies:page.title" },
});
