# DB-PG

The Postgres driver for `@phyxiusjs/db`. Wraps `pg.Pool` as the connection source and translates Postgres `SQLSTATE` codes into the typed `DbError` union.

---

## What this really is

A ~150-line translator plus a **curated SQLSTATE mapping table**. The table is the real product.

Postgres defines hundreds of error codes. Most handler-policy decisions only care about a handful of them — _is this retryable? is it a constraint I programmed? is this infrastructure down?_ — and the rest should fall through to a single generic `QUERY_ERROR` until a real system hits one often enough to justify a variant.

This package is where that table lives. Adding a new specific code is a one-line change in `error-map.ts`; removing one is just as surgical. The downstream retry policies and observability don't care whether the mapping is five codes or fifty — they only care that the variants they read are stable.

Everything else a Postgres driver could do — connection pooling, query building, prepared-statement caching, type parsers — lives in `pg` itself. This adapter is deliberately small.

---

## Installation

```bash
npm install @phyxiusjs/db @phyxiusjs/db-pg pg
```

---

## Quick start

```ts
import { createSystemClock } from "@phyxiusjs/clock";
import { createDb } from "@phyxiusjs/db";
import { createPgDriver } from "@phyxiusjs/db-pg";
import { z } from "zod";

const clock = createSystemClock();
const driver = createPgDriver({
  connectionString: process.env.DATABASE_URL,
});
const db = createDb({ driver, clock });

const userSchema = z.object({ id: z.number(), email: z.string() });

await db.transaction(async () => {
  const users = await db.current().query(userSchema, "SELECT * FROM users WHERE id = $1", [42]);
  return users;
});
```

That's the whole integration. `createPgDriver` returns a `DbDriver` — the rest of the API comes from `@phyxiusjs/db`.

---

## Options

```ts
interface PgDriverOptions {
  connectionString?: string;
  poolConfig?: pg.PoolConfig;
  pool?: pg.Pool;
}
```

Three ways to construct:

- **`connectionString`** — the common case. `postgres://user:pass@host:5432/dbname`.
- **`poolConfig`** — the full `pg.PoolConfig` surface (SSL settings, max connections, idle timeouts). We forward it untouched.
- **`pool`** — an already-built `pg.Pool` you want the driver to reuse. Use this when you already own pool lifecycle (e.g. shared across two Phyxius apps, constructed with instrumentation, or managed by your own DI container).

Supplying `pool` means `driver.close()` will still call `pool.end()` — if you want to manage shutdown yourself, don't call `driver.close()`.

---

## SQLSTATE mapping

The curated table. Every Postgres error that has a clear handler-policy implication is mapped to a named variant; everything else falls through to `QUERY_ERROR`. The intent of each variant — _retry, surface, fail_ — is in the third column.

| SQLSTATE            | Postgres name                                       | DbError variant         | Intent                 |
| ------------------- | --------------------------------------------------- | ----------------------- | ---------------------- |
| `08000`             | `connection_exception`                              | `CONNECTION_ERROR`      | Retry with backoff     |
| `08001`             | `sqlclient_unable_to_establish_sqlconnection`       | `CONNECTION_ERROR`      | Retry with backoff     |
| `08003`             | `connection_does_not_exist`                         | `CONNECTION_ERROR`      | Retry with backoff     |
| `08004`             | `sqlserver_rejected_establishment_of_sqlconnection` | `CONNECTION_ERROR`      | Retry with backoff     |
| `08006`             | `connection_failure`                                | `CONNECTION_ERROR`      | Retry with backoff     |
| `08007`             | `transaction_resolution_unknown`                    | `CONNECTION_ERROR`      | Retry with backoff     |
| `08P01`             | `protocol_violation`                                | `CONNECTION_ERROR`      | Retry with backoff     |
| `23505`             | `unique_violation`                                  | `UNIQUE_VIOLATION`      | Surface to caller      |
| `23503`             | `foreign_key_violation`                             | `FOREIGN_KEY_VIOLATION` | Surface to caller      |
| `23502`             | `not_null_violation`                                | `NOT_NULL_VIOLATION`    | Surface to caller      |
| `23514`             | `check_violation`                                   | `CHECK_VIOLATION`       | Surface to caller      |
| `40P01`             | `deadlock_detected`                                 | `DEADLOCK`              | Retry with backoff     |
| `40001`             | `serialization_failure`                             | `SERIALIZATION_FAILURE` | Retry with backoff     |
| `57014`             | `query_canceled` (e.g. `statement_timeout`)         | `TIMEOUT`               | Fail fast / degrade    |
| _(everything else)_ |                                                     | `QUERY_ERROR`           | Fail, log, investigate |

Plus Node-level errno codes from the socket layer (no SQLSTATE):

| `errno`        | DbError variant    | Intent             |
| -------------- | ------------------ | ------------------ |
| `ECONNREFUSED` | `CONNECTION_ERROR` | Retry with backoff |
| `ENOTFOUND`    | `CONNECTION_ERROR` | Retry with backoff |
| `EHOSTUNREACH` | `CONNECTION_ERROR` | Retry with backoff |
| `ECONNRESET`   | `CONNECTION_ERROR` | Retry with backoff |

### Why not more codes?

The mapping is deliberately narrow. `23001` (`restrict_violation`) and `23P01` (`exclusion_violation`) fall through to `QUERY_ERROR` — they're rare enough that adding variants would over-model the union. If a real system hits one regularly, adding a case is a one-line change; until then the surface stays lean.

The principle: **every variant must have a policy implication**. If the handler would do exactly the same thing it does for `QUERY_ERROR`, don't model it.

### Why duck-typing, not `instanceof`?

We check `.code` on the thrown value rather than `instanceof pg.DatabaseError`. The class identity isn't guaranteed stable across pg versions, across proxies (bluebird-wrapped drivers, cls-hooked, etc.), or across bundler boundaries — duck-typing the `.code` field is more robust and has no practical downside for a mapping layer.

---

## Using the mapping directly

`mapPgError` is pure — same input, same output. Import it for custom drivers (e.g. wrapping `postgres.js` instead of `pg`) or for tests that need to assert on error translations:

```ts
import { mapPgError } from "@phyxiusjs/db-pg";

const err = { code: "23505", constraint: "users_email_key" };
const mapped = mapPgError(err);
// { type: "UNIQUE_VIOLATION", constraint: "users_email_key", cause: { code: "23505", ... } }
```

The second argument lets you attach the originating SQL for `QUERY_ERROR` fall-through:

```ts
mapPgError(rawError, { sql: "SELECT * FROM orders WHERE id = $1" });
```

---

## Transaction lifecycle

The driver wraps `pg.PoolClient` with four operations: `query`, `begin`, `commit`, `rollback`. Each one is what you'd expect, with one detail:

**`rollback` MUST NOT throw.** If the server already rolled us back (fatal error aborted the transaction, connection dropped mid-tx), `ROLLBACK` returns an error. The driver swallows it. This is the `DbConnection` contract from `@phyxiusjs/db`: rollback is best-effort because the caller is already on a failure path and doesn't want a second throw shadowing the real cause.

Connection release is tracked via a symbol-keyed property on the `DbConnection` — the driver doesn't expose `pg.PoolClient` on the public surface, but it needs to find the release function when `releaseConnection` fires. This is an implementation detail you can ignore unless you're building something on top of the raw driver.

---

## Retry policy — the payoff

With typed errors, retry becomes a one-liner:

```ts
import { retry } from "@phyxiusjs/retry";
import { isErr } from "@phyxiusjs/fp";

const policy = retry.exponential({
  maxAttempts: 3,
  initialDelay: ms(100),
  shouldRetry: (err) =>
    err.type === "DEADLOCK" || err.type === "SERIALIZATION_FAILURE" || err.type === "CONNECTION_ERROR",
});
```

`UNIQUE_VIOLATION` never retries — it's a real condition, not infrastructure noise. `CONNECTION_ERROR` and the two transaction-rollback variants retry cleanly. Nothing else. No "retry on every error" anti-pattern, no "catch everything and hope."

This is the whole reason the mapping table exists. The variants are named so that retry decisions can be named.

---

## Testing

The driver's own tests use a fake `pg.Pool` — no real database required. `error-map.ts` is pure and has its own test file; `driver.ts` tests the contract against a pool stub:

```ts
import { createPgDriver } from "@phyxiusjs/db-pg";

const fakePool = {
  connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release: () => {} }),
  end: async () => {},
};

const driver = createPgDriver({ pool: fakePool as unknown as pg.Pool });
const conn = await driver.acquireConnection();
await conn.begin();
await conn.query("SELECT 1", []);
await conn.commit();
await driver.releaseConnection(conn);
```

For integration testing against a live Postgres, wire `createPgDriver` to a testcontainer — the driver is a thin wrapper so there's no mock-vs-real surface area to worry about.

---

## What this does NOT do

- **No connection pooling.** `pg.Pool` already does this; we forward it.
- **No migrations.** Build-time concern, separate tooling.
- **No query builder.** Use raw SQL with `Validator<T>`, or layer Drizzle / Kysely on top.
- **No type parser customization.** Configure it on the pool before handing it to the driver.
- **No `postgres.js` or `postgres-pool` support.** Those are separate drivers — the `DbDriver` interface is small enough (~50 lines) that writing them is a one-afternoon job if you want to.

---

## What you get

- **A curated SQLSTATE mapping.** Every variant has a policy implication; every code with a policy implication is mapped.
- **Retry that means something.** `DEADLOCK` and `SERIALIZATION_FAILURE` retry; `UNIQUE_VIOLATION` doesn't. You don't have to think about it.
- **Infrastructure failures named, not buried.** `CONNECTION_ERROR` is a named variant covering seven SQLSTATE codes and four Node errnos — one predicate, one dashboard, one alert.
- **Pure mapping layer.** `mapPgError` is a function with no state and no side effects; tests and custom drivers can import and reuse it directly.

The driver is ~150 lines because the work it does is narrow: translate `pg` into the `DbDriver` interface, and translate `pg` errors into `DbError`. The value isn't in the code — it's in the mapping table.
