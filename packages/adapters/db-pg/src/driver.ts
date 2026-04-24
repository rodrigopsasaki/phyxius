import type { DbConnection, DbDriver, DbError, DbQueryResult } from "@phyxiusjs/db";
import pg from "pg";

import { mapPgError } from "./error-map.js";

// ── Options ───────────────────────────────────────────────────────────────

/**
 * Options for `createPgDriver`. Everything here is forwarded to pg.Pool —
 * we intentionally don't invent a wrapper config format, because pg.Pool's
 * options are already a battle-tested surface and inventing our own would
 * create a translation layer with no value. Callers who want to inject a
 * pre-built Pool can supply `pool` directly and skip all config.
 */
export interface PgDriverOptions {
  /**
   * Either the pg.Pool configuration (we construct the Pool) or an
   * already-built pool you want the driver to reuse. Supplying `pool`
   * lets callers manage the pool's lifecycle themselves (shared across
   * multiple Phyxius apps, constructed with instrumentation, etc.).
   */
  readonly connectionString?: string;
  readonly poolConfig?: pg.PoolConfig;
  readonly pool?: pg.Pool;
}

// ── Public: createPgDriver ────────────────────────────────────────────────

/**
 * Build the Postgres `DbDriver` for `@phyxiusjs/db`. Wraps a `pg.Pool` as
 * the connection source and maps SQLSTATE errors to the typed `DbError`
 * union.
 *
 * @example
 * ```ts
 * import { createDb } from "@phyxiusjs/db";
 * import { createPgDriver } from "@phyxiusjs/db-pg";
 * import { createSystemClock } from "@phyxiusjs/clock";
 *
 * const clock = createSystemClock();
 * const driver = createPgDriver({
 *   connectionString: process.env.DATABASE_URL,
 * });
 * const db = createDb({ driver, clock });
 * ```
 */
export function createPgDriver(options: PgDriverOptions = {}): DbDriver {
  const pool = resolvePool(options);

  let closed = false;

  async function acquireConnection(): Promise<DbConnection> {
    // Any failure here (pool.connect throwing, pool-ended, etc.) propagates
    // up to the caller (Resource.make). The driver's mapError translates
    // it into a typed DbError on that side — we don't wrap here because
    // re-throwing without transformation is exactly what the lint rule
    // warns about.
    const client = await pool.connect();
    return wrapClient(client);
  }

  async function releaseConnection(conn: DbConnection): Promise<void> {
    // The `wrapClient` closure owns the pg.PoolClient reference and
    // releases it when we mark the connection done. We store a back-
    // pointer on a symbol-keyed property because the public DbConnection
    // interface deliberately doesn't expose the underlying client.
    const release = (conn as unknown as { [RELEASE_KEY]?: () => void })[RELEASE_KEY];
    if (typeof release === "function") {
      release();
    }
  }

  function mapError(cause: unknown, context?: { sql?: string }): DbError {
    return mapPgError(cause, context);
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    await pool.end();
  }

  return { acquireConnection, releaseConnection, mapError, close };
}

// ── Internals ──────────────────────────────────────────────────────────────

const RELEASE_KEY: unique symbol = Symbol("pg-release");

function resolvePool(options: PgDriverOptions): pg.Pool {
  if (options.pool) return options.pool;

  const config: pg.PoolConfig = { ...(options.poolConfig ?? {}) };
  if (options.connectionString !== undefined) {
    config.connectionString = options.connectionString;
  }
  return new pg.Pool(config);
}

/**
 * Wrap a `pg.PoolClient` as a `DbConnection`. The client is not returned to
 * the pool until `releaseConnection` fires; we stash the release function
 * on a symbol-keyed property so the driver can find it without exposing
 * the pg.PoolClient type on the public connection surface.
 */
function wrapClient(client: pg.PoolClient): DbConnection {
  const conn: DbConnection & { [RELEASE_KEY]?: () => void } = {
    async query(sql: string, params: ReadonlyArray<unknown>): Promise<DbQueryResult> {
      const result = await client.query({
        text: sql,
        values: params as unknown[],
      });
      return {
        rows: result.rows as ReadonlyArray<unknown>,
        rowCount: result.rowCount ?? 0,
      };
    },

    async begin(): Promise<void> {
      await client.query("BEGIN");
    },

    async commit(): Promise<void> {
      await client.query("COMMIT");
    },

    async rollback(): Promise<void> {
      // Rollback is best-effort by the DbConnection contract — if the
      // server already rolled us back (e.g. a fatal error aborted the
      // transaction), `ROLLBACK` returns an error; swallow it.
      try {
        await client.query("ROLLBACK");
      } catch {
        // Intentional: rollback MUST NOT throw.
      }
    },
  };

  conn[RELEASE_KEY] = () => {
    // pg's release() signature: release(err?) — passing a truthy error
    // destroys the connection instead of returning it to the pool. We
    // always return cleanly; the pool will destroy broken connections
    // on the next query attempt.
    client.release();
  };

  return conn;
}
