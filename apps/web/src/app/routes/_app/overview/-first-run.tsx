import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/shared/components/ui/card";

const STEPS = [
  {
    path: "/packages",
    titleKey: "portal:firstRun.createPackage.title",
    descriptionKey: "portal:firstRun.createPackage.description",
    linkKey: "portal:firstRun.createPackage.link",
  },
  {
    path: "/tokens",
    titleKey: "portal:firstRun.createToken.title",
    descriptionKey: "portal:firstRun.createToken.description",
    linkKey: "portal:firstRun.createToken.link",
  },
  {
    path: "/packages",
    titleKey: "portal:firstRun.publish.title",
    descriptionKey: "portal:firstRun.publish.description",
    linkKey: "portal:firstRun.publish.link",
  },
] as const;

/** Shown instead of the recent versions while the caller has no package. */
export function FirstRun() {
  const { t } = useTranslation("portal");

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("portal:firstRun.title")}</CardTitle>
        <CardDescription>{t("portal:firstRun.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="space-y-4">
          {STEPS.map((step, i) => (
            <li key={step.titleKey} className="flex gap-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
                {i + 1}
              </span>
              <div className="min-w-0 space-y-0.5">
                <div className="font-medium">{t(step.titleKey)}</div>
                <p className="text-muted-foreground">{t(step.descriptionKey)}</p>
                <Link to={step.path} className="text-primary underline-offset-4 hover:underline">
                  {t(step.linkKey)}
                </Link>
              </div>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
