import { useTranslation } from "react-i18next";
import { Label } from "@/shared/components/ui/label";
import { Switch } from "@/shared/components/ui/switch";
import { APP_DISPLAY_NAME } from "@/shared/lib/branding";
import { ErrorBanner, saveSetting, SettingsCard, useSettingsByPrefix } from "./-settings-shared";

const SMTP_FIELDS: readonly { key: string; label: string; sensitive: boolean; placeholder: string }[] = [
  { key: "smtp.host", label: "settings:smtp.fieldHost", sensitive: false, placeholder: "smtp.example.com" },
  { key: "smtp.port", label: "settings:smtp.fieldPort", sensitive: false, placeholder: "587" },
  { key: "smtp.username", label: "settings:smtp.fieldUsername", sensitive: false, placeholder: "user@example.com" },
  { key: "smtp.password", label: "settings:smtp.fieldPassword", sensitive: true, placeholder: "Password" },
  { key: "smtp.from_address", label: "settings:smtp.fieldFromAddress", sensitive: false, placeholder: "noreply@example.com" },
  { key: "smtp.from_name", label: "settings:smtp.fieldFromName", sensitive: false, placeholder: APP_DISPLAY_NAME },
];

export function SmtpSettingsTab() {
  const { t } = useTranslation(["common", "settings"]);
  const { settings, loading, error, setError, refetch } = useSettingsByPrefix("smtp.");

  const smtpEnabled = settings.find(s => s.key === "smtp.enabled")?.value === "true";

  const handleToggle = async (checked: boolean) => {
    try {
      await saveSetting("smtp.enabled", String(checked));
      void refetch();
    }
    catch (err) {
      setError(err instanceof Error ? err.message : t("common.error.operationFailed"));
    }
  };

  return (
    <div className="space-y-4 pt-4">
      {error && <ErrorBanner message={error} />}

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">{t("settings:smtp.title")}</h2>
          <p className="text-sm text-muted-foreground">{t("settings:smtp.description")}</p>
        </div>
        <div className="flex items-center gap-3">
          <Label htmlFor="smtp-toggle" className="text-sm">{t("settings:smtp.enable")}</Label>
          <Switch
            id="smtp-toggle"
            checked={smtpEnabled}
            onCheckedChange={handleToggle}
          />
        </div>
      </div>

      {loading
        ? <div className="py-8 text-center text-muted-foreground">{t("common.loading")}</div>
        : (
            <SettingsCard
              title={t("settings:smtp.serverConfig")}
              prefix=""
              fields={SMTP_FIELDS}
              settings={settings}
              onSaved={refetch}
            />
          )}

    </div>
  );
}
