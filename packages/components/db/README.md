# DB

The database boundary. Transaction-as-context, typed errors, driver-agnostic. The layer that makes DB code stop being a per-handler "don't forget the try/finally" problem and start being a Phyxius primitive like everything else.

---

## What this really is

One narrow mission: **make the "how do I get the current transaction to a function seven stack frames deep?" problem disappear**. That's the single hardest DB problem in most real codebases — the reason ORMs grow "transactional context" features, the reason people pass `tx` as an argument through every call site, the reason refactoring database code is scary.

`@phyxiusjs/db` solves it by composing three things we already have:

- **`@phyxiusjs/context`** — AsyncLocalStorage that flows through async boundaries.
- **`@phyxiusjs/resource`** — guaranteed acquire/release, even on throw.
- **`@phyxiusjs/validate`** — typed rows at the query boundary.

That's the whole package. ~500 lines. It stays out of the way of any ORM or query builder you want on top (Drizzle, Kysely, Prisma), and it doesn't reinvent the driver layer (pg, mysql2, better-sqlite3 — use what you already have). The layers it owns are the ones that compound:

- Transaction boundary (acquire + begin + commit/rollback + release).
- Tx-in-context (no prop-drilling, ever).
- Typed errors (`DEADLOCK`, `SERIALIZATION_FAILURE`, `UNIQUE_VIOLATION`, `TIMEOUT`, …).
- Row validation at the query edge.

Everything else — query building, migrations, schema generation — lives outside.

---

## Installation

```bash
npm install @phyxiusjs/db @phyxiusjs/clock @phyxiusjs/context @phyxiusjs/resource @phyxiusjs/validate @phyxiusjs/fp
```

Plus whatever driver your database needs. See [Writing a driver](#writing-a-driver) below.

---

## Quick start

```ts
import { z } from "zod";
import { createSystemClock } from "@phyxiusjs/clock";
import { createDb } from "@phyxiusjs/db";
import { createPgDriver } from "./drivers/pg"; // your driver

const clock = createSystemClock();
const driver = createPgDriver({ connectionString: process.env.DATABASE_URL });
const db = createDb({ driver, clock });

const userSchema = z.object({ id: z.number(), email: z.string() });

// Read-only path.
const result = await db.transaction(async () => {
  const users = await db.current().query(userSchema, "SELECT * FROM users");
  return users;
});

// Write path — multi-statement atomicity by construction.
await db.transaction(async () => {
  const tx = db.current();
  await tx.execute("INSERT INTO orders (id, customer_id) VALUES ($1, $2)", [orderId, customerId]);
  await tx.execute("INSERT INTO order_items (order_id, sku) VALUES ($1, $2)", [orderId, sku]);
  await notifyWarehouse(orderId); // reads tx via db.current() internally, no argument needed
});
```

`db.current()` works at any depth of async call. The transaction is scoped to the `transaction()` callback; it exists for exactly as long as that callback is running. Throw inside → rollback. Return normally → commit.

---

## The `Db` surface

```ts
interface Db {
  transaction<T>(fn: () => Promise<T>): Promise<Result<T, DbError>>;
  current(): Tx; // throws outside a transaction
  maybeCurrent(): Tx | null; // null outside a transaction
  close(): Promise<void>;
}

interface Tx {
  query<T>(schema: Validator<T>, sql: string, params?: unknown[]): Promise<Result<readonly T[], DbError>>;
  queryOne<T>(schema: Validator<T>, sql: string, params?: unknown[]): Promise<Result<T, DbError>>;
  execute(sql: string, params?: unknown[]): Promise<Result<{ rowsAffected: number }, DbError>>;
}
```

Four methods that matter:

- **`transaction(fn)`** opens a scope. Resources are acquired, BEGIN fires, the Tx is installed in the current context, `fn` runs, and on completion the connection is committed (or rolled back on throw) and released.
- **`current()`** reads the Tx from the active scope. It throws outside a transaction — calling a tx-dependent function outside a tx is always a bug, and silently returning null would turn it into a confusing downstream error.
- **`maybeCurrent()`** is for the rare function that's legal both inside and outside a tx.
- **`tx.query` / `tx.queryOne` / `tx.execute`** are the SQL entry points. Every row goes through `Validator<T>`, so there is no `any[]` leaking into your application code.

---

## Typed errors

Every failure mode is a named value. Drivers translate their native codes (Postgres `SQLSTATE`, MySQL error numbers, SQLite result codes) into this union:

```ts
type DbError =
  | { type: "CONNECTION_ERROR"; cause }
  | { type: "QUERY_ERROR"; sql; cause }
  | { type: "VALIDATION_ERROR"; error: ValidationError }
  | { type: "TIMEOUT"; timeoutMs }
  | { type: "DEADLOCK"; cause? } // retryable
  | { type: "SERIALIZATION_FAILURE"; cause? } // retryable
  | { type: "UNIQUE_VIOLATION"; constraint?; cause? }
  | { type: "FOREIGN_KEY_VIOLATION"; constraint?; cause? }
  | { type: "NOT_NULL_VIOLATION"; column?; cause? }
  | { type: "CHECK_VIOLATION"; constraint?; cause? }
  | { type: "INVALID_TRANSACTION"; reason };
```

The variants that matter for retry policy are distinguished by name: `DEADLOCK` and `SERIALIZATION_FAILURE` are transient and deserve exponential backoff; `UNIQUE_VIOLATION` is a constraint you programmed and should surface to the caller. This matters because it lets you wire retry policies deterministically — no "retry on every error" anti-pattern, no "catch everything and hope" code.

Wrapping a DB operation in `retry.exponential` with a `shouldRetry` that tests `error.type === "DEADLOCK" || error.type === "SERIALIZATION_FAILURE"` is the correct DB retry pattern, and it only works because the variants are named.

---

## Nested transactions

Nested calls reuse the outer transaction. They don't open savepoints and they don't take a new connection:

```ts
await db.transaction(async () => {
  await db.current().execute("A");
  await db.transaction(async () => {
    // Same connection, same tx. No BEGIN here.
    await db.current().execute("B");
  });
  await db.current().execute("C");
});
```

One BEGIN, one COMMIT, three queries. This is deliberate: the semantics callers overwhelmingly want are "if anything in this block fails, roll everything back," not "rollback to a partial snapshot." Savepoint support can be added later (`db.savepoint(fn)`) without breaking this contract.

**If an inner transaction throws, the whole outer transaction rolls back.** This is load-bearing — silently catching an inner throw and committing anyway is the exact bug transaction semantics exist to prevent. The asymmetry:

- **Fresh `db.transaction()`** owns the boundary between the transaction and the outside world. It converts throws into `Err(DbError)` via rollback.
- **Nested `db.transaction()`** has no boundary — its throws propagate to the outer transaction's rollback path. Nested calls never return `Err`; they either return `Ok(value)` or throw.

In practice, this means you can nest freely without thinking about it. Handlers call helpers, helpers call other helpers, every one of them can open a `db.transaction` internally, and they all share the outermost transaction.

---

## Writing a driver

A driver is ~50 lines. Implement three things:

```ts
interface DbDriver {
  acquireConnection(): Promise<DbConnection>;
  releaseConnection(conn: DbConnection): Promise<void>;
  mapError(cause: unknown, context?: { sql?: string }): DbError;
  close?(): Promise<void>;
}

interface DbConnection {
  query(sql: string, params: readonly unknown[]): Promise<{ rows: readonly unknown[]; rowCount: number }>;
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>; // must be best-effort; MUST NOT throw
}
```

A minimal `pg` driver:

```ts
import pg from "pg";
import { createDb } from "@phyxiusjs/db";

export function createPgDriver({ connectionString }: { connectionString: string }) {
  const pool = new pg.Pool({ connectionString });

  return {
    async acquireConnection() {
      const client = await pool.connect();
      return {
        async query(sql, params) {
          const r = await client.query(sql, params as unknown[]);
          return { rows: r.rows, rowCount: r.rowCount ?? 0 };
        },
        async begin() {
          await client.query("BEGIN");
        },
        async commit() {
          await client.query("COMMIT");
        },
        async rollback() {
          try {
            await client.query("ROLLBACK");
          } catch {}
        },
      };
    },
    async releaseConnection(conn) {
      // The conn object is the pg client; release it back to the pool.
      // (Wire this up however your pool API expects.)
    },
    mapError(cause, ctx) {
      if (isPgError(cause)) {
        switch (cause.code) {
          case "23505":
            return { type: "UNIQUE_VIOLATION", constraint: cause.constraint, cause };
          case "23503":
            return { type: "FOREIGN_KEY_VIOLATION", constraint: cause.constraint, cause };
          case "23502":
            return { type: "NOT_NULL_VIOLATION", column: cause.column, cause };
          case "23514":
            return { type: "CHECK_VIOLATION", constraint: cause.constraint, cause };
          case "40P01":
            return { type: "DEADLOCK", cause };
          case "40001":
            return { type: "SERIALIZATION_FAILURE", cause };
          case "ECONNREFUSED":
          case "ENOTFOUND":
            return { type: "CONNECTION_ERROR", cause };
        }
      }
      return { type: "QUERY_ERROR", sql: ctx?.sql ?? "", cause };
    },
    async close() {
      await pool.end();
    },
  };
}
```

Every error mapping decision is in one place. If a new SQLSTATE matters, you add one case. The downstream retry policies don't change.

---

## Testing

`createMemoryDriver` is an in-memory driver for tests. It doesn't run SQL — callers configure a handler that inspects incoming `(sql, params)` and returns rows or throws. It exercises the full transaction lifecycle (BEGIN / COMMIT / ROLLBACK / acquire / release) against real logs you can assert on.

```ts
import { createDb, createMemoryDriver } from "@phyxiusjs/db";
import { createControlledClock } from "@phyxiusjs/clock";

const clock = createControlledClock({ initialTime: 0 });
const driver = createMemoryDriver({
  handler: (sql, params) => {
    if (sql.startsWith("SELECT")) return { rows: [{ id: 1 }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  },
});
const db = createDb({ driver, clock });

await db.transaction(async () => {
  await db.current().execute("INSERT INTO users ...");
});

expect(driver.getLog().map((e) => e.type)).toEqual(["acquire", "begin", "query", "commit", "release"]);
```

The memory driver is ALSO the reference implementation new driver authors should compare their lifecycle semantics against.

---

## Observability

Wire `emit` into a journal and get the full event stream:

```ts
type DbEvent =
  | { type: "db:transaction-started"; at; nested }
  | { type: "db:transaction-committed"; at; durationMs }
  | { type: "db:transaction-rolled-back"; at; durationMs; cause }
  | { type: "db:query-started"; at; sql }
  | { type: "db:query-completed"; at; sql; durationMs; rowCount }
  | { type: "db:query-failed"; at; sql; error };
```

Query durations, rollback frequencies, commit latencies — all visible. Same shape as the rest of Phyxius's event streams.

---

## What this does NOT do

- **No ORM, no query builder.** Use Drizzle, Kysely, or raw SQL with Validator. The DB is a boundary, not a syntax layer.
- **No migrations.** A build-time concern, not a runtime primitive.
- **No connection pooling.** The driver owns that — Phyxius uses whatever pool your driver ships.
- **No savepoints (yet).** Nested transactions reuse the outer transaction. Savepoint support can be added without breaking this contract.
- **No implicit transactions.** Every query goes through a `Tx`, and every `Tx` lives inside a `db.transaction()`. There is no "auto-commit single-statement" mode. Intentional: the common case where you "just want one query" is a one-liner (`db.transaction(async () => db.current().query(...))`) that makes the transaction boundary visible.

---

## What you get

- **Transaction-as-context, solved.** No prop-drilling, no "did someone forget to pass tx?" bugs. The Tx is in scope or it isn't, and the type system tells you which.
- **Every failure mode typed.** `DEADLOCK` and `SERIALIZATION_FAILURE` retry cleanly; `UNIQUE_VIOLATION` surfaces to the caller. Retry policies become deterministic.
- **Guaranteed cleanup.** Every connection returns to the pool, every transaction commits or rolls back, on every path — resource bracketing lives in the primitive, not in every caller's try/finally.
- **Driver-portable.** The same code runs against Postgres, MySQL, SQLite, or an in-memory fake. Drivers are thin; switching engines is a config change, not a refactor.

The DB boundary is where most real systems accumulate technical debt — unowned transaction scopes, untyped errors, retry logic bolted on per-query. Phyxius owns the boundary so your application code stops having to.
