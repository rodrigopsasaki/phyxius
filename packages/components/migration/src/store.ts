import type { Clock, Instant, Millis } from "@phyxiusjs/clock";
import { err, ok, type Result } from "@phyxiusjs/fp";
import type { HandlerEvent } from "@phyxiusjs/handler";
import type { Journal } from "@phyxiusjs/journal";

import type { EvidenceSnapshot, JournalQuery } from "./types.js";

// ── JournalStore — the read side of the fleet journal ──────────────────────

/**
 * Read-side contract for journal data. Every evidence source of type
 * `journal-window` runs its query through this interface, never against a
 * process-local journal directly. That's the line that lets a migration
 * work correctly in a single-process deployment (`createMemoryJournalStore`
 * wrapping the in-process `Journal`) and in a fleet deployment (a
 * `createPgJournalStore` / `createDatadogJournalStore` reading from
 * whichever sink the drain writes to).
 *
 * Implementations must pass the conformance suite. Semantics worth
 * calling out:
 *
 *   - `query(q, windowMs)` returns events whose `completedAt.wallMs` is
 *     within `[now - windowMs, now]`, where `now` is the store's view of
 *     time (injected Clock, not `Date.now()`).
 *   - `name`, `outcome`, and `where` filters are AND-combined.
 *   - `limit` is an upper bound; implementations may return fewer. An
 *     omitted `limit` means "all matches," which an adapter backed by a
 *     real logs platform may silently cap — document the cap per adapter.
 *   - Ordering is NOT guaranteed. Predicates should be order-agnostic.
 *
 * Adapters backed by eventually-consistent storage (Datadog logs,
 * CloudWatch) may return stale reads. That's acceptable because the
 * migration primitive is wrong-until-proven-otherwise — a stale read that
 * misses recent legacy writes will refuse to advance a transition that
 * should have been refused. The dangerous direction (missing events that
 * would have passed a predicate → false negative) just delays. The
 * forbidden direction (events appearing that shouldn't have → false
 * positive) is what you design the query + predicate to rule out.
 */
export interface JournalStore {
  query(q: JournalQuery, windowMs: Millis): Promise<readonly HandlerEvent[]>;
}

// ── PhaseStore — the write-side of migration phase state ────────────────────

/**
 * The phase state of a single migration. Reads are cheap; writes use CAS
 * against an expected current phase so two concurrent `advance()` calls
 * can't both succeed.
 *
 * The in-process reference is backed by a plain atom — sufficient for
 * single-container services and tests. Fleet deployments ship a
 * Postgres-backed (or Redis-backed, etc.) implementation where the CAS
 * is a real row-level operation.
 */
export interface PhaseStore {
  /** The currently-committed phase. */
  current(): Promise<string>;

  /**
   * Compare-and-set advance. Succeeds only if the committed phase equals
   * `from`; on success, commits `to` and records the evidence snapshot
   * (implementations may store it for audit or simply pass it through to
   * a journal). On a lost CAS, returns the actual current value.
   */
  tryAdvance(
    from: string,
    to: string,
    evidence: EvidenceSnapshot,
  ): Promise<Result<{ at: Instant }, { actual: string }>>;
}

// ── Memory reference implementations ────────────────────────────────────────

/**
 * In-process `JournalStore` backed by a `Journal`. Use in tests and in
 * scale-1 deployments where the journal is the fleet.
 *
 * Important: this reads the journal's current snapshot at query time.
 * The ring-buffer bound applies — events older than the ring's capacity
 * are gone. For windows longer than your journal capacity, use a
 * persisted store.
 */
export function createMemoryJournalStore(deps: { journal: Journal<HandlerEvent>; clock: Clock }): JournalStore {
  const { journal, clock } = deps;

  return {
    async query(q, windowMs) {
      const now = clock.now();
      const minWallMs = now.wallMs - windowMs;

      const { entries } = journal.getSnapshot();
      const results: HandlerEvent[] = [];

      for (const entry of entries) {
        const event = entry.data;

        // Window filter — rely on the event's `completedAt` rather than
        // the entry's sequence time, because the event is the
        // user-facing truth.
        if (event.completedAt.wallMs < minWallMs) continue;
        if (event.completedAt.wallMs > now.wallMs) continue;

        if (q.name !== undefined && event.name !== q.name) continue;
        if (q.outcome !== undefined && event.outcome !== q.outcome) continue;
        if (q.where !== undefined && !q.where(event)) continue;

        results.push(event);
        if (q.limit !== undefined && results.length >= q.limit) break;
      }

      return results;
    },
  };
}

/**
 * In-process `PhaseStore` using a plain variable behind an async mutex.
 * CAS is atomic because JavaScript is single-threaded — the `await` in
 * `tryAdvance` doesn't yield between the read and the write because we
 * don't yield. Fleet deployments swap this for a Postgres-backed store
 * where CAS is a real database operation.
 */
export function createMemoryPhaseStore(opts: { initial: string; clock: Clock }): PhaseStore {
  let phase = opts.initial;

  return {
    async current() {
      return phase;
    },

    async tryAdvance(from, to, _evidence) {
      if (phase !== from) {
        return err({ actual: phase });
      }
      phase = to;
      return ok({ at: opts.clock.now() });
    },
  };
}
