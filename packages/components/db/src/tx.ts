import { elapsedSince } from "@phyxiusjs/clock";
import type { Clock, Millis } from "@phyxiusjs/clock";
import { err, ok, type Result } from "@phyxiusjs/fp";
import { validate, type Validator } from "@phyxiusjs/validate";

import type { DbConnection, DbDriver, DbError, DbEvent, DbQueryResult, Tx } from "./types.js";

type DbQueryResultShape = Pick<DbQueryResult, "rows" | "rowCount">;

// ── Public: makeTx ─────────────────────────────────────────────────────────

/**
 * Build a `Tx` over a live `DbConnection`. The Tx is only valid for the
 * lifetime of the containing transaction scope; callers should get it via
 * `db.current()` inside a `db.transaction` and never cache it across
 * transaction boundaries.
 */
export function makeTx(options: {
  readonly conn: DbConnection;
  readonly driver: DbDriver;
  readonly clock: Clock;
  readonly queryTimeoutMs: Millis | undefined;
  readonly emit: ((event: DbEvent) => void) | undefined;
}): Tx {
  const { conn, driver, clock, queryTimeoutMs, emit } = options;

  async function runQuery(
    sql: string,
    params: ReadonlyArray<unknown>,
  ): Promise<Result<{ rows: ReadonlyArray<unknown>; rowCount: number }, DbError>> {
    const startMono = clock.now().monoMs;
    emitEvent(emit, { type: "db:query-started", at: clock.now(), sql });

    try {
      const queryPromise = conn.query(sql, params);
      const result: RaceResult<DbQueryResultShape> =
        queryTimeoutMs !== undefined
          ? await raceTimeout(queryPromise, queryTimeoutMs, clock)
          : { kind: "value", value: await queryPromise };

      if (result.kind === "timeout") {
        const dbError: DbError = {
          type: "TIMEOUT",
          timeoutMs: queryTimeoutMs as number,
        };
        emitEvent(emit, { type: "db:query-failed", at: clock.now(), sql, error: dbError });
        return err(dbError);
      }

      const { rows, rowCount } = result.value;
      const durationMs = elapsedSince(clock.now().monoMs, startMono);
      emitEvent(emit, {
        type: "db:query-completed",
        at: clock.now(),
        sql,
        durationMs,
        rowCount,
      });
      return ok({ rows, rowCount });
    } catch (cause) {
      const dbError = driver.mapError(cause, { sql });
      emitEvent(emit, { type: "db:query-failed", at: clock.now(), sql, error: dbError });
      return err(dbError);
    }
  }

  return {
    async query<T>(
      schema: Validator<T>,
      sql: string,
      params: ReadonlyArray<unknown> = [],
    ): Promise<Result<ReadonlyArray<T>, DbError>> {
      const result = await runQuery(sql, params);
      if (result._tag === "Err") return result;

      const validated: T[] = [];
      for (const row of result.value.rows) {
        const parsed = validate(schema, row);
        if (parsed._tag === "Err") {
          return err({ type: "VALIDATION_ERROR", error: parsed.error });
        }
        validated.push(parsed.value);
      }
      return ok(validated);
    },

    async queryOne<T>(
      schema: Validator<T>,
      sql: string,
      params: ReadonlyArray<unknown> = [],
    ): Promise<Result<T, DbError>> {
      const result = await runQuery(sql, params);
      if (result._tag === "Err") return result;

      const firstRow = result.value.rows[0];
      if (firstRow === undefined) {
        return err({
          type: "QUERY_ERROR",
          sql,
          cause: new Error("queryOne: expected at least one row, got zero"),
        });
      }

      const parsed = validate(schema, firstRow);
      if (parsed._tag === "Err") {
        return err({ type: "VALIDATION_ERROR", error: parsed.error });
      }
      return ok(parsed.value);
    },

    async execute(
      sql: string,
      params: ReadonlyArray<unknown> = [],
    ): Promise<Result<{ rowsAffected: number }, DbError>> {
      const result = await runQuery(sql, params);
      if (result._tag === "Err") return result;
      return ok({ rowsAffected: result.value.rowCount });
    },
  };
}

// ── Internals ──────────────────────────────────────────────────────────────

type RaceResult<T> = { kind: "value"; value: T } | { kind: "timeout" };

/**
 * Race a promise against a clock-driven deadline. The timeout path uses
 * `Clock.timeout` so controlled clocks in tests stay deterministic.
 *
 * Note: if the query loses the race, it keeps running in the background
 * until the driver resolves it. There's no portable way to cancel an
 * in-flight query mid-flight (some drivers support cancellation; others
 * don't). The TIMEOUT result surfaces the symptom; the driver decides
 * what happens to the actual work.
 */
async function raceTimeout<T>(work: Promise<T>, timeoutMs: Millis, clock: Clock): Promise<RaceResult<T>> {
  const budget = clock.timeout(timeoutMs);
  try {
    const value = await Promise.race([
      work.then((v): RaceResult<T> => ({ kind: "value", value: v })),
      clock.deadline(budget.deadline).then((): RaceResult<T> => ({ kind: "timeout" })),
    ]);
    return value;
  } finally {
    budget.release();
  }
}

function emitEvent(emit: ((event: DbEvent) => void) | undefined, event: DbEvent): void {
  if (!emit) return;
  try {
    emit(event);
  } catch {
    // Emitter failures are the emitter's problem; never cascade.
  }
}
