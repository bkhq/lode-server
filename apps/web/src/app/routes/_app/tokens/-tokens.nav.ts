import type { NavItem } from "@/shared/components/sidebar/types";
import { Ticket } from "lucide-react";

export const tokensNav: NavItem = {
  area: "main",
  key: "accessTokens",
  path: "/tokens",
  icon: Ticket,
  order: 40,
};
