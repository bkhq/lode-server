import type { ReactNode } from "react";

import { cn } from "@/shared/lib/utils";

/**
 * Centers a short status string (loading / empty / error) inside the
 * available height. Defaults to muted color; `tone="destructive"` for
 * error states.
 */
export function CenteredHint({
  children,
  tone = "muted",
  className,
}: {
  readonly children: ReactNode;
  readonly tone?: "muted" | "destructive";
  readonly className?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-full items-center justify-center text-sm",
        tone === "destructive" ? "text-destructive" : "text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}
