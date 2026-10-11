import type { NavItem } from "@/shared/components/sidebar/types";
import { Package } from "lucide-react";

export const packagesNav: NavItem = {
  area: "main",
  key: "packages",
  path: "/packages",
  icon: Package,
  matchPrefix: "/packages",
  order: 20,
};
