import { elapsedSince, ms, type Clock, type Millis } from "@phyxiusjs/clock";
import type { HandlerEvent } from "@phyxiusjs/handler";
import type { Journal } from "@phyxiusjs/journal";
import type { JournalStore } from "@phyxiusjs/migration";

// ── runClimb — making the invisible minute a NUMBER, not a prevention ──────
//
// Round 0's FINDING 5 (the hardest case, corpus item 3): work between two
// declared steps is invisible by construction — nothing notices it, let
// alone forbids it. Rounds 1-4 make every DECLARED step fully attributable
// across all four fitness axes. None of them can force declaration itself
// — that's not a composition an API can enforce; a bare `await` between two
// `handler.invoke()` calls is just JavaScript, and no type signature stops
// someone from writing one.
//
// `runClimb` doesn't try. Instead it turns the gap from an unknown-unknown
// into a known-unknown: it measures the WHOLE durable action's wall time,
// sums what every declared step inside that window actually accounted for
// (by querying the SAME `JournalStore` `spec.proof` already reads from —
// no new mechanism, just a different window), and journals the delta as
// `unaccountedMs`. A climb that is 35 minutes long with 10 minutes of
// declared steps now says so, explicitly, in one journaled number — instead
// of saying nothing at all.
//
// This is honestly partial. The MINUTE is now attributable; the WORK inside
// it still isn't — `runClimb` can name that 25 minutes are unaccounted for,
// not what happened during them. See the find-shape doc's closing synthesis
// for why that's the honest stopping point, not a gap this round hides.

export interface ClimbResult<T> {
  readonly output: T;
  readonly totalMs: Millis;
  readonly accountedMs: number;
  readonly unaccountedMs: number;
  readonly stepCount: number;
}

export async function runClimb<T>(
  name: string,
  deps: { readonly clock: Clock; readonly journal: Journal<HandlerEvent>; readonly journalStore: JournalStore },
  fn: () => Promise<T>,
): Promise<ClimbResult<T>> {
  const startedAt = deps.clock.now();
  const output = await fn();
  const completedAt = deps.clock.now();
  const totalMs = elapsedSince(completedAt.monoMs, startedAt.monoMs);

  // Every step journaled by `defineDurableStep` (or any handler at all)
  // whose window falls inside this climb's span. `windowMs` only needs to
  // be at least `totalMs` — the `where` predicate does the real isolation.
  const events = await deps.journalStore.query(
    {
      where: (e) => e.startedAt.wallMs >= startedAt.wallMs && e.completedAt.wallMs <= completedAt.wallMs,
    },
    ms(totalMs + 1),
  );

  const accountedMs = events.reduce((sum, e) => sum + e.durationMs, 0);
  const unaccountedMs = Math.max(0, totalMs - accountedMs);

  const event: HandlerEvent = {
    name: `climb.${name}`,
    invocationId: `climb-${name}-${completedAt.monoMs.toString(36)}`,
    source: "climb",
    startedAt,
    completedAt,
    durationMs: totalMs,
    attempts: 1,
    outcome: "success",
    observed: { stepCount: events.length, accountedMs, unaccountedMs },
  };
  deps.journal.append(event);

  return { output, totalMs, accountedMs, unaccountedMs, stepCount: events.length };
}
