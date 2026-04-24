import type { DbConnection, DbDriver, DbError, DbQueryResult } from "./types.js";

// ── Public: createMemoryDriver ─────────────────────────────────────────────

/**
 * A deterministic in-memory driver for tests, examples, and local dev.
 *
 * It is NOT a SQL engine. `query()` does nothing with the SQL text itself
 * — callers configure a `handler` that inspects the incoming SQL+params
 * and returns rows (or throws to simulate errors). The point is to exercise
 * transaction lifecycle, commit/rollback paths, nested tx composition,
 * connection pool semantics, and error mapping — without a real database.
 *
 * For integration tests that need actual SQL, write a driver over
 * better-sqlite3 or a real Postgres. The shape is the same; the engine
 * is different.
 */
export interface MemoryDriver extends DbDriver {
  /** Replace the query handler after construction (test-only). */
  setHandler(handler: MemoryQueryHandler): void;

  /** Snapshot of every operation observed by the driver, in order. */
  getLog(): ReadonlyArray<MemoryDriverLogEntry>;

  /** Clear the op log. */
  clearLog(): void;

  /** How many connections are currently checked out of the pool. */
  getActiveConnections(): number;
}

export type MemoryQueryHandler = (
  sql: string,
  params: ReadonlyArray<unknown>,
) => DbQueryResult | Promise<DbQueryResult>;

export type MemoryDriverLogEntry =
  | { readonly type: "acquire"; readonly connId: number }
  | { readonly type: "release"; readonly connId: number }
  | { readonly type: "begin"; readonly connId: number }
  | { readonly type: "commit"; readonly connId: number }
  | { readonly type: "rollback"; readonly connId: number }
  | {
      readonly type: "query";
      readonly connId: number;
      readonly sql: string;
      readonly params: ReadonlyArray<unknown>;
    };

export interface MemoryDriverOptions {
  /**
   * Called for every query. Default: returns an empty result set. Tests
   * override this to simulate specific query results, throw to simulate
   * errors, or inspect the SQL+params that came through.
   */
  readonly handler?: MemoryQueryHandler;

  /**
   * Map a thrown error to a `DbError`. Default: wraps every throw as
   * `QUERY_ERROR` unless the error already looks like a DbError (has a
   * string `type` that matches a known variant). Tests that want to
   * exercise specific error paths can throw pre-shaped DbError objects.
   */
  readonly mapError?: (cause: unknown, context?: { sql?: string }) => DbError;
}

/**
 * Build a new in-memory driver.
 */
export function createMemoryDriver(options: MemoryDriverOptions = {}): MemoryDriver {
  const log: MemoryDriverLogEntry[] = [];
  let nextConnId = 1;
  let activeConnections = 0;
  let currentHandler: MemoryQueryHandler = options.handler ?? (() => ({ rows: [], rowCount: 0 }));
  const mapErrorFn = options.mapError ?? defaultMapError;

  function acquireConnection(): Promise<DbConnection> {
    const connId = nextConnId++;
    activeConnections += 1;
    log.push({ type: "acquire", connId });

    const conn: DbConnection = {
      async query(sql, params) {
        log.push({ type: "query", connId, sql, params });
        return await currentHandler(sql, params);
      },
      async begin() {
        log.push({ type: "begin", connId });
      },
      async commit() {
        log.push({ type: "commit", connId });
      },
      async rollback() {
        log.push({ type: "rollback", connId });
      },
    };

    return Promise.resolve(conn);
  }

  async function releaseConnection(_conn: DbConnection): Promise<void> {
    // The connection's identity is implicit in the log — we don't track per-conn
    // ownership here because the MemoryDriver is test-shaped, not pool-shaped.
    // The `log` is the authority on what happened.
    activeConnections = Math.max(0, activeConnections - 1);
    // Best-effort: find the most recent `acquire` without a matching `release`
    // and log a `release` for it. This keeps the log readable for assertions.
    const lastAcquire = [...log].reverse().find((entry) => entry.type === "acquire");
    if (lastAcquire && lastAcquire.type === "acquire") {
      log.push({ type: "release", connId: lastAcquire.connId });
    }
  }

  function mapError(cause: unknown, ctx?: { sql?: string }): DbError {
    return mapErrorFn(cause, ctx);
  }

  return {
    acquireConnection,
    releaseConnection,
    mapError,
    setHandler(handler) {
      currentHandler = handler;
    },
    getLog() {
      return [...log];
    },
    clearLog() {
      log.length = 0;
    },
    getActiveConnections() {
      return activeConnections;
    },
  };
}

// ── Default error mapper ──────────────────────────────────────────────────

const KNOWN_ERROR_TYPES = new Set([
  "CONNECTION_ERROR",
  "QUERY_ERROR",
  "VALIDATION_ERROR",
  "TIMEOUT",
  "DEADLOCK",
  "SERIALIZATION_FAILURE",
  "UNIQUE_VIOLATION",
  "FOREIGN_KEY_VIOLATION",
  "NOT_NULL_VIOLATION",
  "CHECK_VIOLATION",
  "INVALID_TRANSACTION",
]);

function defaultMapError(cause: unknown, ctx?: { sql?: string }): DbError {
  // If the caller already threw a shaped DbError, respect it.
  if (
    typeof cause === "object" &&
    cause !== null &&
    "type" in cause &&
    typeof (cause as { type: unknown }).type === "string" &&
    KNOWN_ERROR_TYPES.has((cause as { type: string }).type)
  ) {
    return cause as DbError;
  }
  return { type: "QUERY_ERROR", sql: ctx?.sql ?? "", cause };
}
