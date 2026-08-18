import { err, ok } from "@phyxiusjs/fp";
import { createAtom } from "@phyxiusjs/atom";
import type { Clock } from "@phyxiusjs/clock";
import type { MachineState } from "@phyxiusjs/state-machine";

import type { StateStore } from "./types.js";

/**
 * In-process `StateStore`, backed by an `@phyxiusjs/atom` — which is exactly
 * what this needs and already exists: a cell with a compare-and-set keyed on a
 * caller-supplied equality. This was a bare `let` with the comparison written
 * out by hand, which is that primitive rebuilt a second time, less observably.
 * Sufficient for single-container deployments and tests. Fleet deployments
 * swap this for a Postgres-backed store the same way `@phyxiusjs/migration`'s
 * `PhaseStore` does — the pattern is identical on purpose.
 *
 * Why the atom is not enough on its own, and `StateStore` stays async and
 * `Result`-returning: an atom is in-process and synchronous, and durable state
 * has to outlive the process that wrote it — a revived step reads what a dead
 * worker left behind. A boolean also cannot say WHICH state won a race, and
 * `STATE_RACE_LOST` has to name it. So the atom implements this store; it
 * cannot be the interface.
 *
 * Equality is by state NAME, matching the `trySet(from, to)` contract: the
 * caller compares kinds, never whole state objects, so structural payload
 * differences must not decide a CAS.
 */
export function createMemoryStateStore<S extends MachineState>(opts: { initial: S; clock: Clock }): StateStore<S> {
  const cell = createAtom<S>(opts.initial, opts.clock, {
    equals: (a, b) => a.kind === b.kind,
  });

  return {
    async current() {
      return cell.deref();
    },
    async trySet(from, to) {
      const observed = cell.deref();
      // `compareAndSet` wants a value to compare, and the contract hands us a
      // kind — the observed cell IS that value when the kinds agree, so this
      // asks the atom the same question the caller asked us.
      if (observed.kind !== from) {
        return err({ actual: observed.kind });
      }
      if (!cell.compareAndSet(observed, to)) {
        return err({ actual: cell.deref().kind });
      }
      return ok({ at: opts.clock.now() });
    },
  };
}
