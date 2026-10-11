import type { BackendModule } from "i18next";
import type { CustomDetector } from "i18next-browser-languagedetector";
import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";
import { storageKey } from "@/shared/lib/branding";

// Lazy-load each namespace as its own chunk via Vite's `import.meta.glob`.
// Vite resolves the pattern at build time, so each `(locale, namespace)` ships
// as a deterministic JS chunk fetched on demand — no HTTP backend, no
// inactive-language strings in the main entry.
type LocaleLoader = () => Promise<{ default: Record<string, unknown> }>;

const localeModules = import.meta.glob<{ default: Record<string, unknown> }>(
  "../locales/*/*.json",
);

// Derive `supportedLngs` and `ns` from the filesystem so adding a new
// locale or namespace requires nothing more than dropping files under
// `apps/web/src/locales/<lng>/<ns>.json`. Vite resolves the glob at
// build time, so the keys here are statically known.
//
// To add a new language: create `apps/web/src/locales/<lng>/` and place
// the same set of namespace shards used by `en/` inside it. No edits to
// this file are needed (only `toBcp47` if the new locale needs a
// non-identity BCP-47 mapping).
const RE_LOCALE_KEY = /^\.\.\/locales\/([^/]+)\/([^/]+)\.json$/;

function deriveLocaleManifest(): { languages: string[]; namespaces: string[] } {
  const languages = new Set<string>();
  const namespaces = new Set<string>();
  for (const key of Object.keys(localeModules)) {
    const m = RE_LOCALE_KEY.exec(key);
    if (!m)
      continue;
    languages.add(m[1]!);
    namespaces.add(m[2]!);
  }
  return {
    languages: [...languages].sort(),
    namespaces: [...namespaces].sort(),
  };
}

const { languages: SUPPORTED_LNGS, namespaces: NAMESPACES } = deriveLocaleManifest();

async function loadNamespace(language: string, namespace: string): Promise<Record<string, unknown>> {
  const key = `../locales/${language}/${namespace}.json`;
  const loader = localeModules[key] as LocaleLoader | undefined;
  if (!loader)
    return {};
  const mod = await loader();
  return mod.default;
}

const lazyBackend: BackendModule = {
  type: "backend",
  init: () => {},
  read(language, namespace, callback) {
    loadNamespace(language, namespace)
      .then(data => callback(null, data))
      .catch((err: unknown) => callback(err as Error, false));
  },
};

// The built-in `localStorage` cache detector feature-probes storage once
// and caches the result, but its actual `setItem(lng)` write is NOT
// wrapped — a later quota-exceeded error or Safari private-mode toggle
// throws uncaught during `languageChanged`. Override the same-named
// detector with a try/catch'd write (no-op on failure); reads stay
// best-effort too. Registered by name so it shadows the built-in.
const guardedLocalStorageDetector: CustomDetector = {
  name: "localStorage",
  lookup({ lookupLocalStorage }) {
    if (!lookupLocalStorage || typeof window === "undefined")
      return undefined;
    try {
      return window.localStorage.getItem(lookupLocalStorage) || undefined;
    }
    catch {
      return undefined;
    }
  },
  cacheUserLanguage(lng, { lookupLocalStorage }) {
    if (!lookupLocalStorage || typeof window === "undefined")
      return;
    try {
      window.localStorage.setItem(lookupLocalStorage, lng);
    }
    catch {
      // no-op: language still applied for this session.
    }
  },
};

const languageDetector = new LanguageDetector();
languageDetector.addDetector(guardedLocalStorageDetector);

// Map i18next language codes to BCP-47 codes for the document `lang`
// attribute. Only locales that need a country-specific mapping live here
// (e.g. `zh` -> `zh-CN`); every other locale code is returned as-is, so
// adding `fr`, `de`, etc. requires no change to this function.
function toBcp47(lng: string): string {
  if (lng.toLowerCase().startsWith("zh"))
    return "zh-CN";
  return lng;
}

function syncDocumentLang(lng: string): void {
  if (typeof document !== "undefined") {
    document.documentElement.lang = toBcp47(lng);
  }
}

/**
 * Promise that resolves once the active language's namespaces have loaded.
 * Importers should `await` this before mounting React so the first paint
 * already has translations and avoids a key-flash. Resolves immediately on
 * subsequent imports.
 */
export const i18nReady: Promise<unknown> = i18n
  .use(lazyBackend)
  .use(languageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: "en",
    supportedLngs: SUPPORTED_LNGS,
    defaultNS: "common",
    fallbackNS: "common",
    ns: NAMESPACES,
    // Disable suspense — we gate the React mount on `i18nReady` instead, so
    // `useTranslation` never sees the loading state.
    react: { useSuspense: false },
    // Re-load the fallback language too, so missing keys in the active
    // language fall through to English without a second round-trip.
    load: "languageOnly",
    partialBundledLanguages: false,
    detection: {
      order: ["localStorage", "navigator"],
      caches: ["localStorage"],
      lookupLocalStorage: storageKey("lang"),
    },
    interpolation: {
      escapeValue: false,
    },
  })
  .then(() => syncDocumentLang(i18n.language));

i18n.on("languageChanged", (lng) => {
  syncDocumentLang(lng);
});

export default i18n;
