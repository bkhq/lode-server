import { useTranslation } from "react-i18next";
import { Button } from "@/shared/components/ui/button";
import { registryErrorMessage } from "@/shared/lib/registry/errors";

/** Compact failure line for one overview block, with a retry. */
export function BlockError({
  error,
  onRetry,
}: {
  readonly error: unknown;
  readonly onRetry: () => void;
}) {
  const { t } = useTranslation(["portal", "regerrors"]);

  return (
    <div role="alert" className="flex items-center justify-between gap-2 text-sm text-destructive">
      <span className="min-w-0">{registryErrorMessage(error, t, t("portal:error.load"))}</span>
      <Button variant="ghost" size="sm" onClick={onRetry}>
        {t("portal:error.retry")}
      </Button>
    </div>
  );
}
