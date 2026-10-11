import type { NavItem } from "@/shared/components/sidebar/types";
import { Shield } from "lucide-react";

export const policiesNav: NavItem = {
  area: "admin",
  key: "policies",
  path: "/admin/policies",
  icon: Shield,
  order: 20,
};
