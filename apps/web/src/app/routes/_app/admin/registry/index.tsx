import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/admin/registry/")({
  staticData: { titleKey: "registry:page.title" },
});
