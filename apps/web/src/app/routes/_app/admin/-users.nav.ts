import type { NavItem } from "@/shared/components/sidebar/types";
import { Users } from "lucide-react";

export const usersNav: NavItem = {
  area: "admin",
  key: "users",
  path: "/admin/users",
  icon: Users,
  order: 10,
};
