import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/tokens")({
  staticData: { titleKey: "grants:page.title" },
});
