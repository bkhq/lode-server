import type { QuotaFormErrors, QuotaFormValues, SizeUnit, SizeValue } from "./-quota-form";
import type { Owner, UserQuota } from "@/shared/lib/registry/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
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
import { adminSetUserQuota } from "@/shared/lib/registry/api";
import { registryErrorMessage } from "@/shared/lib/registry/errors";
import { formatBytes } from "@/shared/lib/registry/format";
import { adminUserQuotaQuery, registryKeys } from "@/shared/lib/registry/queries";
import { ownerLabel } from "./-owner-label";
import { fromOverride, toOverride } from "./-quota-form";

/** Usage, effective limits and the editable override of one user; `user` null keeps it closed. */
export function QuotaDialog({ user, onClose }: { readonly user: Owner | null; readonly onClose: () => void }) {
  const { t } = useTranslation(["common", "registry"]);
  return (
    <Dialog
      open={user !== null}
      onOpenChange={(open) => {
        if (!open)
          onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("registry:quota.title")}</DialogTitle>
          <DialogDescription>
            {user
              ? t("registry:quota.description", {
                  owner: ownerLabel(user),
                })
              : null}
          </DialogDescription>
        </DialogHeader>
        {user && <QuotaLoader userId={user.id} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function QuotaLoader({ userId, onClose }: { readonly userId: string; readonly onClose: () => void }) {
  const { t } = useTranslation(["common", "registry", "regerrors"]);
  // Nothing is kept after closing and nothing refetches under the form: every
  // opening loads the current override once and the form starts from it.
  const { data, error } = useQuery({
    ...adminUserQuotaQuery(userId),
    gcTime: 0,
    refetchOnWindowFocus: false,
  });

  if (data)
    return <QuotaEditor quota={data} onClose={onClose} />;
  return (
    <>
      {error
        ? <ErrorBanner message={registryErrorMessage(error, t, t("common.error.loadFailed"))} />
        : <p className="py-6 text-center text-sm text-muted-foreground">{t("common.loading")}</p>}
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline">{t("common.close")}</Button>} />
      </DialogFooter>
    </>
  );
}

function QuotaEditor({ quota, onClose }: { readonly quota: UserQuota; readonly onClose: () => void }) {
  const { t } = useTranslation(["common", "registry", "regerrors"]);
  const queryClient = useQueryClient();
  const [values, setValues] = useState<QuotaFormValues>(() => fromOverride(quota.override));
  const [errors, setErrors] = useState<QuotaFormErrors>({});
  const packagesId = useId();

  const mutation = useMutation({
    mutationFn: (override: Parameters<typeof adminSetUserQuota>[1]) => adminSetUserQuota(quota.user_id, override),
    onSuccess: () => {
      toast.success(t("registry:quota.saved"));
      void queryClient.invalidateQueries({
        queryKey: registryKeys.adminUserQuota(quota.user_id),
      });
      onClose();
    },
  });

  const set = (patch: Partial<QuotaFormValues>) => {
    setValues(v => ({
      ...v,
      ...patch,
    }));
    setErrors({});
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const result = toOverride(values);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    mutation.mutate(result.override);
  };

  const invalid = t("registry:quota.invalid");

  return (
    <form onSubmit={submit} className="space-y-4">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border px-3 py-2 text-sm">
        <dt className="text-muted-foreground">{t("registry:quota.packages")}</dt>
        <dd>{t("registry:quota.usedOf", { used: quota.usage.packages, limit: quota.limits.max_packages })}</dd>
        <dt className="text-muted-foreground">{t("registry:quota.storage")}</dt>
        <dd>
          {t("registry:quota.usedOf", {
            used: formatBytes(quota.usage.storage_bytes),
            limit: formatBytes(quota.limits.max_storage_bytes),
          })}
        </dd>
        <dt className="text-muted-foreground">{t("registry:quota.asset")}</dt>
        <dd>
          {t("registry:quota.upTo", {
            limit: formatBytes(quota.limits.max_asset_bytes),
          })}
        </dd>
      </dl>

      <p className="text-sm text-muted-foreground">{t("registry:quota.hint")}</p>

      <div className="space-y-1.5">
        <Label htmlFor={packagesId}>{t("registry:quota.maxPackages")}</Label>
        <Input
          id={packagesId}
          inputMode="numeric"
          placeholder={t("registry:quota.platformDefault")}
          value={values.maxPackages}
          aria-invalid={errors.maxPackages !== undefined}
          onChange={e => set({ maxPackages: e.target.value })}
        />
        {errors.maxPackages && <p className="text-xs text-destructive">{invalid}</p>}
      </div>

      <SizeField
        label={t("registry:quota.maxStorage")}
        value={values.maxStorage}
        onChange={maxStorage => set({ maxStorage })}
        error={errors.maxStorage && invalid}
      />

      <SizeField
        label={t("registry:quota.maxAsset")}
        value={values.maxAsset}
        onChange={maxAsset => set({ maxAsset })}
        hint={t("registry:quota.assetHint")}
        error={errors.maxAsset && (errors.maxAsset === "assetTooLarge"
          ? t("registry:quota.assetTooLarge")
          : t("registry:quota.assetInvalid"))}
      />

      <ErrorBanner message={mutation.error
        ? registryErrorMessage(mutation.error, t, t("common.error.saveFailed"))
        : null}
      />

      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline">{t("common.cancel")}</Button>} />
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending
            ? t("common.saving")
            : t("common.save")}
        </Button>
      </DialogFooter>
    </form>
  );
}

const INPUT_UNITS: readonly SizeUnit[] = ["MiB", "GiB"];

function SizeField({
  label,
  value,
  onChange,
  hint,
  error,
}: {
  readonly label: string;
  readonly value: SizeValue;
  readonly onChange: (value: SizeValue) => void;
  readonly hint?: string | undefined;
  readonly error?: string | undefined;
}) {
  const { t } = useTranslation(["common", "registry"]);
  const id = useId();
  // Bytes are listed only while a stored limit needs them to be shown exactly.
  const units = value.unit === "B"
    ? ["B" as const, ...INPUT_UNITS]
    : INPUT_UNITS;

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <Input
          id={id}
          inputMode="numeric"
          placeholder={t("registry:quota.platformDefault")}
          value={value.value}
          aria-invalid={error !== undefined}
          onChange={e => onChange({ ...value, value: e.target.value })}
        />
        <Select
          value={value.unit}
          onValueChange={(unit) => {
            if (unit !== null)
              onChange({ ...value, unit });
          }}
        >
          <SelectTrigger aria-label={t("registry:quota.unit")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {units.map(unit => <SelectItem key={unit} value={unit}>{unit}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      {error
        ? <p className="text-xs text-destructive">{error}</p>
        : hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
