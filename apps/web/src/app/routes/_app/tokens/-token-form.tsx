import type { ReactNode } from "react";
import type { ExpiryPreset, GrantFormState } from "./-grant-form";
import type { CreatedToken, RegistryPackage, RegistryToken } from "@/shared/lib/registry/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/components/ui/select";
import { createToken, replaceTokenGrants } from "@/shared/lib/registry/api";
import { registryErrorMessage } from "@/shared/lib/registry/errors";
import { packagesQuery, registryKeys } from "@/shared/lib/registry/queries";
import { GrantEditor } from "./-grant-editor";
import { emptyGrantForm, expiresAt, EXPIRY_PRESETS, fromWire, toWire } from "./-grant-form";

const DIALOG_CLASS = "max-h-[90vh] overflow-y-auto sm:max-w-2xl";
const NAME_MAX = 100;

/**
 * Renders the form only once the caller's packages are known: the grant rows
 * come from them, and an edit prefilled from a failed load would save away
 * every per-package grant.
 */
function WithPackages({ children }: { readonly children: (packages: readonly RegistryPackage[]) => ReactNode }) {
  const { t } = useTranslation(["common", "regerrors"]);
  const packages = useQuery(packagesQuery());

  if (packages.isPending)
    return <p className="py-8 text-center text-sm text-muted-foreground">{t("common.loading")}</p>;
  if (packages.isError)
    return <ErrorBanner message={registryErrorMessage(packages.error, t, t("common.error.loadFailed"))} />;
  return children(packages.data);
}

function CreateForm({ packages, onCreated }: {
  readonly packages: readonly RegistryPackage[];
  readonly onCreated: (token: CreatedToken) => void;
}) {
  const { t } = useTranslation(["common", "grants", "regerrors"]);
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState<ExpiryPreset>("90d");
  const [grants, setGrants] = useState<GrantFormState>(emptyGrantForm);

  const create = useMutation({
    mutationFn: () => createToken({
      name: name.trim(),
      expires_at: expiresAt(expiry, new Date()),
      grants: toWire(grants),
    }),
    onSuccess: (token) => {
      void queryClient.invalidateQueries({ queryKey: registryKeys.tokens() });
      onCreated(token);
    },
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
        <div className="space-y-2">
          <Label htmlFor="registry-token-name">{t("grants:field.name")}</Label>
          <Input
            id="registry-token-name"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder={t("grants:field.namePlaceholder")}
            maxLength={NAME_MAX}
            autoFocus
          />
        </div>
        <div className="space-y-2">
          <Label>{t("grants:field.expiry")}</Label>
          <Select
            value={expiry}
            onValueChange={(v) => {
              if (v !== null)
                setExpiry(v);
            }}
          >
            <SelectTrigger aria-label={t("grants:field.expiry")} className="w-36">
              <SelectValue>{(v: ExpiryPreset) => t(`grants:expiry.${v}`)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {EXPIRY_PRESETS.map(preset => (
                <SelectItem key={preset} value={preset}>{t(`grants:expiry.${preset}`)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-2">
        <Label>{t("grants:field.grants")}</Label>
        <GrantEditor value={grants} onChange={setGrants} packages={packages} />
      </div>

      <ErrorBanner message={create.isError ? registryErrorMessage(create.error, t, t("common.error.operationFailed")) : null} />

      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline">{t("common.cancel")}</Button>} />
        <Button type="submit" disabled={!name.trim() || create.isPending} aria-busy={create.isPending}>
          {create.isPending ? t("common.submitting") : t("grants:create.submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function CreateTokenDialog({ open, onOpenChange, onCreated }: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreated: (token: CreatedToken) => void;
}) {
  const { t } = useTranslation("grants");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={DIALOG_CLASS}>
        <DialogHeader>
          <DialogTitle>{t("create.title")}</DialogTitle>
          <DialogDescription>{t("create.description")}</DialogDescription>
        </DialogHeader>
        <WithPackages>
          {packages => <CreateForm packages={packages} onCreated={onCreated} />}
        </WithPackages>
      </DialogContent>
    </Dialog>
  );
}

function EditForm({ token, packages, onSaved }: {
  readonly token: RegistryToken;
  readonly packages: readonly RegistryPackage[];
  readonly onSaved: () => void;
}) {
  const { t } = useTranslation(["common", "grants", "regerrors"]);
  const queryClient = useQueryClient();
  const [grants, setGrants] = useState<GrantFormState>(() => fromWire(token.grants, packages));

  const save = useMutation({
    mutationFn: () => replaceTokenGrants(token.id, toWire(grants)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: registryKeys.tokens() });
      toast.success(t("grants:edit.saved"));
      onSaved();
    },
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <GrantEditor value={grants} onChange={setGrants} packages={packages} />

      <ErrorBanner message={save.isError ? registryErrorMessage(save.error, t, t("common.error.saveFailed")) : null} />

      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline">{t("common.cancel")}</Button>} />
        <Button type="submit" disabled={save.isPending} aria-busy={save.isPending}>
          {save.isPending ? t("common.saving") : t("common.save")}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Open while `token` is set. */
export function EditGrantsDialog({ token, onClose }: {
  readonly token: RegistryToken | null;
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
      <DialogContent className={DIALOG_CLASS}>
        <DialogHeader>
          <DialogTitle>{t("edit.title", { name: token?.name })}</DialogTitle>
          <DialogDescription>{t("edit.description")}</DialogDescription>
        </DialogHeader>
        {token && (
          <WithPackages>
            {packages => <EditForm key={token.id} token={token} packages={packages} onSaved={onClose} />}
          </WithPackages>
        )}
      </DialogContent>
    </Dialog>
  );
}
