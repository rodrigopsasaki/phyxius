import { mergeConfig, defineConfig } from "vitest/config";
import { baseConfig } from "../../../vitest.config.base";

// globals:true and an include-based (allowlist) coverage scope are
// deliberate for this package and stay explicit overrides.
//
// thresholds used to be nested under a `global` key, which Vitest's
// per-glob threshold syntax reads as a glob pattern named "global" — no
// file matches it, so those thresholds were never actually checked
// (confirmed: forcing them to 99% did not fail `vitest run --coverage`).
// Flattened here to the real shape, at the same 85% the package already
// declared, so this makes the existing intent effective rather than
// setting a new bar.
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      globals: true,
      setupFiles: [],
      coverage: {
        provider: "v8",
        reporter: ["text", "json", "html"],
        include: ["src/**/*.ts"],
        exclude: ["src/**/*.test.ts", "src/**/*.spec.ts", "dist/**/*", "node_modules/**/*"],
        thresholds: {
          branches: 85,
          functions: 85,
          lines: 85,
          statements: 85,
        },
      },
      testTimeout: 10000,
      hookTimeout: 10000,
    },
  }),
);
