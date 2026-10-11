// Vitest configuration for the web workspace. Extends the project's
// vite.config.ts (plugins, base, etc.) and adds coverage thresholds so
// CI fails when the SPA regresses below the agreed floor. Thresholds
// are intentionally conservative — initial numbers track the existing
// suite so the gate can be tightened over time without immediately
// breaking main.
import { resolve } from "node:path";
import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default mergeConfig(
  viteConfig,
  defineConfig({
    resolve: {
      alias: {
        "@": resolve(__dirname, "src"),
      },
    },
    test: {
      coverage: {
        provider: "v8",
        reporter: ["text", "lcov"],
        // Only the source code we own — vendor / generated files
        // (TanStack routeTree.gen, etc.) are excluded so the gate
        // measures hand-written code only.
        include: ["src/**/*.{ts,tsx}"],
        exclude: [
          "src/**/*.test.{ts,tsx}",
          "src/**/*.d.ts",
          "src/app/routeTree.gen.ts",
          "src/main.tsx",
        ],
        // Thresholds are percentages (0-100). Conservative floors that
        // track the current suite — raise as coverage improves.
        thresholds: {
          lines: 5,
          functions: 2,
          statements: 5,
          branches: 4,
        },
      },
    },
  }),
);
