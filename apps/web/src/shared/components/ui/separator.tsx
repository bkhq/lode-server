"use client"

import { Separator as SeparatorPrimitive } from "@base-ui/react/separator"

import { cn } from "@/shared/lib/utils"

function Separator({
  className,
  orientation = "horizontal",
  ...props
}: SeparatorPrimitive.Props) {
  // Conditional classes (vs `data-horizontal:` variants) so callers can
  // override width/height with plain utility classes — tailwind-merge
  // can only dedupe classes inside the same variant group, and the
  // shadcn `data-horizontal` custom variant uses `:where()` (zero
  // specificity), making source-order the deciding factor. Keeping
  // these unconditional means `w-auto` in SidebarSeparator wins reliably.
  return (
    <SeparatorPrimitive
      data-slot="separator"
      orientation={orientation}
      className={cn(
        "shrink-0 bg-border",
        orientation === "horizontal" ? "h-px w-full" : "w-px self-stretch",
        className
      )}
      {...props}
    />
  )
}

export { Separator }
