import type { CreatedToken } from "@/shared/lib/registry/types";
import { useTranslation } from "react-i18next";
import { CopyButton } from "@/shared/components/copy-button";
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

function SecretLine({ label, value, copyLabel }: {
  readonly label: string;
  readonly value: string;
  readonly copyLabel: string;
}) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="flex items-start gap-2">
        <code className="min-w-0 flex-1 rounded bg-muted px-2 py-1.5 font-mono text-xs break-all">{value}</code>
        <CopyButton value={value} label={copyLabel} />
      </div>
    </div>
  );
}

/**
 * Shows the secret of a token that was just created. Open while `token` is
 * set; the caller drops it on close, and nothing else keeps the secret.
 */
export function SecretDialog({ token, onClose }: {
  readonly token: CreatedToken | null;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation("grants");
  return (
    <Dialog
      open={token !== null}
      onOpenChange={(open) => {
        if (!open)
          onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("secret.title", { name: token?.name })}</DialogTitle>
          <DialogDescription>{t("secret.description")}</DialogDescription>
        </DialogHeader>
        {token && (
          <div className="min-w-0 space-y-3">
            <p role="alert" className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
              {t("secret.warning")}
            </p>
            <SecretLine label={t("secret.token")} value={token.token} copyLabel={t("secret.copyToken")} />
            <SecretLine
              label={t("secret.header")}
              value={`Authorization: Bearer ${token.token}`}
              copyLabel={t("secret.copyHeader")}
            />
          </div>
        )}
        <DialogFooter>
          <DialogClose render={<Button type="button">{t("secret.done")}</Button>} />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
