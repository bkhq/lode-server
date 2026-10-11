/* eslint-disable react-refresh/only-export-components */
import { createFileRoute } from "@tanstack/react-router";
import { Loader2, ShieldCheck } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Logo } from "@/shared/components/logo";
import { Button } from "@/shared/components/ui/button";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import { BASE_PATH, http, HttpError } from "@/shared/lib/http";

const RE_NON_DIGIT = /\D/g;

export const Route = createFileRoute("/(auth)/totp-verify")({
  staticData: { titleKey: "totp:loginTitle" },
  component: TotpVerifyPage,
});

function TotpVerifyPage() {
  const { t } = useTranslation(["common", "totp"]);
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleVerify = useCallback(async () => {
    if (code.length !== 6)
      return;
    setLoading(true);
    setError(null);

    try {
      const body = await http<{ success: boolean; data?: { redirect?: string } }>(
        "/account/auth/totp/verify",
        { method: "POST", body: JSON.stringify({ code }) },
      );
      window.location.href = body.data?.redirect ?? `${BASE_PATH}/overview`;
    }
    catch (err) {
      if (err instanceof HttpError && (err.code === "EXPIRED_CHALLENGE" || err.code === "NO_PENDING_TOTP")) {
        setError(t("totp:loginExpired"));
      }
      else {
        setError(t("totp:loginError"));
      }
      setCode("");
      inputRef.current?.focus();
    }
    finally {
      setLoading(false);
    }
  }, [code, t]);

  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-background p-4">
      <div className="mx-auto w-full max-w-xs">
        <div className="mb-8 text-center">
          <Logo className="mx-auto size-10 mb-3" />
          <div className="mx-auto mb-3 flex size-16 items-center justify-center rounded-2xl bg-primary/10">
            <ShieldCheck className="size-8 text-primary" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">
            {t("totp:loginTitle")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("totp:loginDescription")}
          </p>
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="totp-code">{t("totp:verifyCode")}</Label>
            <Input
              ref={inputRef}
              id="totp-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={e => setCode(e.target.value.replace(RE_NON_DIGIT, "").slice(0, 6))}
              onKeyDown={e => e.key === "Enter" && code.length === 6 && void handleVerify()}
              placeholder={t("totp:verifyCodePlaceholder")}
              className="text-center text-lg tracking-[0.5em] font-mono"
              autoFocus
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive text-center">{error}</p>
          )}

          <Button
            onClick={() => void handleVerify()}
            disabled={code.length !== 6 || loading}
            aria-busy={loading}
            className="w-full min-w-[80px]"
          >
            {loading
              ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    {t("totp:verifying")}
                  </>
                )
              : (
                  t("totp:loginVerify")
                )}
          </Button>

          <div className="space-y-1 text-center">
            <a href={`${BASE_PATH}/login`} className="block text-sm text-muted-foreground hover:text-foreground">
              {t("totp:loginBack")}
            </a>
            <p className="text-xs text-muted-foreground">
              {t("totp:lostDeviceHint", "Lost your device? Contact your administrator to reset two-factor authentication.")}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
