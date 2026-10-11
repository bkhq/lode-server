import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/overview")({
  staticData: { titleKey: "portal:page.title" },
});
