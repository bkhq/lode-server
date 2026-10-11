import type { NavItem } from "@/shared/components/sidebar/types";
import { Boxes } from "lucide-react";

export const registryNav: NavItem = {
  area: "admin",
  key: "registry",
  path: "/admin/registry",
  icon: Boxes,
  matchPrefix: "/admin/registry",
  order: 15,
};
