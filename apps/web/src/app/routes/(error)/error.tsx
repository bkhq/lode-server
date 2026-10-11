/* eslint-disable react-refresh/only-export-components */
import { createFileRoute, Link } from "@tanstack/react-router";
import { AlertCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Logo } from "@/shared/components/logo";
import { ModeToggle } from "@/shared/components/mode-toggle";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/shared/components/ui/card";

// Codes the backend may emit. Anything outside this list falls back to
// `errors:codes.unknown`. Keep in sync with LoginErrorCode in
// apps/api/src/modules/account/auth/auth.routes.ts.
const KNOWN_ERROR_CODES = [
  "oauth_not_configured",
  "oauth_state_invalid",
  "oidc_error",
  "user_disabled",
  "single_user_mode_active",
] as const;

type KnownErrorCode = typeof KNOWN_ERROR_CODES[number];
type ErrorCode = KnownErrorCode | "unknown";

interface ErrorSearchParams {
  code: ErrorCode;
  detail: string | undefined;
}

function parseCode(raw: unknown): ErrorCode {
  if (typeof raw !== "string")
    return "unknown";
  return (KNOWN_ERROR_CODES as readonly string[]).includes(raw) ? (raw as KnownErrorCode) : "unknown";
}

export const Route = createFileRoute("/(error)/error")({
  staticData: { titleKey: "errors:title" },
  component: ErrorPage,
  validateSearch: (search: Record<string, unknown>): ErrorSearchParams => ({
    code: parseCode(search.code),
    detail: typeof search.detail === "string" ? search.detail.slice(0, 200) : undefined,
  }),
});

function ErrorPage() {
  const { t } = useTranslation("errors");
  const { code, detail } = Route.useSearch();

  const title = t(`codes.${code}.title`);
  const description = t(`codes.${code}.description`);
  // History length > 1 means there is *something* to go back to. Reading
  // it once at render time is fine — the back button is fired by a click,
  // not on a stale state; if the user navigates around the page somehow
  // before clicking, history.back() still does the right thing.
  const canGoBack = typeof window !== "undefined" && window.history.length > 1;

  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-background p-4">
      <div className="absolute right-4 top-4">
        <ModeToggle />
      </div>

      <div className="mx-auto w-full max-w-md">
        <div className="mb-6 flex justify-center">
          <Logo className="size-10" />
        </div>
        <Card>
          <CardHeader className="text-center">
            <div className="mx-auto mb-3 flex size-16 items-center justify-center rounded-2xl bg-destructive/10">
              <AlertCircle className="size-8 text-destructive" />
            </div>
            <CardTitle className="text-2xl">{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {detail && (
              <details className="rounded-md border bg-muted/30 px-3 py-2 text-left">
                <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                  {t("detailLabel")}
                </summary>
                <pre className="mt-2 whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground">
                  {detail}
                </pre>
              </details>
            )}
            <div className="flex justify-center gap-2">
              <Link
                to="/overview"
                className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-background px-4 text-sm font-medium hover:bg-accent hover:text-accent-foreground"
              >
                {t("home")}
              </Link>
              {canGoBack && (
                <button
                  type="button"
                  onClick={() => window.history.back()}
                  className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                >
                  {t("retry")}
                </button>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
