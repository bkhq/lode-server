/* eslint-disable react-refresh/only-export-components */
import type { ReactNode } from "react";
import { createContext, use, useCallback, useEffect, useMemo, useState } from "react";
import { storageKey } from "@/shared/lib/branding";

type Theme = "light" | "dark" | "system";

interface ThemeContextValue {
  readonly theme: Theme;
  readonly setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

const STORAGE_KEY = storageKey("theme");
const isBrowser = typeof window !== "undefined";

function getSystemTheme(): "light" | "dark" {
  if (!isBrowser)
    return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: Theme) {
  if (!isBrowser)
    return;
  const resolved = theme === "system" ? getSystemTheme() : theme;
  document.documentElement.classList.toggle("dark", resolved === "dark");
}

function getStoredTheme(): Theme {
  if (!isBrowser)
    return "system";
  const stored = localStorage.getItem(STORAGE_KEY);
  return (stored === "light" || stored === "dark" || stored === "system") ? stored : "system";
}

export function ThemeProvider({ children }: { readonly children: ReactNode }) {
  const [currentTheme, setCurrentTheme] = useState<Theme>(getStoredTheme);

  const setTheme = useCallback((t: Theme) => {
    if (isBrowser)
      localStorage.setItem(STORAGE_KEY, t);
    setCurrentTheme(t);
  }, []);

  useEffect(() => {
    applyTheme(currentTheme);

    if (currentTheme === "system" && isBrowser) {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const handler = () => applyTheme("system");
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    }
  }, [currentTheme]);

  const value = useMemo(() => ({ theme: currentTheme, setTheme }), [currentTheme, setTheme]);

  return (
    <ThemeContext value={value}>
      {children}
    </ThemeContext>
  );
}

export function useTheme() {
  const ctx = use(ThemeContext);
  if (!ctx)
    throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
