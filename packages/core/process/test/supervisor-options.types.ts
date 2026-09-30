/**
 * Compile-time contract for `Supervisor`'s constructor. Nothing here runs:
 * `tsc -p tsconfig.test.json` (the second half of this package's `typecheck`
 * script) is the gate, and vitest never picks this file up because it is not
 * a `*.test.ts`. That is deliberate. `tsconfig.json` cannot include `test/`
 * (its `rootDir` is `./src` so the build's `dist/` mirrors `src/`), and a
 * `@ts-expect-error` inside a vitest file is never evaluated by anything CI
 * runs: it would read as enforced and verify nothing.
 *
 * Every `@ts-expect-error` below is itself a check. If the line under it
 * starts compiling, the directive is unused and tsc fails the gate.
 */
import { createControlledClock, ms } from "@phyxiusjs/clock";
import { Supervisor } from "../src/index.js";
import type { SupervisionStrategy } from "../src/index.js";

const clock = createControlledClock();
const random = () => 0.5;

// A strategy typed as the package's own exported type, as a shared constant
// or a config-loaded value would be.
const shared: SupervisionStrategy = {
  type: "one-for-one",
  maxRestarts: { count: 3, within: ms(10_000) },
  backoff: { initial: ms(1_000), max: ms(30_000), factor: 2 },
};
const sharedWithJitter: SupervisionStrategy = {
  type: "one-for-one",
  backoff: { initial: ms(1_000), max: ms(30_000), factor: 2, jitter: 20 },
};

// ── Accepted ─────────────────────────────────────────────────────────────

new Supervisor({ clock });
new Supervisor({ clock, random });
new Supervisor({ clock, strategy: { type: "none" } });
new Supervisor({ clock, strategy: { type: "one-for-one", maxRestarts: { count: 3, within: ms(10_000) } } });
new Supervisor({
  clock,
  strategy: { type: "one-for-one", backoff: { initial: ms(5), max: ms(5), factor: 1 } },
});
new Supervisor({
  clock,
  strategy: { type: "one-for-one", backoff: { initial: ms(5), max: ms(5), factor: 1, jitter: 0 } },
});

// A value typed as `SupervisionStrategy` compiles with or without `random`.
new Supervisor({ clock, strategy: shared });
new Supervisor({ clock, strategy: shared, random });
new Supervisor({ clock, strategy: sharedWithJitter, random });
// It also compiles without `random` when it carries jitter, because the type
// says only `jitter?: number`, never which. That is the one shape the
// constructor's types cannot refuse: it is refused when constructed, with an
// error naming `random` (see supervisor-restart-budget.test.ts).
new Supervisor({ clock, strategy: sharedWithJitter });

new Supervisor({
  clock,
  random,
  strategy: { type: "one-for-one", backoff: { initial: ms(5), max: ms(5), factor: 1, jitter: 20 } },
});

// ── Rejected ─────────────────────────────────────────────────────────────

// @ts-expect-error real jitter needs an injected `random`
new Supervisor({
  clock,
  strategy: { type: "one-for-one", backoff: { initial: ms(5), max: ms(5), factor: 1, jitter: 50 } },
});

// @ts-expect-error a small real jitter is still real jitter
new Supervisor({
  clock,
  strategy: { type: "one-for-one", backoff: { initial: ms(5), max: ms(5), factor: 1, jitter: 1 } },
});
