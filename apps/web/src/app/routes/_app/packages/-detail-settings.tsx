import type { RegistryPackage } from "@/shared/lib/registry/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/shared/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/shared/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/components/ui/dialog";
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
import { deletePackage, updatePackage } from "@/shared/lib/registry/api";
import { registryErrorMessage } from "@/shared/lib/registry/errors";
import { registryKeys } from "@/shared/lib/registry/queries";
import { useInvalidatePackages } from "./-detail-shared";
import { displayNameError, MAX_DESCRIPTION_LENGTH, MAX_DISPLAY_NAME_LENGTH } from "./-detail-validate";

interface SettingsTabProps {
  readonly pkg: RegistryPackage;
  readonly canWrite: boolean;
}

/** Remount with a new `key` when the package changes: the form copies it into local state once. */
export function SettingsTab({ pkg, canWrite }: SettingsTabProps) {
  const { t } = useTranslation(["package", "common", "regerrors"]);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const invalidate = useInvalidatePackages();
  const [name, setName] = useState(pkg.name);
  const [description, setDescription] = useState(pkg.description ?? "");
  const [visibility, setVisibility] = useState(pkg.visibility);
  const [requireSignature, setRequireSignature] = useState(pkg.require_signature);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmSlug, setConfirmSlug] = useState("");

  const visibilityLabel = {
    public: t("package:visibility.public"),
    private: t("package:visibility.private"),
  };
  const nameErrorLabel = {
    empty: t("package:validation.empty"),
    tooLong: t("package:validation.tooLong", { max: MAX_DISPLAY_NAME_LENGTH }),
  };
  const nameError = displayNameError(name);
  const dirty = name.trim() !== pkg.name
    || description.trim() !== (pkg.description ?? "")
    || visibility !== pkg.visibility
    || requireSignature !== pkg.require_signature;

  const onError = (err: unknown) =>
    toast.error(registryErrorMessage(err, t, t("common:common.error.operationFailed")));

  const save = useMutation({
    mutationFn: () => updatePackage(pkg.namespace, pkg.slug, {
      name: name.trim(),
      description: description.trim() || null,
      visibility,
      require_signature: requireSignature,
    }),
    onSuccess: async (updated) => {
      toast.success(t("package:settings.saved"));
      queryClient.setQueryData(registryKeys.package(pkg.namespace, pkg.slug), updated);
      await invalidate();
    },
    onError,
  });

  const remove = useMutation({
    mutationFn: () => deletePackage(pkg.namespace, pkg.slug),
    onSuccess: async () => {
      toast.success(t("package:settings.danger.deleted", { slug: pkg.slug }));
      // Leave first: refetching the deleted package while this page is
      // still mounted would flash its not-found state.
      await navigate({ to: "/packages" });
      queryClient.removeQueries({
        queryKey: registryKeys.package(pkg.namespace, pkg.slug),
      });
      await invalidate();
    },
    onError,
  });

  return (
    <div className="max-w-2xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t("package:settings.general")}</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (canWrite && dirty && !nameError)
                save.mutate();
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="package-slug">{t("package:settings.slug")}</Label>
              <Input id="package-slug" className="font-mono" value={pkg.slug} readOnly disabled />
              <p className="text-xs text-muted-foreground">{t("package:settings.slugHint")}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="package-name">{t("package:settings.name")}</Label>
              <Input
                id="package-name"
                value={name}
                disabled={!canWrite}
                aria-invalid={nameError !== undefined}
                onChange={e => setName(e.target.value)}
              />
              {nameError && <p className="text-xs text-destructive">{nameErrorLabel[nameError]}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="package-description">{t("package:settings.description")}</Label>
              <Textarea
                id="package-description"
                value={description}
                maxLength={MAX_DESCRIPTION_LENGTH}
                disabled={!canWrite}
                onChange={e => setDescription(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="settings-visibility">{t("package:settings.visibility")}</Label>
              <Select
                value={visibility}
                disabled={!canWrite}
                onValueChange={(v) => {
                  if (v !== null)
                    setVisibility(v);
                }}
              >
                <SelectTrigger id="settings-visibility" className="min-w-40">
                  <SelectValue>{(v: RegistryPackage["visibility"]) => visibilityLabel[v]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="public">{visibilityLabel.public}</SelectItem>
                  <SelectItem value="private">{visibilityLabel.private}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t("package:settings.visibilityHint")}</p>
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Switch
                  id="package-require-signature"
                  checked={requireSignature}
                  disabled={!canWrite}
                  onCheckedChange={setRequireSignature}
                />
                <Label htmlFor="package-require-signature">{t("package:settings.requireSignature")}</Label>
              </div>
              <p className="text-xs text-muted-foreground">{t("package:settings.requireSignatureHint")}</p>
            </div>
            {canWrite && (
              <Button type="submit" disabled={save.isPending || !dirty || nameError !== undefined}>
                {save.isPending
                  ? t("common:common.saving")
                  : t("common:common.save")}
              </Button>
            )}
          </form>
        </CardContent>
      </Card>

      {canWrite && (
        <Card className="border-destructive/50">
          <CardHeader>
            <CardTitle className="text-destructive">{t("package:settings.danger.title")}</CardTitle>
            <CardDescription>{t("package:settings.danger.description")}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmSlug("");
                setDeleteOpen(true);
              }}
            >
              {t("package:settings.danger.button")}
            </Button>
          </CardContent>
        </Card>
      )}

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <form
            className="contents"
            onSubmit={(e) => {
              e.preventDefault();
              if (confirmSlug === pkg.slug)
                remove.mutate();
            }}
          >
            <DialogHeader>
              <DialogTitle>{t("package:settings.danger.confirmTitle", { slug: pkg.slug })}</DialogTitle>
              <DialogDescription>{t("package:settings.danger.description")}</DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="package-delete-confirm">
                {t("package:settings.danger.confirmLabel", { slug: pkg.slug })}
              </Label>
              <Input
                id="package-delete-confirm"
                className="font-mono"
                value={confirmSlug}
                autoComplete="off"
                onChange={e => setConfirmSlug(e.target.value)}
              />
            </div>
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline">{t("common:common.cancel")}</Button>} />
              <Button type="submit" variant="destructive" disabled={remove.isPending || confirmSlug !== pkg.slug}>
                {t("package:settings.danger.button")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
