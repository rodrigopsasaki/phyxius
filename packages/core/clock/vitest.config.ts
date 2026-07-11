import { mergeConfig, defineConfig } from "vitest/config";
import { baseConfig, coverageDefaults } from "../../../vitest.config.base";

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
