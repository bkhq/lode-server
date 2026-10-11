/* eslint-disable react-refresh/only-export-components */
import { createFileRoute, Navigate, Outlet } from "@tanstack/react-router";
import { useAuthStore } from "@/shared/stores/auth";

export const Route = createFileRoute("/_app/admin")({
  component: AdminLayout,
});

function AdminLayout() {
  const user = useAuthStore(s => s.user);

  if (!user || user.role !== "admin") {
    return <Navigate to="/overview" />;
  }

  return <Outlet />;
}
