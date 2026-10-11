import type { Owner } from "@/shared/lib/registry/types";

/** Who a row belongs to: the namespace id is random and names nobody. */
export function OwnerCell({ owner }: { readonly owner: Pick<Owner, "name" | "username"> }) {
  return (
    <div className="flex flex-col">
      <span className="font-medium">{owner.name}</span>
      <span className="text-xs text-muted-foreground">
        @
        {owner.username}
      </span>
    </div>
  );
}
