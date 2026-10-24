/* eslint-disable react-refresh/only-export-components */
import { createRootRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { FullPageLoader } from "@/shared/components/full-page-loader";
import { NotFoundPage } from "@/shared/components/not-found";
import { useDocumentTitle } from "@/shared/hooks/use-page-title";
import { isOriginRootPage } from "@/shared/lib/home";
import { BASE_PATH, onHttpEvent } from "@/shared/lib/http";
import { useSystemStore } from "@/shared/stores/system";

export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFoundPage,
});

const BYPASS_SUFFIXES = [
  "/setup",
  "/unlock",
  "/denied",
  "/login",
  "/totp-verify",
  "/error",
];

function redirectToLogin() {
  // Carry the query string too so deep-link context (filters, ids,
  // tabs) survives the session-expiry bounce — matches the redirect
  // value `_app.tsx` builds for its own guard.
  if (isOriginRootPage())
    return;
  const current = window.location.pathname + window.location.search;
  if (BYPASS_SUFFIXES.some(s => current.startsWith(`${BASE_PATH}${s}`)))
    return;
  window.location.href = `${BASE_PATH}/login?redirect=${encodeURIComponent(current)}`;
}

function RootLayout() {
  const { t } = useTranslation();
  useDocumentTitle();

  const navigate = useNavigate();
  const { status, dbError, fetchStatus, startPolling, stopPolling } = useSystemStore();

  useEffect(() => {
    void fetchStatus();
    startPolling();
    return stopPolling;
  }, [fetchStatus, startPolling, stopPolling]);

  useEffect(() => {
    return onHttpEvent((type) => {
      if (type === "unauthorized") {
        redirectToLogin();
      }
      else if (type === "system-locked") {
        void useSystemStore.getState().fetchStatus();
      }
    });
  }, []);

  useEffect(() => {
    if (status === "loading" || status === "error" || status === "db-error")
      return;

    // The home page at the origin root is outside BASE_PATH: the setup and
    // unlock redirects would land on paths the server does not serve there.
    if (isOriginRootPage())
      return;

    const path = window.location.pathname;
    if (BYPASS_SUFFIXES.some(s => path.startsWith(`${BASE_PATH}${s}`)))
      return;

    if (status === "uninitialized") {
      void navigate({ to: "/setup", replace: true });
    }
    else if (status === "locked") {
      void navigate({ to: "/unlock", replace: true });
    }
  }, [status, navigate]);

  if (status === "loading") {
    return <FullPageLoader onRetry={() => void fetchStatus()} />;
  }

  if (status === "db-error") {
    return (
      <div className="flex min-h-svh items-center justify-center bg-background">
        <div className="mx-auto max-w-md text-center space-y-4 p-6">
          <div className="mx-auto flex size-16 items-center justify-center rounded-2xl bg-destructive/10">
            <span className="text-2xl">⚠</span>
          </div>
          <h1 className="text-xl font-bold text-destructive">{t("common.error.dbError")}</h1>
          <p className="text-sm text-muted-foreground">{t("common.error.dbErrorBody")}</p>
          {dbError && (
            <details className="text-left">
              <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                {t("common.errorDetails")}
              </summary>
              <pre className="mt-2 rounded-lg bg-muted p-3 text-xs text-muted-foreground whitespace-pre-wrap break-words">{dbError}</pre>
            </details>
          )}
          <button
            type="button"
            className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90"
            onClick={() => void fetchStatus()}
          >
            {t("common.retry")}
          </button>
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="flex min-h-svh items-center justify-center bg-background">
        <div className="text-center space-y-4">
          <p className="text-destructive">{t("common.error.systemUnavailable")}</p>
          <button
            type="button"
            className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90"
            onClick={() => void fetchStatus()}
          >
            {t("common.retry")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-svh bg-background text-foreground">
      <Outlet />
    </div>
  );
}
