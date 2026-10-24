import type { LanguageDetectorModule } from "i18next";

// The stored choice first, then the browser's preferences; i18next picks the
// first supported one. Storage access is guarded on both read and write: it
// throws in Safari private mode, on a full quota, or when storage is blocked,
// and the language should still apply for the session.
export function languageDetector(key: string): LanguageDetectorModule {
  return {
    type: "languageDetector",
    detect() {
      let stored: string | null = null;
      try {
        stored = localStorage.getItem(key);
      }
      catch {}
      const browser = navigator.languages?.length
        ? navigator.languages
        : [navigator.language];
      return [stored, ...browser].filter((lng): lng is string => Boolean(lng));
    },
    cacheUserLanguage(lng) {
      try {
        localStorage.setItem(key, lng);
      }
      catch {}
    },
  };
}
