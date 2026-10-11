import type { ReactNode } from "react";
import { Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Input } from "@/shared/components/ui/input";
import { TableCell, TableRow } from "@/shared/components/ui/table";

/** The client-side text filter above a list, with the "shown of total" count. */
export function ListFilter({
  value,
  onChange,
  shown,
  total,
  children,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly shown: number;
  readonly total: number;
  readonly children?: ReactNode;
}) {
  const { t } = useTranslation(["common", "registry"]);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="relative w-72">
        <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder={t("registry:filter.placeholder")}
          aria-label={t("registry:filter.placeholder")}
          value={value}
          onChange={e => onChange(e.target.value)}
          className="pl-8"
        />
      </div>
      <span className="text-sm text-muted-foreground">
        {t("registry:filter.count", { shown, total })}
      </span>
      {children}
    </div>
  );
}

/** A full-width table row carrying a loading or empty message. */
export function MessageRow({ colSpan, children }: { readonly colSpan: number; readonly children: ReactNode }) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="h-24 text-center text-muted-foreground">
        {children}
      </TableCell>
    </TableRow>
  );
}
