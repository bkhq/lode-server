import type { FormEvent } from "react";
import type { KeyInputError } from "./-detail-key-input";
import type { RegisterKeyInput } from "@/shared/lib/registry/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
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
import { Label } from "@/shared/components/ui/label";
import { Textarea } from "@/shared/components/ui/textarea";
import { registerKey } from "@/shared/lib/registry/api";
import { registryErrorMessage } from "@/shared/lib/registry/errors";
import { registryKeys } from "@/shared/lib/registry/queries";
import { keyInputError } from "./-detail-key-input";

export function RegisterKeyDialog({
  ns,
  pkg,
  open,
  onOpenChange,
}: {
  readonly ns: string;
  readonly pkg: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["keys", "common", "regerrors"]);
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [inputError, setInputError] = useState<KeyInputError>();

  const inputErrorText: Record<KeyInputError, string> = {
    empty: t("keys:register.error.empty"),
    privateKey: t("keys:register.error.privateKey"),
    whitespace: t("keys:register.error.whitespace"),
  };

  const mutation = useMutation({
    mutationFn: (input: RegisterKeyInput) => registerKey(ns, pkg, input),
    onSuccess: (key) => {
      void queryClient.invalidateQueries({
        queryKey: registryKeys.keys(ns, pkg),
      });
      toast.success(t("keys:toast.registered", { name: key.name }));
      close();
    },
  });

  function close() {
    onOpenChange(false);
    setName("");
    setPublicKey("");
    setInputError(undefined);
    mutation.reset();
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const error = keyInputError(publicKey);
    setInputError(error);
    if (error)
      return;
    mutation.mutate({
      name: name.trim(),
      public_key: publicKey.trim(),
    });
  };

  const error = inputError
    ? inputErrorText[inputError]
    : mutation.error
      ? registryErrorMessage(mutation.error, t, t("common:common.error.operationFailed"))
      : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next)
          onOpenChange(true);
        else
          close();
      }}
    >
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{t("keys:register.title")}</DialogTitle>
            <DialogDescription>{t("keys:register.description")}</DialogDescription>
          </DialogHeader>

          <ErrorBanner message={error} />

          <div className="space-y-2">
            <Label htmlFor="key-name">{t("keys:register.name")}</Label>
            <Input
              id="key-name"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={t("keys:register.namePlaceholder")}
              maxLength={100}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="key-public">{t("keys:register.publicKey")}</Label>
            <Textarea
              id="key-public"
              value={publicKey}
              onChange={(e) => {
                setPublicKey(e.target.value);
                setInputError(undefined);
              }}
              className="font-mono break-all"
              rows={3}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={inputError !== undefined}
            />
            <p className="text-xs text-muted-foreground">
              {t("keys:register.forms")}
              {" "}
              <code className="font-mono">[ed25519:][&lt;key_id&gt;:]&lt;key&gt;</code>
            </p>
          </div>

          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline">{t("common:common.cancel")}</Button>} />
            <Button type="submit" disabled={mutation.isPending || name.trim() === ""}>
              {mutation.isPending
                ? t("common:common.submitting")
                : t("keys:register.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
