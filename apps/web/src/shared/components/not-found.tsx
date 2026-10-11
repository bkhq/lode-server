import { Link } from "@tanstack/react-router";
import { FileQuestion } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Logo } from "@/shared/components/logo";
import { ModeToggle } from "@/shared/components/mode-toggle";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/shared/components/ui/card";

export function NotFoundPage() {
  const { t } = useTranslation(["common", "denied"]);
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
            <div className="mx-auto mb-3 flex size-16 items-center justify-center rounded-2xl bg-muted">
              <FileQuestion className="size-8 text-muted-foreground" />
            </div>
            <CardTitle className="text-2xl">{t("common.notFound.title")}</CardTitle>
            <CardDescription>{t("common.notFound.description")}</CardDescription>
          </CardHeader>
          <CardContent className="flex justify-center">
            <Link
              to="/overview"
              className="inline-flex h-8 items-center justify-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              {t("denied:backToPortal")}
            </Link>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
