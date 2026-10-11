import type { NavItem } from "@/shared/components/sidebar/types";
import { ScrollText } from "lucide-react";

export const auditNav: NavItem = {
  area: "admin",
  key: "audit",
  path: "/admin/audit",
  icon: ScrollText,
  order: 30,
};
