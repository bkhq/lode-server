import type { NavItem } from "@/shared/components/sidebar/types";
import { Clock } from "lucide-react";

export const cronNav: NavItem = {
  area: "admin",
  key: "cron",
  path: "/admin/cron",
  icon: Clock,
  order: 35,
};
