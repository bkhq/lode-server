import type { Owner } from "@/shared/lib/registry/types";

/** "Name (@username)", for confirmation texts and titles. */
export function ownerLabel(owner: Pick<Owner, "name" | "username">): string {
  return `${owner.name} (@${owner.username})`;
}
