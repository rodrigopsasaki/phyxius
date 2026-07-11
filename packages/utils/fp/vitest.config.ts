import { mergeConfig, defineConfig } from "vitest/config";
import { baseConfig, coverageDefaults } from "../../../vitest.config.base";

// No thresholds: this package's coverage isn't gated today, so extending
// the base must not silently start gating it. The shared exclude pattern
// (**/*.config.ts) also fixes this package's own vitest/tsup config files
// showing up as 0%-covered "files" in the report.
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      coverage: { ...coverageDefaults },
    },
  }),
);
