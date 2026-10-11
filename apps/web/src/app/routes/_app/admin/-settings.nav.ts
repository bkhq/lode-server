import type { NavItem } from "@/shared/components/sidebar/types";
import { Cog } from "lucide-react";

export const settingsNav: NavItem = {
  area: "admin",
  key: "platformSettings",
  path: "/admin/settings",
  matchPrefix: "/admin/settings",
  icon: Cog,
  order: 40,
};
