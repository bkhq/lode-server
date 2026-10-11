import type { NavItem } from "@/shared/components/sidebar/types";
import { LayoutGrid } from "lucide-react";

export const overviewNav: NavItem = {
  area: "main",
  key: "overview",
  path: "/overview",
  icon: LayoutGrid,
  order: 10,
};
