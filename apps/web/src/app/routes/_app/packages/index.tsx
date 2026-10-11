import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/packages/")({
  staticData: { titleKey: "packages:page.title" },
});
