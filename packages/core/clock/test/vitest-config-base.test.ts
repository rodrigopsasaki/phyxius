import { describe, it, expect } from "vitest";
import { baseConfig, coverageDefaults } from "../../../../vitest.config.base";

// vitest.config.base.ts is the one shared shape all eight packages extend
// via mergeConfig instead of hand-rolling globals/environment/coverage.
// Nothing in the workspace runs a root-level test today — `pnpm -w test`
// only recurses into each package's own `test` script — so this contract
// test lives package-adjacent instead of at the root. It lives here in
// clock because clock and context are the two packages that exercise the
// full shape (thresholds layered on coverageDefaults layered on
// baseConfig), and their threshold drift (95% vs 90%, copy-pasted apart
// over time) is the exact bug this shared config exists to prevent.
//
// These pin the design decisions the review called load-bearing, not
// arbitrary literal values — each assertion below states what breaks if
// it silently changed.
describe("vitest.config.base contract", () => {
  it("coverageDefaults declares no thresholds — a coverage bar stays each package's own explicit choice", () => {
    // If a threshold ever crept into the shared structural defaults, the
    // four packages with no coverage opinion today would silently start
    // gating on `--coverage` the moment someone ran it.
    expect(coverageDefaults).not.toHaveProperty("thresholds");
  });

  it("baseConfig disables globals — every package's tests import describe/it/expect explicitly unless it opts out", () => {
    // utils/config is the one deliberate override (globals: true). Every
    // other package relies on this default staying false.
    expect(baseConfig.test?.globals).toBe(false);
  });

  it("baseConfig runs in the node environment — no package pays for a DOM implementation it doesn't use", () => {
    expect(baseConfig.test?.environment).toBe("node");
  });

  it("coverageDefaults pins the v8 provider every extending package relies on", () => {
    expect(coverageDefaults.provider).toBe("v8");
  });

  it("coverageDefaults excludes config files, so a package's own vitest/tsup config never shows up as a 0%-covered file", () => {
    expect(coverageDefaults.exclude).toContain("**/*.config.ts");
  });
});
