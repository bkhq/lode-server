import { useState } from "react";
import { useTranslation } from "react-i18next";
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
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import { http, HttpError } from "@/shared/lib/http";

// Mirrors MIN/MAX_PASSWORD_LENGTH in the API's local-users.service.
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 128;

function useSubmit(onDone: () => void) {
  const { t } = useTranslation("users");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function run(action: () => Promise<unknown>) {
    setSubmitting(true);
    setError(null);
    try {
      await action();
      onDone();
    }
    catch (err) {
      setError(err instanceof HttpError && err.status === 409
        ? t("conflict")
        : err instanceof Error
          ? err.message
          : t("common.error.operationFailed"));
    }
    finally {
      setSubmitting(false);
    }
  }
  return { error, submitting, run };
}

export function AddUserDialog({ open, onOpenChange, onCreated }: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreated: () => void;
}) {
  const { t } = useTranslation("users");
  const [form, setForm] = useState({
    username: "",
    name: "",
    email: "",
    password: "",
  });
  const [admin, setAdmin] = useState(false);
  const { error, submitting, run } = useSubmit(() => {
    setForm({
      username: "",
      name: "",
      email: "",
      password: "",
    });
    setAdmin(false);
    onOpenChange(false);
    onCreated();
  });
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm(f => ({ ...f, [key]: e.target.value }));
  const valid = form.username.trim().length >= 2 && form.name.trim() !== "" && form.email.includes("@")
    && form.password.length >= MIN_PASSWORD_LENGTH && form.password.length <= MAX_PASSWORD_LENGTH;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => http("/account/users", {
              method: "POST",
              body: JSON.stringify({
                ...form,
                username: form.username.trim(),
                name: form.name.trim(),
                email: form.email.trim(),
                role: admin ? "admin" : "user",
              }),
            }));
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("addUserTitle")}</DialogTitle>
            <DialogDescription>{t("addUserDescription")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-4">
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="space-y-1.5">
              <Label htmlFor="new-username">{t("col.username")}</Label>
              <Input id="new-username" autoComplete="off" value={form.username} onChange={set("username")} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-name">{t("col.name")}</Label>
              <Input id="new-name" value={form.name} onChange={set("name")} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-email">{t("col.email")}</Label>
              <Input id="new-email" type="email" value={form.email} onChange={set("email")} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-password">{t("password")}</Label>
              <Input id="new-password" type="password" autoComplete="new-password" value={form.password} onChange={set("password")} required />
              <p className="text-xs text-muted-foreground">{t("passwordHint", { min: MIN_PASSWORD_LENGTH })}</p>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={admin} onChange={e => setAdmin(e.target.checked)} />
              {t("makeAdmin")}
            </label>
          </div>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline">{t("common.cancel")}</Button>} />
            <Button type="submit" disabled={!valid || submitting}>{t("addUser")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function SetPasswordDialog({ user, onClose }: {
  readonly user: { readonly id: string; readonly name: string } | null;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation("users");
  const [password, setPassword] = useState("");
  const { error, submitting, run } = useSubmit(() => {
    setPassword("");
    onClose();
  });
  const valid = password.length >= MIN_PASSWORD_LENGTH && password.length <= MAX_PASSWORD_LENGTH;

  return (
    <Dialog
      open={user !== null}
      onOpenChange={(open) => {
        if (!open) {
          setPassword("");
          onClose();
        }
      }}
    >
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (user) {
              void run(() => http(`/account/users/${user.id}/password`, {
                method: "POST",
                body: JSON.stringify({ password }),
              }));
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("setPasswordTitle")}</DialogTitle>
            <DialogDescription>{t("setPasswordDescription", { name: user?.name })}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-4">
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="space-y-1.5">
              <Label htmlFor="reset-password">{t("password")}</Label>
              <Input id="reset-password" type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} required />
              <p className="text-xs text-muted-foreground">{t("passwordHint", { min: MIN_PASSWORD_LENGTH })}</p>
            </div>
          </div>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline">{t("common.cancel")}</Button>} />
            <Button type="submit" disabled={!valid || submitting}>{t("setPassword")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
