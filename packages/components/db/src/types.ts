import type { Clock, Instant, Millis } from "@phyxiusjs/clock";
import type { Result } from "@phyxiusjs/fp";
import type { Validator, ValidationError } from "@phyxiusjs/validate";

// ── Errors ────────────────────────────────────────────────────────────────

/**
 * Every failure mode a database operation can produce, as a typed value.
 * Drivers map their native error codes / SQL states to these variants.
 *
 * The union mirrors the philosophy of `HandlerError`: every failure has a
 * name, every name is pattern-matchable, no throws cross the boundary.
 *
 *   CONNECTION_ERROR        — pool empty, network down, server unreachable.
 *   QUERY_ERROR             — driver rejected the query (syntax, type, etc.).
 *   VALIDATION_ERROR        — rows came back but failed row-schema validation.
 *   TIMEOUT                 — query exceeded its budget.
 *   DEADLOCK                — deadlock detected (Postgres 40P01, MySQL 1213).
 *                             Usually retryable with exponential backoff.
 *   SERIALIZATION_FAILURE   — serializable isolation rolled us back (Postgres
 *                             40001). Also retryable.
 *   UNIQUE_VIOLATION        — unique constraint hit (Postgres 23505).
 *                             NOT retryable; surface to the caller.
 *   FOREIGN_KEY_VIOLATION   — FK constraint hit (23503). Not retryable.
 *   NOT_NULL_VIOLATION      — NOT NULL hit (23502). Not retryable.
 *   CHECK_VIOLATION         — CHECK constraint hit (23514). Not retryable.
 *   INVALID_TRANSACTION     — called outside a transaction scope, or a nested
 *                             call violated tx invariants.
 */
export type DbError =
  | { readonly type: "CONNECTION_ERROR"; readonly cause: unknown }
  | { readonly type: "QUERY_ERROR"; readonly sql: string; readonly cause: unknown }
  | { readonly type: "VALIDATION_ERROR"; readonly error: ValidationError }
  | { readonly type: "TIMEOUT"; readonly timeoutMs: number }
  | { readonly type: "DEADLOCK"; readonly cause?: unknown }
  | { readonly type: "SERIALIZATION_FAILURE"; readonly cause?: unknown }
  | {
      readonly type: "UNIQUE_VIOLATION";
      readonly constraint?: string;
      readonly cause?: unknown;
    }
  | {
      readonly type: "FOREIGN_KEY_VIOLATION";
      readonly constraint?: string;
      readonly cause?: unknown;
    }
  | {
      readonly type: "NOT_NULL_VIOLATION";
      readonly column?: string;
      readonly cause?: unknown;
    }
  | {
      readonly type: "CHECK_VIOLATION";
      readonly constraint?: string;
      readonly cause?: unknown;
    }
  | { readonly type: "INVALID_TRANSACTION"; readonly reason: string };

// ── Driver contract ───────────────────────────────────────────────────────

/**
 * The driver contract — the seam between Phyxius's typed API and a concrete
 * database client (pg, mysql2, better-sqlite3, etc.). A driver implementation
 * is ~50 lines: acquire connections from its pool, expose begin/commit/
 * rollback/query, translate native errors to `DbError`.
 *
 * Like `MessageSource` for queues, this is the shape that keeps the rest
 * of Phyxius portable across database engines.
 */
export interface DbDriver {
  /**
   * Acquire a connection from the driver's pool. May block (up to the
   * driver's own timeout) if the pool is exhausted.
   */
  acquireConnection(): Promise<DbConnection>;

  /**
   * Release a connection back to the pool. Must be idempotent — the
   * caller may release the same connection twice if cleanup cascades.
   */
  releaseConnection(conn: DbConnection): Promise<void>;

  /**
   * Translate a driver-native error into a typed `DbError`. Called by
   * `createDb` whenever an operation throws. Drivers own this mapping
   * because Postgres, MySQL, and SQLite each use different code systems.
   */
  mapError(cause: unknown, context?: { sql?: string }): DbError;

  /**
   * Optional: clean driver shutdown (close the pool, end all connections).
   * Called when `db.close()` fires.
   */
  close?(): Promise<void>;
}

/**
 * A single connection handle. Operations on a connection are sequential;
 * concurrency comes from using multiple connections (via the pool).
 */
export interface DbConnection {
  /** Run a raw query and return the rows as `unknown[]`. Validation happens above. */
  query(sql: string, params: ReadonlyArray<unknown>): Promise<DbQueryResult>;

  /** BEGIN. Errors propagate to the caller. */
  begin(): Promise<void>;

  /** COMMIT. Errors propagate to the caller. */
  commit(): Promise<void>;

  /** ROLLBACK. Errors MUST be swallowed by the driver — rollback is best-effort. */
  rollback(): Promise<void>;
}

export interface DbQueryResult {
  readonly rows: ReadonlyArray<unknown>;
  readonly rowCount: number;
}

// ── Transaction handle ────────────────────────────────────────────────────

/**
 * The value handed to code running inside a transaction scope. All queries
 * that must respect transactional isolation go through `Tx`. A `Tx` is a
 * scoped view of a `DbConnection` — it's valid only while the transaction
 * is open. Store it nowhere; prefer `db.current()` to re-read it.
 */
export interface Tx {
  /**
   * Run a query and validate each row against the schema. Returns
   * `Err(VALIDATION_ERROR)` if any row fails; returns `Err(QUERY_ERROR)`
   * if the driver rejects the SQL. Success returns the typed row array.
   */
  query<T>(
    schema: Validator<T>,
    sql: string,
    params?: ReadonlyArray<unknown>,
  ): Promise<Result<ReadonlyArray<T>, DbError>>;

  /**
   * Convenience for a single-row query. Validates the row shape and
   * returns `Err({ type: "QUERY_ERROR" })` with "no rows" cause if the
   * query returned zero rows.
   */
  queryOne<T>(schema: Validator<T>, sql: string, params?: ReadonlyArray<unknown>): Promise<Result<T, DbError>>;

  /**
   * Fire a statement without expecting rows (INSERT, UPDATE, DELETE, DDL).
   * Returns the affected-row count when the driver exposes it.
   */
  execute(sql: string, params?: ReadonlyArray<unknown>): Promise<Result<{ readonly rowsAffected: number }, DbError>>;
}

// ── Db (the thing callers actually hold) ──────────────────────────────────

export interface Db {
  /**
   * Run `fn` inside a transaction. Commits if `fn` resolves; rolls back
   * if `fn` throws or returns `Err`. The active `Tx` is available via
   * `db.current()` at any depth of async calls inside `fn`.
   *
   * Nested `transaction()` calls share the outer transaction — they do
   * NOT open savepoints. That's a conscious v1 choice: most applications
   * want "if anything in this block fails, roll everything back," not
   * "rollback to a partial snapshot." Savepoint support can be added
   * later without breaking this contract.
   */
  transaction<T>(fn: () => Promise<T>): Promise<Result<T, DbError>>;

  /**
   * Read the current transaction from the context scope. Throws if called
   * outside a transaction. The throw is deliberate: calling a function that
   * expects a transaction outside of one is always a bug, and silent nulls
   * would turn it into a confusing runtime error later.
   */
  current(): Tx;

  /**
   * Same as `current()`, but returns `null` outside a transaction instead
   * of throwing. Use when the same function is legal both inside and
   * outside a transaction (rare).
   */
  maybeCurrent(): Tx | null;

  /** Clean up driver resources. Idempotent. */
  close(): Promise<void>;
}

// ── Factory options ───────────────────────────────────────────────────────

export interface DbOptions {
  readonly driver: DbDriver;
  readonly clock: Clock;
  /**
   * Optional query-level timeout. When set, every `tx.query` / `tx.execute`
   * call is raced against a `Clock.deadline`; a loss surfaces as TIMEOUT.
   * Default: undefined (no per-query timeout; the driver's own timeouts
   * still apply).
   */
  readonly queryTimeoutMs?: Millis;
  /** Optional observability sink. Fires on every op boundary. */
  readonly emit?: (event: DbEvent) => void;
}

// ── Events ────────────────────────────────────────────────────────────────

/**
 * Lifecycle and per-query events. Wire `emit` into a journal to get full
 * observability on DB activity — slow queries, retry-eligible failures,
 * transaction lifetimes.
 */
export type DbEvent =
  | {
      readonly type: "db:transaction-started";
      readonly at: Instant;
      readonly nested: boolean;
    }
  | {
      readonly type: "db:transaction-committed";
      readonly at: Instant;
      readonly durationMs: number;
    }
  | {
      readonly type: "db:transaction-rolled-back";
      readonly at: Instant;
      readonly durationMs: number;
      readonly cause: unknown;
    }
  | {
      readonly type: "db:query-started";
      readonly at: Instant;
      readonly sql: string;
    }
  | {
      readonly type: "db:query-completed";
      readonly at: Instant;
      readonly sql: string;
      readonly durationMs: number;
      readonly rowCount: number;
    }
  | {
      readonly type: "db:query-failed";
      readonly at: Instant;
      readonly sql: string;
      readonly error: DbError;
    };

// ── Internals exported for driver authors ─────────────────────────────────

/**
 * The well-known string key used to store the active `Tx` in the context's
 * `data` record. Deliberately namespaced so multiple Phyxius packages can
 * coexist in a single context scope without collision. Driver authors and
 * integration code that bridges DB and another primitive may read this;
 * application code should use `db.current()` instead.
 */
export const DB_CONTEXT_TX_KEY = "@phyxiusjs/db:tx" as const;
