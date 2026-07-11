import { mergeConfig, defineConfig } from "vitest/config";
import { baseConfig, coverageDefaults } from "../../../vitest.config.base";

// Thresholds match clock's (95%) — the two used to drift (90 vs 95) purely
// because each config was hand-copied. Same shape, same bar, no reason to
// differ; context's actual coverage clears 95% comfortably.
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      coverage: {
        ...coverageDefaults,
        thresholds: {
          statements: 95,
          branches: 95,
          functions: 95,
          lines: 95,
        },
      },
    },
  }),
);
