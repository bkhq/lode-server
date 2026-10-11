/* eslint-disable react-refresh/only-export-components */
import { bytesToHex, deriveKeyPairFromPassword, eciesDecrypt, eciesEncrypt, hexToBytes } from "@app/shared";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { KeyRound, Lock, Unlock } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Logo } from "@/shared/components/logo";
import { Button } from "@/shared/components/ui/button";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import { Textarea } from "@/shared/components/ui/textarea";
import { APP_NAME } from "@/shared/lib/branding";
import { BASE_PATH, http, HttpError } from "@/shared/lib/http";
import { useSystemStore } from "@/shared/stores/system";

// Cache the unlock-challenge bundle in sessionStorage so React StrictMode's
// double-mount in dev and casual page reloads don't burn through the per-IP
// rate limit on /encryption/unlock-challenge. The cached challenge has a
// 5-minute server-side TTL; we drop our copy after it's consumed (success or
// definitive failure).
const CHALLENGE_CACHE_KEY = `${APP_NAME}:unlock-challenge:v1`;

interface CachedBundle {
  readonly challenge: { challengeId: string; ephemeralPublicKey: string };
  readonly encryptedDek: string;
  readonly kdfSalt: string | null;
}

function loadCachedChallenge(): CachedBundle | null {
  try {
    const raw = sessionStorage.getItem(CHALLENGE_CACHE_KEY);
    if (!raw)
      return null;
    return JSON.parse(raw) as CachedBundle;
  }
  catch {
    return null;
  }
}

function saveCachedChallenge(bundle: CachedBundle): void {
  try {
    sessionStorage.setItem(CHALLENGE_CACHE_KEY, JSON.stringify(bundle));
  }
  catch {
    // sessionStorage may be unavailable (private mode); accept the rate-budget cost.
  }
}

function clearCachedChallenge(): void {
  try {
    sessionStorage.removeItem(CHALLENGE_CACHE_KEY);
  }
  catch {
    // ignore
  }
}

function unlockBundleErrorMessage(err: unknown, t: (key: string) => string): string {
  if (err instanceof HttpError) {
    if (err.status === 429)
      return t("encryption:unlock.rateLimited");
    if (err.code === "DB_ERROR" || err.status === 503)
      return t("encryption:unlock.systemUnavailable");
    if (err.code === "NO_META")
      return t("encryption:unlock.metaMissing");
    if (err.code === "NOT_LOCKED")
      return t("encryption:unlock.notLocked");
    return err.message || t("encryption:unlock.invalidKey");
  }
  return err instanceof Error ? err.message : t("encryption:unlock.invalidKey");
}

export const Route = createFileRoute("/(encryption)/unlock")({
  staticData: { titleKey: "encryption:unlock.title" },
  component: UnlockPage,
});

interface EncryptionStatusResponse {
  success: boolean;
  data: {
    initialized: boolean;
    locked: boolean;
    status: string;
  };
}

interface UnlockChallengeResponse {
  success: boolean;
  data: {
    challenge: { challengeId: string; ephemeralPublicKey: string };
    encryptedDek: string;
    kdfSalt: string | null;
  };
}

type UnlockMode = "password" | "keyfile";

function UnlockPage() {
  const { t } = useTranslation(["common", "encryption"]);
  const navigate = useNavigate();
  const [mode, setMode] = useState<UnlockMode>("password");
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bundleError, setBundleError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [encryptedDek, setEncryptedDek] = useState<string | null>(null);
  const [kdfSalt, setKdfSalt] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<{ challengeId: string; ephemeralPublicKey: string } | null>(null);
  // Per-IP rate-limit cooldown surfaced from the server's Retry-After header.
  // Disables the unlock button and renders a live countdown so users don't
  // click-spam — every attempt while limited bumps the auth bucket too.
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null);
  const [cooldownNow, setCooldownNow] = useState<number>(() => Date.now());

  const loadBundle = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setChecking(true);
    setBundleError(null);
    try {
      const status = await http<EncryptionStatusResponse>("/encryption/status");
      if (signal?.aborted)
        return;
      if (!status.data.initialized) {
        void navigate({ to: "/setup" });
        return;
      }
      if (!status.data.locked) {
        clearCachedChallenge();
        void navigate({ to: "/overview" });
        return;
      }

      const cached = loadCachedChallenge();
      if (cached) {
        setEncryptedDek(cached.encryptedDek);
        setKdfSalt(cached.kdfSalt);
        setChallenge(cached.challenge);
        if (!cached.kdfSalt)
          setMode("keyfile");
        return;
      }

      const ch = await http<UnlockChallengeResponse>("/encryption/unlock-challenge", { method: "POST" });
      if (signal?.aborted)
        return;
      const bundle: CachedBundle = {
        challenge: ch.data.challenge,
        encryptedDek: ch.data.encryptedDek,
        kdfSalt: ch.data.kdfSalt,
      };
      saveCachedChallenge(bundle);
      setEncryptedDek(bundle.encryptedDek);
      setKdfSalt(bundle.kdfSalt);
      setChallenge(bundle.challenge);
      if (!bundle.kdfSalt)
        setMode("keyfile");
    }
    catch (err) {
      if (signal?.aborted)
        return;
      setBundleError(unlockBundleErrorMessage(err, t));
    }
    finally {
      if (!signal?.aborted)
        setChecking(false);
    }
  }, [navigate, t]);

  useEffect(() => {
    const ac = new AbortController();
    void loadBundle(ac.signal);
    return () => ac.abort();
  }, [loadBundle]);

  useEffect(() => {
    if (cooldownUntil === null)
      return undefined;
    const id = window.setInterval(() => {
      const now = Date.now();
      setCooldownNow(now);
      if (now >= cooldownUntil)
        setCooldownUntil(null);
    }, 1000);
    return () => window.clearInterval(id);
  }, [cooldownUntil]);

  const cooldownSeconds = cooldownUntil !== null
    ? Math.max(0, Math.ceil((cooldownUntil - cooldownNow) / 1000))
    : 0;

  const handleUnlock = useCallback(async () => {
    if (!encryptedDek || !challenge)
      return;
    if (mode === "password" && (!password.trim() || !kdfSalt))
      return;
    if (mode !== "password" && !privateKey.trim())
      return;
    setLoading(true);
    setError(null);

    try {
      // Resolve the private key based on mode
      let resolvedPrivKey: string;
      if (mode === "password") {
        const kp = await deriveKeyPairFromPassword(password, kdfSalt!);
        resolvedPrivKey = kp.privateKey;
      }
      else {
        resolvedPrivKey = privateKey.trim();
      }

      // Step 1: Decrypt DEK with master private key
      const encryptedBytes = hexToBytes(encryptedDek);
      const dekBytes = await eciesDecrypt(resolvedPrivKey, encryptedBytes);

      // Step 2: Re-encrypt DEK with server's ephemeral public key
      const reEncrypted = await eciesEncrypt(challenge.ephemeralPublicKey, dekBytes);
      const reEncryptedHex = bytesToHex(reEncrypted);

      // Step 3: Send re-encrypted DEK to server
      await http("/encryption/unlock", {
        method: "POST",
        body: JSON.stringify({
          challengeId: challenge.challengeId,
          encryptedDek: reEncryptedHex,
        }),
      });

      // Successful unlock — drop the challenge cache so the next page load
      // doesn't try to reuse a one-shot bundle that the server has consumed.
      clearCachedChallenge();

      // Refresh system status so __root.tsx knows we're unlocked
      await useSystemStore.getState().fetchStatus();
      window.location.href = `${BASE_PATH}/login`;
    }
    catch (err) {
      // INVALID_CHALLENGE means the cached challenge has been consumed or
      // expired; drop the cache and ask the user to retry. Other errors keep
      // the cache so retries don't cost a fresh challenge.
      if (err instanceof HttpError && err.code === "INVALID_CHALLENGE") {
        clearCachedChallenge();
      }
      // 429 + Retry-After → arm the visible countdown. Without a header we
      // fall back to the limiter's window (15 min) so the UI still discourages
      // the user from spamming Unlock and burning the bucket.
      if (err instanceof HttpError && err.status === 429) {
        const seconds = err.retryAfter ?? 15 * 60;
        setCooldownUntil(Date.now() + seconds * 1000);
      }
      setError(unlockBundleErrorMessage(err, t));
    }
    finally {
      setLoading(false);
      setPassword("");
      setPrivateKey("");
    }
  }, [mode, password, privateKey, encryptedDek, kdfSalt, challenge, t]);

  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file)
      return;
    const reader = new FileReader();
    reader.onload = () => {
      setPrivateKey((reader.result as string).trim());
    };
    reader.readAsText(file);
  }, []);

  const canSubmit = mode === "password" ? password.trim().length > 0 : privateKey.trim().length > 0;
  const bundleReady = encryptedDek != null && challenge != null;

  if (checking) {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <div className="text-muted-foreground">{t("common.loading", "Loading...")}</div>
      </div>
    );
  }

  if (bundleError && !bundleReady) {
    return (
      <div className="flex min-h-svh flex-col items-center justify-center bg-background p-4">
        <div className="mx-auto w-full max-w-md text-center space-y-4">
          <Logo className="mx-auto size-10" />
          <div className="mx-auto flex size-16 items-center justify-center rounded-2xl bg-destructive/10">
            <Lock className="size-8 text-destructive" />
          </div>
          <h1 className="text-xl font-bold">{t("encryption:unlock.title")}</h1>
          <p className="text-sm text-destructive">{bundleError}</p>
          <Button onClick={() => void loadBundle()}>{t("common.retry")}</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-background p-4">
      <div className="mx-auto w-full max-w-md">
        <div className="mb-8 text-center">
          <Logo className="mx-auto size-10 mb-3" />
          <div className="mx-auto mb-3 flex size-16 items-center justify-center rounded-2xl bg-amber-500/10">
            <Lock className="size-8 text-amber-600" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">
            {t("encryption:unlock.title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("encryption:unlock.description")}
          </p>
        </div>

        <div className="space-y-4">
          {/* Mode toggle — only show if KDF salt exists (password was set during setup) */}
          {kdfSalt && (
            <div className="flex rounded-lg border p-0.5">
              <Button
                type="button"
                variant={mode === "password" ? "default" : "ghost"}
                size="sm"
                onClick={() => setMode("password")}
                className="flex-1"
              >
                {t("encryption:unlock.modePassword")}
              </Button>
              <Button
                type="button"
                variant={mode === "keyfile" ? "default" : "ghost"}
                size="sm"
                onClick={() => setMode("keyfile")}
                className="flex-1"
              >
                {t("encryption:unlock.modeKeyFile")}
              </Button>
            </div>
          )}

          {mode === "password"
            ? (
                <div>
                  <Label className="mb-1">
                    {t("encryption:unlock.passwordLabel")}
                  </Label>
                  <Input
                    type="password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder={t("encryption:unlock.passwordPlaceholder")}
                    onKeyDown={e => e.key === "Enter" && canSubmit && bundleReady && void handleUnlock()}
                    disabled={!bundleReady}
                  />
                </div>
              )
            : (
                <>
                  <div>
                    <Label className="mb-1">
                      {t("encryption:unlock.keyLabel")}
                    </Label>
                    <Textarea
                      value={privateKey}
                      onChange={e => setPrivateKey(e.target.value)}
                      placeholder={t("encryption:unlock.keyPlaceholder")}
                      className="h-20 min-h-0 resize-none font-mono text-xs"
                      disabled={!bundleReady}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <Label className="h-8 cursor-pointer rounded-lg border px-3 hover:bg-muted">
                      <input
                        type="file"
                        accept=".txt,.key,.pem"
                        onChange={handleFileUpload}
                        className="hidden"
                        disabled={!bundleReady}
                      />
                      <KeyRound className="size-3" />
                      {t("encryption:unlock.uploadFile")}
                    </Label>
                  </div>
                </>
              )}

          {!bundleReady && (
            <p className="text-xs text-muted-foreground">{t("common.loading")}</p>
          )}

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
              {cooldownSeconds > 0 && (
                <>
                  {" "}
                  <span aria-live="polite">
                    {t("encryption:unlock.retryIn", "Retry in {{seconds}}s", { seconds: cooldownSeconds })}
                  </span>
                </>
              )}
            </p>
          )}

          <Button
            onClick={() => void handleUnlock()}
            disabled={!canSubmit || loading || !bundleReady || cooldownSeconds > 0}
            className="w-full"
          >
            {loading
              ? t("encryption:unlock.unlocking")
              : cooldownSeconds > 0
                ? t("encryption:unlock.retryIn", "Retry in {{seconds}}s", { seconds: cooldownSeconds })
                : (
                    <>
                      <Unlock className="mr-2 size-4" />
                      {t("encryption:unlock.button")}
                    </>
                  )}
          </Button>

          <p className="text-center text-xs text-muted-foreground">
            {t("encryption:unlock.localNote")}
          </p>
        </div>
      </div>
    </div>
  );
}
