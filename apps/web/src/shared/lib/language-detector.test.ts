import { afterEach, describe, expect, it, vi } from "vitest";
import { languageDetector } from "./language-detector";

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    getItem: k => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  } as Storage;
}

const throwing = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
} as unknown as Storage;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("languageDetector", () => {
  it("prefers the stored choice, then the browser's languages", () => {
    vi.stubGlobal("localStorage", memoryStorage({ lang: "zh" }));
    vi.stubGlobal("navigator", {
      languages: ["de-DE", "en"],
      language: "de-DE",
    });
    expect(languageDetector("lang").detect()).toEqual(["zh", "de-DE", "en"]);
  });

  it("falls back to navigator.language when navigator.languages is empty", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    vi.stubGlobal("navigator", { languages: [], language: "el" });
    expect(languageDetector("lang").detect()).toEqual(["el"]);
  });

  it("caches the chosen language", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    languageDetector("lang").cacheUserLanguage!("en");
    expect(storage.getItem("lang")).toBe("en");
  });

  it("survives storage that throws on read and write", () => {
    vi.stubGlobal("localStorage", throwing);
    vi.stubGlobal("navigator", {
      languages: ["it"],
      language: "it",
    });
    const detector = languageDetector("lang");
    expect(detector.detect()).toEqual(["it"]);
    expect(() => detector.cacheUserLanguage!("it")).not.toThrow();
  });
});
