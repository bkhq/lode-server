import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/admin/registry/tokens")({
  staticData: { titleKey: "registry:page.title" },
});
