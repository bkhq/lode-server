/* eslint-disable react-refresh/only-export-components */
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { showsHome } from "@/shared/lib/home";
import { useSystemStore } from "@/shared/stores/system";
import { HomePage } from "./-home";

export const Route = createFileRoute("/")({
  component: IndexPage,
});

// `/` is either the home page (HOME_PAGE) or just an entry point — the real
// landing page is `/overview`, and the `_app` layout there sends an
// unauthenticated visitor to `/login`.
function IndexPage() {
  const homePage = useSystemStore(s => s.homePage);
  return showsHome(homePage)
    ? <HomePage />
    : <Navigate to="/overview" />;
}
