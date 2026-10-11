import { cn } from "@/shared/lib/utils";

export function ErrorBanner({
  message,
  className,
}: {
  readonly message: string | null | undefined;
  readonly className?: string;
}) {
  if (!message)
    return null;
  return (
    <div className={cn("rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive", className)}>
      {message}
    </div>
  );
}
