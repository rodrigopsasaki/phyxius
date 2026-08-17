import { err, ok } from "@phyxiusjs/fp";
import type { Clock } from "@phyxiusjs/clock";
import type { MachineState } from "@phyxiusjs/state-machine";

import type { StateStore } from "./types.js";

/**
 * In-process `StateStore`, backed by a plain variable behind an async CAS —
 * safe because JavaScript is single-threaded and `trySet` never awaits
 * between its read and its write. Sufficient for single-container
 * deployments and tests. Fleet deployments swap this for a Postgres-backed
 * store the same way `@phyxiusjs/migration`'s `PhaseStore` does — the
 * pattern is identical on purpose.
 */
export function createMemoryStateStore<S extends MachineState>(opts: { initial: S; clock: Clock }): StateStore<S> {
  let state = opts.initial;

  return {
    async current() {
      return state;
    },
    async trySet(from, to) {
      if (state.kind !== from) {
        return err({ actual: state.kind });
      }
      state = to;
      return ok({ at: opts.clock.now() });
    },
  };
}
