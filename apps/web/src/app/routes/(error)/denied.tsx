/* eslint-disable react-refresh/only-export-components */
import { createFileRoute, Link } from "@tanstack/react-router";
import { Check, Copy, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ModeToggle } from "@/shared/components/mode-toggle";
import { Button } from "@/shared/components/ui/button";
import { BASE_PATH, http } from "@/shared/lib/http";

interface DeniedSearchParams {
  reason: string | undefined;
  aid: string | undefined;
}

export const Route = createFileRoute("/(error)/denied")({
  component: DeniedPage,
  validateSearch: (search: Record<string, unknown>): DeniedSearchParams => ({
    reason: typeof search.reason === "string" ? search.reason : undefined,
    aid: typeof search.aid === "string" ? search.aid : undefined,
  }),
});

const VALID_REASONS = [
  "no_viewer_relation",
  "user_not_registered",
  "user_disabled",
] as const;

type ReasonCode = typeof VALID_REASONS[number];

function isValidReason(value: string): value is ReasonCode {
  return (VALID_REASONS as readonly string[]).includes(value);
}

const REQUEST_ACCESS_EMAIL = (import.meta.env.VITE_REQUEST_ACCESS_EMAIL ?? "") as string;

function DeniedPage() {
  const { t } = useTranslation(["common", "denied"]);
  const search = Route.useSearch();
  const [copied, setCopied] = useState(false);
  const [logoutUrl, setLogoutUrl] = useState<string | null>(null);
  const [logoutFetchFailed, setLogoutFetchFailed] = useState(false);

  const reason: ReasonCode = search.reason && isValidReason(search.reason) ? search.reason : "no_viewer_relation";
  const auditId = search.aid;

  useEffect(() => {
    http<{ success: boolean; data: { url: string | null } }>("/account/auth/logout-url")
      .then(res => setLogoutUrl(res.data.url))
      .catch(() => setLogoutFetchFailed(true));
  }, []);

  const handleCopy = useCallback(() => {
    if (!auditId)
      return;
    navigator.clipboard.writeText(auditId).then(() => {
      setCopied(true);
      setTimeout(setCopied, 2000, false);
    });
  }, [auditId]);

  const showBackToPortal = reason === "no_viewer_relation";
  const showSwitchAccount = reason === "no_viewer_relation" || reason === "user_disabled";
  const showSignInDifferent = reason === "user_not_registered";
  const showSignOut = reason === "user_disabled";

  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-background p-4">
      <div className="absolute right-4 top-4">
        <ModeToggle />
      </div>

      <div className="mx-auto w-full max-w-lg text-center">
        <ShieldAlert className="mx-auto size-16 text-destructive" />
        <h1 className="mt-6 text-3xl font-bold">
          {t(`denied:${reason}.title`)}
        </h1>
        <p className="mt-3 text-muted-foreground">
          {t(`denied:${reason}.description`)}
        </p>

        {auditId && (
          <div className="mt-8 rounded-lg border bg-muted/50 p-4 text-left">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium">{t("denied:requestId")}</span>
              <Button variant="ghost" size="icon-xs" onClick={handleCopy}>
                {copied
                  ? <Check className="size-3 text-green-500" />
                  : <Copy className="size-3" />}
              </Button>
            </div>
            <code className="text-xs text-muted-foreground">{auditId}</code>
          </div>
        )}

        <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
          {showBackToPortal && (
            <Link
              to="/overview"
              className="inline-flex h-8 items-center justify-center rounded-lg border border-border bg-background px-3 text-sm font-medium hover:bg-muted"
            >
              {t("denied:backToPortal")}
            </Link>
          )}

          {(showSwitchAccount || showSignInDifferent || showSignOut) && (
            logoutUrl
              ? (
                  <a
                    href={logoutUrl}
                    className="inline-flex h-8 items-center justify-center rounded-lg px-3 text-sm font-medium hover:bg-muted"
                  >
                    {showSignOut
                      ? t("denied:signOut")
                      : showSignInDifferent
                        ? t("denied:signInDifferent")
                        : t("denied:switchAccount")}
                  </a>
                )
              : logoutFetchFailed
                ? (
                    <form method="post" action={`${BASE_PATH}/api/account/auth/logout`}>
                      <button
                        type="submit"
                        className="inline-flex h-8 items-center justify-center rounded-lg px-3 text-sm font-medium hover:bg-muted"
                      >
                        {showSignOut
                          ? t("denied:signOut")
                          : showSignInDifferent
                            ? t("denied:signInDifferent")
                            : t("denied:switchAccount")}
                      </button>
                    </form>
                  )
                : null
          )}

          {showSignInDifferent && REQUEST_ACCESS_EMAIL && (
            <a
              href={`mailto:${REQUEST_ACCESS_EMAIL}`}
              className="inline-flex h-8 items-center justify-center rounded-lg px-3 text-sm font-medium hover:bg-muted"
            >
              {t("denied:requestAccess")}
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
