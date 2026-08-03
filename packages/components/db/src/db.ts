import { elapsedSince } from "@phyxiusjs/clock";
import { context } from "@phyxiusjs/context";
import { err, ok, type Result } from "@phyxiusjs/fp";
import { resource } from "@phyxiusjs/resource";

import { makeTx } from "./tx.js";
import { DB_CONTEXT_TX_KEY, type Db, type DbError, type DbEvent, type DbOptions, type Tx } from "./types.js";

// ── Public: createDb ───────────────────────────────────────────────────────

/**
 * Build the DB facade. Holds a reference to the driver; opens transactions
 * on demand; exposes `current()` / `maybeCurrent()` for scope-local access
 * to the active `Tx`.
 *
 * The whole transaction lifecycle — acquire connection, BEGIN, open context
 * scope, run body, COMMIT or ROLLBACK, release connection — composes through
 * `@phyxiusjs/resource`. Cleanup is guaranteed by construction: whether the
 * body resolves, throws, or the process crashes mid-flight, the resource
 * release path is the single point that returns the connection to the pool.
 */
export function createDb(options: DbOptions): Db {
  const { driver, clock, queryTimeoutMs, emit } = options;

  let closed = false;

  async function transaction<T>(fn: () => Promise<T>): Promise<Result<T, DbError>> {
    if (closed) {
      return err({ type: "INVALID_TRANSACTION", reason: "db is closed" });
    }

    // Nested call: we're already inside a transaction. There is no new
    // lifecycle to open — the outer tx owns acquire/commit/rollback. We
    // run `fn` and return its value, and deliberately DO NOT catch throws:
    // if `fn` throws, the throw propagates up to the outer tx's rollback
    // path. Catching here would silently commit a partially-failed
    // transaction, which is the exact bug transaction semantics exist to
    // prevent.
    //
    // Consequence for the API: nested `db.transaction()` calls never
    // return `Err` — they either return `Ok(value)` or throw. Fresh calls
    // always return a `Result`. This asymmetry is intentional: the fresh
    // call owns the boundary between "has this transaction committed?"
    // and the outside world, so it converts throws into typed errors.
    // Nested calls have no such boundary — there's nothing to convert.
    const outerTx = readCurrentTx();
    if (outerTx !== null) {
      emitEvent(emit, {
        type: "db:transaction-started",
        at: clock.now(),
        nested: true,
      });
      const value = await fn();
      emitEvent(emit, {
        type: "db:transaction-committed",
        at: clock.now(),
        durationMs: 0, // nested tx has no independent lifetime
      });
      return ok(value);
    }

    // Fresh transaction. Acquire a connection via Resource so cleanup is
    // guaranteed on every path.
    const connResource = resource.make(
      () => driver.acquireConnection(),
      (conn) => driver.releaseConnection(conn),
      { name: "db-connection", clock },
    );

    const startMono = clock.now().monoMs;

    try {
      return await connResource.use(async (conn) => {
        // BEGIN. If this throws, no rollback needed.
        try {
          await conn.begin();
        } catch (cause) {
          return err(driver.mapError(cause));
        }

        emitEvent(emit, { type: "db:transaction-started", at: clock.now(), nested: false });

        const tx = makeTx({ conn, driver, clock, queryTimeoutMs, emit });

        // Run `fn` inside a context scope that exposes the tx. Any code
        // called inside — handlers, nested functions, deep call stacks —
        // reaches it via `db.current()`.
        let fnValue: T;
        try {
          fnValue = await context.scope(fn, {
            initial: { [DB_CONTEXT_TX_KEY]: tx } as Record<string, unknown>,
            inherit: true,
          });
        } catch (cause) {
          const rolledBackAt = clock.now();
          await safeRollback(conn);
          emitEvent(emit, {
            type: "db:transaction-rolled-back",
            at: rolledBackAt,
            durationMs: elapsedSince(rolledBackAt.monoMs, startMono),
            cause,
          });
          return err(driver.mapError(cause));
        }

        // fn resolved. Try to commit.
        try {
          await conn.commit();
        } catch (cause) {
          const rolledBackAt = clock.now();
          // Commit itself failed. Attempt rollback best-effort; return the
          // commit error (not the rollback error — the rollback is salvage).
          await safeRollback(conn);
          emitEvent(emit, {
            type: "db:transaction-rolled-back",
            at: rolledBackAt,
            durationMs: elapsedSince(rolledBackAt.monoMs, startMono),
            cause,
          });
          return err(driver.mapError(cause));
        }

        const committedAt = clock.now();
        emitEvent(emit, {
          type: "db:transaction-committed",
          at: committedAt,
          durationMs: elapsedSince(committedAt.monoMs, startMono),
        });
        return ok(fnValue);
      });
    } catch (cause) {
      // Reaches here only if Resource itself fails (acquire/release).
      return err(driver.mapError(cause));
    }
  }

  function current(): Tx {
    const tx = readCurrentTx();
    if (tx === null) {
      throw new Error(
        "db.current() called outside a transaction scope. Wrap the call in db.transaction(...) or use db.maybeCurrent() if the function is legal both inside and outside a transaction.",
      );
    }
    return tx;
  }

  function maybeCurrent(): Tx | null {
    return readCurrentTx();
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    await driver.close?.();
  }

  return { transaction, current, maybeCurrent, close };
}

// ── Internals ──────────────────────────────────────────────────────────────

/**
 * Read the current `Tx` from the active context scope. Returns `null` when
 * there is no active context (i.e. we're outside any Phyxius scope) or the
 * active context has no transaction attached.
 */
function readCurrentTx(): Tx | null {
  const ctx = context.current<Record<string, unknown>>();
  if (!ctx) return null;
  const value = ctx.data[DB_CONTEXT_TX_KEY];
  return value === undefined ? null : (value as Tx);
}

async function safeRollback(conn: { rollback(): Promise<void> }): Promise<void> {
  try {
    await conn.rollback();
  } catch {
    // Rollback is best-effort. Drivers SHOULD not throw, but if one does,
    // we swallow it so the original cause propagates unchanged.
  }
}

function emitEvent(emit: ((event: DbEvent) => void) | undefined, event: DbEvent): void {
  if (!emit) return;
  try {
    emit(event);
  } catch {
    // Emitter failures never cascade.
  }
}
