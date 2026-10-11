import { useRouterState } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { APP_DISPLAY_NAME } from "@/shared/lib/branding";

/**
 * Global document.title sync — call once in root layout.
 * Reads `staticData.titleKey` from the deepest matched route.
 */
export function useDocumentTitle() {
  const { t, i18n } = useTranslation();
  const matches = useRouterState({ select: s => s.matches });

  // Find the deepest route that has a titleKey
  let titleKey: string | undefined;
  for (let i = matches.length - 1; i >= 0; i--) {
    const key = (matches[i]!.staticData as { titleKey?: string }).titleKey;
    if (key) {
      titleKey = key;
      break;
    }
  }

  // Set directly during render — no useEffect timing issues
  document.title = titleKey ? `${t(titleKey)} - ${APP_DISPLAY_NAME}` : APP_DISPLAY_NAME;

  // Re-run on language change (the component re-renders via useTranslation)
  void i18n.language;
}
