import type { Owner } from "@/shared/lib/registry/types";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/components/ui/dialog";
import { ErrorBanner } from "@/shared/components/ui/error-banner";
import { Input } from "@/shared/components/ui/input";
import { useDebounce } from "@/shared/hooks/use-debounce";
import { errorMessage } from "@/shared/lib/errors";
import { http } from "@/shared/lib/http";
import { OwnerCell } from "./-owner-cell";

const PAGE_SIZE = 20;

function searchUsers(q: string): Promise<{ data: Owner[] }> {
  const params = new URLSearchParams({ page: "1", limit: String(PAGE_SIZE) });
  if (q)
    params.set("q", q);
  return http(`/account/users?${params.toString()}`);
}

/** Picks any user of the platform, for one who has no namespace to start from. */
export function UserPickerDialog({
  open,
  onOpenChange,
  onPick,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPick: (user: Owner) => void;
}) {
  const { t } = useTranslation(["common", "registry"]);
  const [search, setSearch] = useState("");
  const q = useDebounce(search.trim(), 300);
  const { data, isPending, error } = useQuery({
    queryKey: ["account", "users", "picker", q],
    queryFn: () => searchUsers(q),
    enabled: open,
  });
  const users = data?.data ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("registry:userPicker.title")}</DialogTitle>
          <DialogDescription>{t("registry:userPicker.description")}</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={t("registry:userPicker.placeholder")}
            aria-label={t("registry:userPicker.placeholder")}
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-8"
          />
        </div>
        <ErrorBanner message={error ? errorMessage(error, t("common.error.loadFailed")) : null} />
        <div className="max-h-72 space-y-1 overflow-y-auto" aria-busy={isPending}>
          {isPending && !error && <p className="py-6 text-center text-sm text-muted-foreground">{t("common.loading")}</p>}
          {data && users.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">{t("registry:userPicker.empty")}</p>
          )}
          {users.map(user => (
            <button
              key={user.id}
              type="button"
              className="w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
              onClick={() => onPick({ id: user.id, username: user.username, name: user.name })}
            >
              <OwnerCell owner={user} />
            </button>
          ))}
          {users.length === PAGE_SIZE && (
            <p className="px-2 py-1 text-xs text-muted-foreground">{t("registry:userPicker.more")}</p>
          )}
        </div>
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline">{t("common.cancel")}</Button>} />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
