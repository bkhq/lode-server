import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/packages/$ns/$pkg")({
  staticData: { titleKey: "package:page.title" },
});
