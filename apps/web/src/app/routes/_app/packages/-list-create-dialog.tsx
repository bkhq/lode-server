import type { FormEvent } from "react";
import type { RegistryPackage } from "@/shared/lib/registry/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
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
import { Switch } from "@/shared/components/ui/switch";
import { Textarea } from "@/shared/components/ui/textarea";
import { createPackage } from "@/shared/lib/registry/api";
import { registryErrorMessage } from "@/shared/lib/registry/errors";
import { registryKeys } from "@/shared/lib/registry/queries";
import { MAX_NAME_LENGTH, MAX_SLUG_LENGTH, validatePackageName, validatePackageSlug } from "./-list-slug";

type Visibility = RegistryPackage["visibility"];

// The server's bound on `description`.
const MAX_DESCRIPTION_LENGTH = 2000;

interface CreatePackageDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The caller's namespace id, for the path preview; undefined while it loads. */
  readonly namespace: string | undefined;
}

export function CreatePackageDialog({ open, onOpenChange, namespace }: CreatePackageDialogProps) {
  const { t } = useTranslation(["common", "packages"]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("packages:create.title")}</DialogTitle>
          <DialogDescription>{t("packages:create.description")}</DialogDescription>
        </DialogHeader>
        {/* Mounted with the dialog, so every open starts from a blank form. */}
        <CreatePackageForm namespace={namespace} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function CreatePackageForm({ namespace, onDone }: {
  readonly namespace: string | undefined;
  readonly onDone: () => void;
}) {
  const { t } = useTranslation(["common", "packages", "regerrors"]);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [description, setDescription] = useState("");
  const [requireSignature, setRequireSignature] = useState(false);

  const slugError = validatePackageSlug(slug);
  const nameError = validatePackageName(name);
  // An untouched field is incomplete, not wrong: no message until something is typed.
  const shownSlugError = slug === "" ? undefined : slugError;
  const shownNameError = name === "" ? undefined : nameError;

  const mutation = useMutation({
    mutationFn: createPackage,
    onSuccess: (pkg) => {
      toast.success(t("packages:create.created", { name: pkg.name }));
      void queryClient.invalidateQueries({ queryKey: registryKeys.packages() });
      void queryClient.invalidateQueries({ queryKey: registryKeys.quota() });
      onDone();
      void navigate({ to: "/packages/$ns/$pkg", params: { ns: pkg.namespace, pkg: pkg.slug } });
    },
  });

  const canSubmit = !slugError && !nameError && !mutation.isPending;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit)
      return;
    const trimmedDescription = description.trim();
    mutation.mutate({
      slug,
      name: name.trim(),
      // Always sent: left out, the server would create the package public.
      visibility,
      ...(trimmedDescription ? { description: trimmedDescription } : {}),
      require_signature: requireSignature,
    });
  };

  return (
    <form className="space-y-4" onSubmit={submit} noValidate>
      {mutation.isError && (
        <ErrorBanner message={registryErrorMessage(mutation.error, t, t("common.error.operationFailed"))} />
      )}

      <div className="space-y-1">
        <Label htmlFor="create-package-slug">{t("packages:create.slug")}</Label>
        <Input
          id="create-package-slug"
          className="font-mono"
          placeholder="my-app"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={slug}
          onChange={e => setSlug(e.target.value)}
          aria-invalid={shownSlugError !== undefined}
          aria-describedby="create-package-slug-rule"
        />
        {shownSlugError && (
          <p role="alert" className="text-xs text-destructive">
            {t(`packages:create.slugError.${shownSlugError}`, { max: MAX_SLUG_LENGTH })}
          </p>
        )}
        <div id="create-package-slug-rule" className="space-y-1 text-xs text-muted-foreground">
          <p>{t("packages:create.slugRule", { max: MAX_SLUG_LENGTH })}</p>
          <p className="font-medium text-foreground">{t("packages:create.slugPermanent")}</p>
          {namespace && !slugError && (
            <p>
              {t("packages:create.slugPreview")}
              {" "}
              <code className="font-mono text-foreground">{`${namespace}/${slug}`}</code>
            </p>
          )}
        </div>
      </div>

      <div className="space-y-1">
        <Label htmlFor="create-package-name">{t("packages:create.name")}</Label>
        <Input
          id="create-package-name"
          placeholder={t("packages:create.namePlaceholder")}
          value={name}
          onChange={e => setName(e.target.value)}
          aria-invalid={shownNameError !== undefined}
        />
        {shownNameError
          ? (
              <p role="alert" className="text-xs text-destructive">
                {t(`packages:create.nameError.${shownNameError}`, { max: MAX_NAME_LENGTH })}
              </p>
            )
          : <p className="text-xs text-muted-foreground">{t("packages:create.nameHint", { max: MAX_NAME_LENGTH })}</p>}
      </div>

      <div className="space-y-1">
        <Label htmlFor="create-package-visibility">{t("packages:create.visibility")}</Label>
        <Select
          value={visibility}
          onValueChange={(v) => {
            if (v !== null)
              setVisibility(v);
          }}
        >
          <SelectTrigger id="create-package-visibility" className="w-full">
            <SelectValue>
              {(v: Visibility) => t(`packages:visibility.${v}`)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="private">{t("packages:visibility.private")}</SelectItem>
            <SelectItem value="public">{t("packages:visibility.public")}</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{t(`packages:create.visibilityHint.${visibility}`)}</p>
      </div>

      <div className="space-y-1">
        <Label htmlFor="create-package-description">{t("packages:create.descriptionField")}</Label>
        <Textarea
          id="create-package-description"
          rows={2}
          maxLength={MAX_DESCRIPTION_LENGTH}
          value={description}
          onChange={e => setDescription(e.target.value)}
        />
      </div>

      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Switch id="create-package-signature" checked={requireSignature} onCheckedChange={setRequireSignature} />
          <Label htmlFor="create-package-signature" className="cursor-pointer">{t("packages:create.requireSignature")}</Label>
        </div>
        <p className="text-xs text-muted-foreground">{t("packages:create.requireSignatureHint")}</p>
      </div>

      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline">{t("common.cancel")}</Button>} />
        <Button type="submit" disabled={!canSubmit}>
          {mutation.isPending ? t("common.submitting") : t("packages:create.submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}
