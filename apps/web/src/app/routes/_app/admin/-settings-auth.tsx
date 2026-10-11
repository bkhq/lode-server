import { useTranslation } from "react-i18next";
import { ErrorBanner, SettingsCard, useSettingsByPrefix } from "./-settings-shared";

const SESSION_FIELDS: readonly { key: string; label: string; sensitive: boolean; placeholder: string }[] = [
  { key: "session.max_age", label: "settings:auth.fieldSessionMaxAge", sensitive: false, placeholder: "86400" },
];

export function AuthSettingsTab() {
  const { t } = useTranslation(["common", "settings"]);
  const { settings, loading, error, refetch } = useSettingsByPrefix("session.");

  return (
    <div className="space-y-6 pt-4">
      {error && <ErrorBanner message={error} />}

      {loading
        ? <div className="py-8 text-center text-muted-foreground">{t("common.loading")}</div>
        : (
            <div>
              <h2 className="text-lg font-semibold">{t("settings:auth.sessionTitle")}</h2>
              <p className="mb-3 text-sm text-muted-foreground">{t("settings:auth.sessionDescription")}</p>
              <SettingsCard
                title={t("settings:auth.sessionTitle")}
                prefix=""
                fields={SESSION_FIELDS}
                settings={settings}
                onSaved={refetch}
              />
            </div>
          )}
    </div>
  );
}
