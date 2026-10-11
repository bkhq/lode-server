/* eslint-disable react-refresh/only-export-components */
import { deriveKeyPairFromPassword, generateSalt } from "@app/shared";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Copy, Download, KeyRound, Shield } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Logo } from "@/shared/components/logo";
import { Button } from "@/shared/components/ui/button";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import { Textarea } from "@/shared/components/ui/textarea";
import { APP_NAME } from "@/shared/lib/branding";
import { http } from "@/shared/lib/http";

export const Route = createFileRoute("/(encryption)/setup")({
  staticData: { titleKey: "encryption:setup.title" },
  component: SetupPage,
});

interface EncryptionStatusResponse {
  success: boolean;
  data: {
    initialized: boolean;
    status: string;
    finalized?: boolean;
  };
}

const PENDING_KEY_STORAGE = `${APP_NAME}-pending-recovery-key`;
const KEY_FILENAME = `${APP_NAME}-master-key.txt`;

// Mid-flow recovery is bounded to a 10-minute window. The master private
// key has to live somewhere visible to scripts to survive a reload between
// "derived" and "user confirmed export", but persisting it indefinitely
// would leave the recovery key in sessionStorage for the whole tab session
// if a setup is started and never finished. After this TTL the cached
// bundle is dropped on the next page load and the user re-derives.
const PENDING_KEY_TTL_MS = 10 * 60 * 1000;

interface PendingKeyBundle {
  readonly key: string;
  readonly savedAt: number;
}

function loadPendingKey(): string | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY_STORAGE);
    if (!raw)
      return null;
    const parsed = JSON.parse(raw) as Partial<PendingKeyBundle>;
    if (typeof parsed.key !== "string" || typeof parsed.savedAt !== "number") {
      sessionStorage.removeItem(PENDING_KEY_STORAGE);
      return null;
    }
    if (Date.now() - parsed.savedAt > PENDING_KEY_TTL_MS) {
      // Expired — clear so the user re-derives instead of seeing a stale key.
      sessionStorage.removeItem(PENDING_KEY_STORAGE);
      return null;
    }
    return parsed.key;
  }
  catch {
    return null;
  }
}

function savePendingKey(key: string): void {
  try {
    const bundle: PendingKeyBundle = { key, savedAt: Date.now() };
    sessionStorage.setItem(PENDING_KEY_STORAGE, JSON.stringify(bundle));
  }
  catch {
    // ignore — sessionStorage may be unavailable
  }
}

function clearPendingKey(): void {
  try {
    sessionStorage.removeItem(PENDING_KEY_STORAGE);
  }
  catch {
    // ignore
  }
}

function SetupPage() {
  const { t } = useTranslation(["common", "encryption"]);
  const navigate = useNavigate();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [bootstrapToken, setBootstrapToken] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [backupKey, setBackupKey] = useState("");
  const [keyVisible, setKeyVisible] = useState(true);
  const [copied, setCopied] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [hasExported, setHasExported] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  // Cache the key in a ref so "Show key again" works even after we clear
  // the visible state on finalize.
  const backupKeyRef = useRef("");

  useEffect(() => {
    http<EncryptionStatusResponse>("/encryption/status")
      .then((res) => {
        const { initialized, status, finalized } = res.data;
        // Re-show step 2 if the user reloaded mid-flow (initialized but not
        // finalized) and we still have the cached key locally.
        if (initialized && finalized === false) {
          const cached = loadPendingKey();
          if (cached) {
            backupKeyRef.current = cached;
            setBackupKey(cached);
            setStep(2);
            setChecking(false);
            return;
          }
        }
        if (initialized) {
          void navigate({ to: status === "locked" ? "/unlock" : "/" });
        }
        setChecking(false);
      })
      .catch(() => setChecking(false));
  }, [navigate]);

  const passwordValid = bootstrapToken.length > 0 && password.length >= 12 && password === passwordConfirm;

  const handleDerive = useCallback(async () => {
    if (!passwordValid)
      return;
    setLoading(true);
    setError(null);
    try {
      const salt = generateSalt();
      const kp = await deriveKeyPairFromPassword(password, salt);

      // Send public key + salt to server, initialize encryption
      await http("/encryption/init", {
        method: "POST",
        body: JSON.stringify({ bootstrapToken, publicKey: kp.publicKey, kdfSalt: salt }),
      });

      backupKeyRef.current = kp.privateKey;
      setBackupKey(kp.privateKey);
      // Mirror to sessionStorage so a reload mid-flow does not lose the
      // recovery key; cleared explicitly when the user clicks Continue.
      savePendingKey(kp.privateKey);
      setKeyVisible(true);
      setHasExported(false);
      setDownloaded(false);
      setCopied(false);
      setConfirmed(false);
      setStep(2);
    }
    catch (err) {
      setError(err instanceof Error ? err.message : t("encryption:setup.initFailed"));
    }
    finally {
      setLoading(false);
    }
  }, [bootstrapToken, password, passwordValid, t]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(backupKeyRef.current).then(() => {
      setCopied(true);
      setHasExported(true);
      setTimeout(setCopied, 2000, false);
    });
  }, []);

  const handleDownload = useCallback(() => {
    const blob = new Blob([backupKeyRef.current], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = KEY_FILENAME;
    a.click();
    URL.revokeObjectURL(url);
    setDownloaded(true);
    setHasExported(true);
  }, []);

  const handleFinalize = useCallback(() => {
    // Hide the key from the rendered textarea but keep the ref alive so
    // "Show key again" still works until the user explicitly continues.
    // Drop the sessionStorage copy here — the user has confirmed export, so
    // there is no longer any reason to survive a reload with the key on
    // disk in browser-readable storage. The ref keeps the value available
    // for the remaining UI affordances of step 3.
    setBackupKey("");
    setKeyVisible(false);
    clearPendingKey();
    setStep(3);
  }, []);

  const handleContinue = useCallback(() => {
    // Explicit user action — clear all sensitive material and the cached
    // recovery key from sessionStorage before redirecting to login.
    backupKeyRef.current = "";
    setBackupKey("");
    setPassword("");
    setPasswordConfirm("");
    clearPendingKey();
    navigator.clipboard.writeText("").catch(() => {});
    void navigate({ to: "/login", search: { redirect: undefined } });
  }, [navigate]);

  const handleShowKey = useCallback(() => {
    setBackupKey(backupKeyRef.current);
    setKeyVisible(true);
  }, []);

  if (checking) {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <div className="text-muted-foreground">{t("common.loading", "Loading...")}</div>
      </div>
    );
  }

  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-background p-4">
      <div className="mx-auto w-full max-w-md">
        <div className="mb-8 text-center">
          <Logo className="mx-auto size-10 mb-3" />
          <h1 className="text-2xl font-bold tracking-tight">
            {t("encryption:setup.title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("encryption:setup.description")}
          </p>
        </div>

        <div className="mb-6 flex items-center justify-center gap-2">
          {[1, 2, 3].map(s => (
            <div
              key={s}
              className={`size-2 rounded-full transition-colors ${s <= step ? "bg-primary" : "bg-muted-foreground/30"}`}
            />
          ))}
        </div>

        {step === 1 && (
          <div className="space-y-4">
            <div className="mx-auto flex size-16 items-center justify-center rounded-2xl bg-primary/10">
              <KeyRound className="size-8 text-primary" />
            </div>
            <div className="text-center">
              <h2 className="font-semibold">{t("encryption:setup.step1.title")}</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("encryption:setup.step1.description")}
              </p>
            </div>
            <div className="space-y-3">
              <div>
                <Label className="mb-1">
                  {t("encryption:setup.step1.bootstrapToken")}
                </Label>
                <Input
                  type="password"
                  name="bootstrap-token"
                  autoComplete="off"
                  spellCheck={false}
                  value={bootstrapToken}
                  onChange={e => setBootstrapToken(e.target.value)}
                  placeholder={t("encryption:setup.step1.bootstrapTokenPlaceholder")}
                  className="font-mono"
                />
                <p className="mt-1 text-xs text-muted-foreground">{t("encryption:setup.step1.bootstrapTokenHint")}</p>
              </div>
              <div>
                <Label className="mb-1">
                  {t("encryption:setup.step1.password")}
                </Label>
                <Input
                  type="password"
                  name="master-password"
                  autoComplete="new-password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder={t("encryption:setup.step1.passwordPlaceholder")}
                />
                {password.length > 0 && password.length < 12 && (
                  <p className="mt-1 text-xs text-destructive">{t("encryption:setup.step1.passwordTooShort")}</p>
                )}
              </div>
              <div>
                <Label className="mb-1">
                  {t("encryption:setup.step1.passwordConfirm")}
                </Label>
                <Input
                  type="password"
                  name="master-password-confirm"
                  autoComplete="new-password"
                  value={passwordConfirm}
                  onChange={e => setPasswordConfirm(e.target.value)}
                  placeholder={t("encryption:setup.step1.passwordConfirmPlaceholder")}
                />
                {passwordConfirm.length > 0 && password !== passwordConfirm && (
                  <p className="mt-1 text-xs text-destructive">{t("encryption:setup.step1.passwordMismatch")}</p>
                )}
              </div>
            </div>

            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

            <Button onClick={() => void handleDerive()} disabled={!passwordValid || loading} className="w-full">
              {loading ? t("encryption:setup.generating") : t("encryption:setup.step1.button")}
            </Button>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
              <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
                <Shield className="size-4 shrink-0" />
                <span className="text-sm font-medium">{t("encryption:setup.step2.warning")}</span>
              </div>
              <p className="mt-1 ml-6 text-xs text-muted-foreground">
                {t("encryption:setup.step2.warningDetail")}
              </p>
            </div>

            <div>
              <Label className="mb-1">
                {t("encryption:setup.step2.label")}
              </Label>
              <div className="relative">
                {keyVisible
                  ? (
                      <Textarea
                        readOnly
                        value={backupKey}
                        className="h-20 min-h-0 resize-none bg-muted/50 font-mono text-xs break-all"
                      />
                    )
                  : (
                      <button
                        type="button"
                        onClick={handleShowKey}
                        className="flex h-20 w-full items-center justify-center rounded-md border bg-muted/50 text-xs text-muted-foreground hover:bg-muted"
                      >
                        {t("encryption:setup.step2.showKey")}
                      </button>
                    )}
                {keyVisible && (
                  <div className="absolute right-1 top-1 flex gap-1">
                    <Button variant="ghost" size="icon-xs" onClick={handleCopy}>
                      <Copy className="size-3" />
                    </Button>
                    <Button variant="ghost" size="icon-xs" onClick={handleDownload}>
                      <Download className="size-3" />
                    </Button>
                  </div>
                )}
              </div>
              {downloaded && (
                <p className="mt-1 text-xs text-green-600">
                  {t("encryption:setup.downloaded", { filename: KEY_FILENAME })}
                </p>
              )}
              {copied && (
                <p className="mt-1 text-xs text-green-600">{t("encryption:setup.step2.copied")}</p>
              )}
              {!hasExported && (
                <p id="setup-export-required" className="mt-1 text-xs text-muted-foreground">
                  {t("encryption:setup.step2.exportRequired")}
                </p>
              )}
            </div>

            <Label htmlFor="setup-confirm-saved" className="flex items-center gap-2">
              <input
                id="setup-confirm-saved"
                type="checkbox"
                checked={confirmed}
                onChange={e => setConfirmed(e.target.checked)}
                disabled={!hasExported}
                aria-describedby={!hasExported ? "setup-export-required" : undefined}
                className="size-4 rounded border"
              />
              <span>{t("encryption:setup.step2.confirm")}</span>
            </Label>

            <Button onClick={handleFinalize} disabled={!confirmed || !hasExported} className="w-full">
              {t("encryption:setup.step2.finalize")}
            </Button>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4 text-center">
            <div className="mx-auto flex size-16 items-center justify-center rounded-2xl bg-green-500/10">
              <Shield className="size-8 text-green-600" />
            </div>
            <div>
              <h2 className="font-semibold">{t("encryption:setup.step3.title")}</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("encryption:setup.step3.description")}
              </p>
            </div>
            <Button onClick={handleContinue} className="w-full">
              {t("encryption:setup.continueToLogin")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
