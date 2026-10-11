import antfu from "@antfu/eslint-config";

export default antfu({
  typescript: true,
  react: true,
  stylistic: {
    indent: 2,
    quotes: "double",
    semi: true,
  },
  rules: {
    "no-console": "warn",
    "ts/no-explicit-any": "error",
    "ts/consistent-type-imports": ["error", { prefer: "type-imports" }],
    // antfu's options, plus `environment: "bun"`. perfectionist decides what
    // counts as a built-in module from `node:module`'s list in whichever
    // runtime ESLint is running on — and `bun:test` is on Bun's list but not
    // Node's. Left to the default, the same `import … from "bun:test"` is a
    // built-in under Bun and an external package under Node, the two
    // runtimes demand opposite orders, and `bun run lint` passes or fails
    // depending on which one ran it. Naming the environment makes `bun:*` a
    // built-in in both.
    "perfectionist/sort-imports": ["error", {
      environment: "bun",
      groups: [
        "type-import",
        ["type-parent", "type-sibling", "type-index", "type-internal"],
        "value-builtin",
        "value-external",
        "value-internal",
        ["value-parent", "value-sibling", "value-index"],
        "side-effect",
        "ts-equals-import",
        "unknown",
      ],
      newlinesBetween: "ignore",
      newlinesInside: "ignore",
      order: "asc",
      type: "natural",
    }],
  },
  ignores: [
    "**/*.json",
    "**/*.toml",
    "**/*.md",
    "**/*.yml",
    "**/*.yaml",
    "apps/api/drizzle/**",
    "apps/api/src/db/migrations.generated.ts",
    "apps/api/src/lode/sdk.ts",
    "apps/web/src/shared/components/ui/**",
    "apps/web/src/app/routeTree.gen.ts",
  ],
}, {
  // Test files routinely need to construct partial fixtures that the
  // strict project rules would otherwise refuse — relax the
  // most-friction-prone ones to `warn`, leaving production code under
  // the strict policy. Keeps test ergonomics without giving up the
  // rules where they matter.
  files: [
    "**/*.test.ts",
    "**/*.test.tsx",
    "tests/**/*.ts",
  ],
  rules: {
    "ts/no-explicit-any": "warn",
    "no-console": "off",
  },
}, {
  // Executable entry points, like the files under scripts/ that antfu
  // already exempts: they run top-level awaits by design.
  files: [
    "tests/e2e/run.ts",
    "tests/workers/smoke.ts",
  ],
  rules: {
    "antfu/no-top-level-await": "off",
  },
});
