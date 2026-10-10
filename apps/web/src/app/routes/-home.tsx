import { useTranslation } from "react-i18next";
import { Logo } from "@/shared/components/logo";
import { ModeToggle } from "@/shared/components/mode-toggle";
import { APP_DISPLAY_NAME } from "@/shared/lib/branding";
import { BASE_PATH } from "@/shared/lib/http";

/**
 * The home page, shown at `/` when `HOME_PAGE` is `base` or `root` (see
 * `.env.example`). It is public and makes no authenticated call. Replace
 * the body with whatever the landing page should say.
 */
export function HomePage() {
  const { t } = useTranslation("home");
  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-background p-4">
      <div className="absolute right-4 top-4">
        <ModeToggle />
      </div>
      <div className="mx-auto w-full max-w-md space-y-6 text-center">
        <Logo className="mx-auto size-12" />
        <div className="space-y-2">
          <h1 className="text-3xl font-bold tracking-tight">{APP_DISPLAY_NAME}</h1>
          <p className="text-muted-foreground">{t("description")}</p>
        </div>
        {/* A plain link: at the origin root the router has no base prefix,
            so a router link would not reach the app under BASE_PATH. */}
        <a
          href={`${BASE_PATH}/overview`}
          className="inline-flex h-9 items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          {t("enter")}
        </a>
      </div>
    </div>
  );
}
