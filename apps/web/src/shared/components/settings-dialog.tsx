import { Check, Copy, Loader2, Mail, Plus, Shield, ShieldAlert, Smartphone, Trash2, User as UserIcon, UsersRound } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiTokensTab } from "@/shared/components/api-tokens-tab";
import { Avatar, AvatarFallback } from "@/shared/components/ui/avatar";
import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/components/ui/dialog";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import { Separator } from "@/shared/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/components/ui/tabs";
import { formatDate } from "@/shared/lib/format";
import { http } from "@/shared/lib/http";
import { useAuthStore } from "@/shared/stores/auth";

function getInitials(name: string): string {
  return name
    .split(" ")
    .map(n => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["common", "settings", "totp"]);
  const { user } = useAuthStore();

  if (!user)
    return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("nav.settings")}</DialogTitle>
          <DialogDescription className="sr-only">{t("nav.settings")}</DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="profile">
          <TabsList variant="line">
            <TabsTrigger value="profile">{t("settings:tabProfile")}</TabsTrigger>
            <TabsTrigger value="security">{t("settings:tabSecurity")}</TabsTrigger>
            <TabsTrigger value="tokens">{t("settings:tabTokens")}</TabsTrigger>
          </TabsList>

          <TabsContent value="profile">
            <ProfileTab />
          </TabsContent>
          <TabsContent value="security">
            <TotpTab />
          </TabsContent>
          <TabsContent value="tokens">
            <ApiTokensTab />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function ProfileTab() {
  const { t } = useTranslation(["common", "settings", "totp"]);
  const { user } = useAuthStore();

  if (!user)
    return null;

  const profileItems = [
    { icon: UserIcon, label: t("settings:profile.username"), value: user.username },
    { icon: Mail, label: t("settings:profile.email"), value: user.email },
    { icon: Shield, label: t("settings:profile.role"), value: user.role === "admin" ? t("settings:profile.roleAdmin") : t("settings:profile.roleUser") },
    { icon: UsersRound, label: t("settings:profile.groups"), value: user.groups.map(g => g.name).join(", ") || "—" },
  ];

  return (
    <div className="space-y-4 pt-4">
      <div className="flex items-center gap-3">
        <Avatar className="size-12">
          <AvatarFallback className="bg-primary/10 text-primary text-lg font-medium">
            {getInitials(user.name)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <div className="font-medium truncate">{user.name}</div>
          <div className="text-xs text-muted-foreground truncate">{user.email}</div>
        </div>
      </div>

      <Separator />

      <div className="space-y-3">
        {profileItems.map(({ icon: Icon, label, value }) => (
          <div key={label} className="flex items-center gap-3 text-sm">
            <Icon className="size-4 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground w-16 shrink-0">{label}</span>
            <span className="truncate">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const RE_NON_DIGIT = /\D/g;

// ── TOTP Tab ──

interface TotpDevice {
  readonly id: string;
  readonly name: string;
  readonly verified: boolean;
  readonly createdAt: string;
}

interface SetupData {
  readonly id: string;
  readonly name: string;
  readonly secret: string;
  readonly uri: string;
  readonly qrCode: string;
}

function TotpTab() {
  const { t } = useTranslation(["common", "settings", "totp"]);
  const [devices, setDevices] = useState<TotpDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [addStep, setAddStep] = useState<"idle" | "name" | "verify">("idle");
  const [deviceName, setDeviceName] = useState("");
  const [setup, setSetup] = useState<SetupData | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const fetchDevices = useCallback(async () => {
    try {
      const res = await http<{ success: boolean; data: TotpDevice[] }>("/account/me/totp");
      setDevices(res.data);
    }
    catch { /* ignore */ }
    finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchDevices();
  }, [fetchDevices]);

  const resetAdd = () => {
    setAddStep("idle");
    setDeviceName("");
    setSetup(null);
    setCode("");
    setError(null);
    setSubmitting(false);
  };

  const handleCreate = async () => {
    if (!deviceName.trim())
      return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await http<{ success: boolean; data: SetupData }>("/account/me/totp", {
        method: "POST",
        body: JSON.stringify({ name: deviceName.trim() }),
      });
      setSetup(res.data);
      setAddStep("verify");
    }
    catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    }
    finally {
      setSubmitting(false);
    }
  };

  const handleVerify = async () => {
    if (!setup || code.length !== 6)
      return;
    setSubmitting(true);
    setError(null);
    try {
      await http(`/account/me/totp/${setup.id}/confirm`, {
        method: "POST",
        body: JSON.stringify({ code }),
      });
      resetAdd();
      void fetchDevices();
    }
    catch {
      setError(t("totp:verifyFailed"));
      setCode("");
    }
    finally {
      setSubmitting(false);
    }
  };

  const [deleteId, setDeleteId] = useState<string | null>(null);

  const confirmDelete = useCallback(async () => {
    if (!deleteId)
      return;
    await http(`/account/me/totp/${deleteId}`, { method: "DELETE" });
    setDevices(prev => prev.filter(d => d.id !== deleteId));
    setDeleteId(null);
  }, [deleteId]);

  if (loading) {
    return <div className="py-8 text-center text-sm text-muted-foreground">{t("common.loading")}</div>;
  }

  // Adding flow
  if (addStep === "name") {
    return (
      <div className="space-y-4 pt-4">
        <div className="space-y-2">
          <Label htmlFor="totp-name">{t("totp:deviceName")}</Label>
          <Input
            id="totp-name"
            value={deviceName}
            onChange={e => setDeviceName(e.target.value)}
            placeholder={t("totp:deviceNamePlaceholder")}
            onKeyDown={e => e.key === "Enter" && deviceName.trim() && void handleCreate()}
            autoFocus
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={resetAdd}>{t("totp:cancel")}</Button>
          <Button
            size="sm"
            onClick={() => void handleCreate()}
            disabled={!deviceName.trim() || submitting}
            aria-busy={submitting}
            className="min-w-[80px]"
          >
            {submitting
              ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    {t("common.submitting")}
                  </>
                )
              : t("common.next", "Next")}
          </Button>
        </div>
      </div>
    );
  }

  if (addStep === "verify" && setup) {
    return (
      <TotpVerifyStep
        setup={setup}
        code={code}
        onCodeChange={setCode}
        onVerify={() => void handleVerify()}
        onCancel={resetAdd}
        error={error}
        submitting={submitting}
      />
    );
  }

  // Device list
  return (
    <div className="space-y-3 pt-4">
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
        <div className="flex items-start gap-2 text-amber-600 dark:text-amber-400">
          <ShieldAlert className="size-4 shrink-0 mt-0.5" />
          <p className="text-xs">{t("totp:lostDevice")}</p>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          {t("totp:title")}
        </div>
        <Button variant="outline" size="sm" onClick={() => setAddStep("name")}>
          <Plus className="mr-1 size-3.5" />
          {t("totp:addDevice")}
        </Button>
      </div>

      {devices.length === 0
        ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{t("totp:noDevices")}</p>
          )
        : (
            <div className="space-y-2">
              {devices.map(device => (
                <div key={device.id} className="flex items-center justify-between rounded-lg border px-3 py-2.5">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Smartphone className="size-4 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{device.name}</div>
                      <div className="text-xs text-muted-foreground">{formatDate(device.createdAt)}</div>
                    </div>
                    <Badge variant={device.verified ? "default" : "secondary"} className="text-xs shrink-0">
                      {device.verified ? t("totp:verified") : t("totp:unverified")}
                    </Badge>
                  </div>
                  {deleteId === device.id
                    ? (
                        <div className="flex items-center gap-1">
                          <Button variant="destructive" size="sm" className="h-6 text-xs px-2" onClick={() => void confirmDelete()}>
                            {t("totp:delete")}
                          </Button>
                          <Button variant="ghost" size="sm" className="h-6 text-xs px-2" onClick={() => setDeleteId(null)}>
                            {t("totp:cancel")}
                          </Button>
                        </div>
                      )
                    : (
                        <Button variant="ghost" size="icon-xs" onClick={() => setDeleteId(device.id)}>
                          <Trash2 className="size-3.5 text-destructive" />
                        </Button>
                      )}
                </div>
              ))}
            </div>
          )}
    </div>
  );
}

function TotpVerifyStep({
  setup,
  code,
  onCodeChange,
  onVerify,
  onCancel,
  error,
  submitting,
}: {
  readonly setup: SetupData;
  readonly code: string;
  readonly onCodeChange: (v: string) => void;
  readonly onVerify: () => void;
  readonly onCancel: () => void;
  readonly error: string | null;
  readonly submitting: boolean;
}) {
  const { t } = useTranslation(["common", "settings", "totp"]);
  const [showSecret, setShowSecret] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(setup.secret).then(() => {
      setCopied(true);
      setTimeout(setCopied, 2000, false);
    });
  }, [setup.secret]);

  return (
    <div className="space-y-4 pt-4">
      <p className="text-sm text-muted-foreground">{t("totp:scanQr")}</p>
      <div className="flex justify-center">
        <img src={setup.qrCode} alt={t("totp:qrAlt")} className="size-48 rounded-lg" />
      </div>

      <button
        type="button"
        onClick={() => setShowSecret(!showSecret)}
        className="w-full text-center text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        {t("totp:cantScan")}
      </button>

      {showSecret && (
        <div className="rounded-lg border bg-muted/50 p-3 space-y-2">
          <p className="text-xs text-muted-foreground">{t("totp:manualEntry")}</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded bg-background px-2 py-1.5 text-xs font-mono tracking-wider select-all break-all">{setup.secret}</code>
            <Button variant="ghost" size="icon-xs" onClick={handleCopy} title={t("common.copy")}>
              {copied ? <Check className="size-3.5 text-green-600" /> : <Copy className="size-3.5" />}
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="totp-verify-code">{t("totp:verifyCode")}</Label>
        <Input
          id="totp-verify-code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={e => onCodeChange(e.target.value.replace(RE_NON_DIGIT, "").slice(0, 6))}
          onKeyDown={e => e.key === "Enter" && code.length === 6 && onVerify()}
          placeholder={t("totp:verifyCodePlaceholder")}
          className="text-center text-lg tracking-[0.5em] font-mono"
          autoFocus
        />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>{t("totp:cancel")}</Button>
        <Button
          size="sm"
          onClick={onVerify}
          disabled={code.length !== 6 || submitting}
          aria-busy={submitting}
          className="min-w-[80px]"
        >
          {submitting
            ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  {t("common.submitting")}
                </>
              )
            : t("totp:verify")}
        </Button>
      </div>
    </div>
  );
}
