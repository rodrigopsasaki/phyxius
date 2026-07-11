import { defineConfig } from "vitest/config";

/**
 * Shared vitest baseline. Every package extends this with `mergeConfig`
 * instead of re-declaring globals/environment/coverage boilerplate — the
 * same "extends" relationship each package's tsconfig.json has with the
 * root tsconfig.json. A package that wants different behavior states the
 * delta explicitly in its own vitest.config.ts; it never inherits a
 * silent default.
 *
 * Deliberately excluded from this file: coverage thresholds. Whether a
 * package enforces a coverage bar — and at what number — is a per-package
 * decision, not a workspace-wide one; baking a default in here would mean
 * a package with no opinion on coverage today (most of them) silently
 * gains an enforced minimum the moment someone runs `--coverage`.
 */
export const baseConfig = defineConfig({
  test: {
    globals: false,
    environment: "node",
  },
});

/**
 * Structural coverage defaults (provider, reporter, exclude) for packages
 * that opt into coverage. Spread into a package's own `test.coverage` —
 * thresholds, if any, are that package's own explicit addition.
 */
export const coverageDefaults = {
  provider: "v8",
  reporter: ["text", "lcov", "html"],
  exclude: ["**/node_modules/**", "**/dist/**", "**/*.config.ts"],
} as const;
