import { describe, expect, it, vi } from "vitest";

import type { DbConnection } from "@phyxiusjs/db";

import { createPgDriver } from "../src/driver.js";

// These tests don't touch real Postgres — they use a fake pg.Pool and
// assert the driver's contract shape: acquire/release pair, query
// wiring, error mapping, close semantics. Integration against live
// Postgres is a separate concern (testcontainers / docker-compose);
// this file is the unit layer.

interface FakeClient {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

interface FakePool {
  connect: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  _lastClient?: FakeClient;
}

function makeFakePool(opts: { queryResults?: Array<{ rows: unknown[]; rowCount?: number }> } = {}): FakePool {
  const pool: FakePool = {
    connect: vi.fn(),
    end: vi.fn().mockResolvedValue(undefined),
  };

  const queue = [...(opts.queryResults ?? [])];

  pool.connect.mockImplementation(async () => {
    const client: FakeClient = {
      query: vi.fn().mockImplementation(async () => {
        return queue.shift() ?? { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    pool._lastClient = client;
    return client;
  });

  return pool;
}

describe("createPgDriver", () => {
  it("acquireConnection returns a DbConnection shape", async () => {
    const pool = makeFakePool();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const driver = createPgDriver({ pool: pool as any });

    const conn = await driver.acquireConnection();
    expect(typeof conn.query).toBe("function");
    expect(typeof conn.begin).toBe("function");
    expect(typeof conn.commit).toBe("function");
    expect(typeof conn.rollback).toBe("function");

    await driver.releaseConnection(conn);
    expect(pool._lastClient?.release).toHaveBeenCalledTimes(1);
  });

  it("conn.query forwards sql + params to the pg client and reshapes the result", async () => {
    const pool = makeFakePool({
      queryResults: [{ rows: [{ id: 1 }, { id: 2 }], rowCount: 2 }],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const driver = createPgDriver({ pool: pool as any });

    const conn = await driver.acquireConnection();
    const result = await conn.query("SELECT * FROM users WHERE id = $1", [42]);

    expect(pool._lastClient?.query).toHaveBeenCalledWith({
      text: "SELECT * FROM users WHERE id = $1",
      values: [42],
    });
    expect(result.rowCount).toBe(2);
    expect(result.rows).toEqual([{ id: 1 }, { id: 2 }]);

    await driver.releaseConnection(conn);
  });

  it("begin / commit / rollback issue the correct SQL", async () => {
    const pool = makeFakePool();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const driver = createPgDriver({ pool: pool as any });

    const conn = await driver.acquireConnection();
    await conn.begin();
    await conn.commit();
    await conn.rollback();

    const calls = pool._lastClient?.query.mock.calls ?? [];
    expect(calls).toHaveLength(3);
    expect(calls[0]![0]).toBe("BEGIN");
    expect(calls[1]![0]).toBe("COMMIT");
    expect(calls[2]![0]).toBe("ROLLBACK");

    await driver.releaseConnection(conn);
  });

  it("rollback never throws, even if the server rejects it", async () => {
    const pool = makeFakePool();
    pool.connect.mockImplementationOnce(async () => {
      const client: FakeClient = {
        query: vi.fn().mockImplementation(async (q: string | { text: string }) => {
          const text = typeof q === "string" ? q : q.text;
          if (text === "ROLLBACK") throw new Error("no tx in progress");
          return { rows: [], rowCount: 0 };
        }),
        release: vi.fn(),
      };
      pool._lastClient = client;
      return client;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const driver = createPgDriver({ pool: pool as any });

    const conn = await driver.acquireConnection();
    await expect(conn.rollback()).resolves.toBeUndefined();

    await driver.releaseConnection(conn);
  });

  it("releaseConnection returns the pg client to the pool", async () => {
    const pool = makeFakePool();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const driver = createPgDriver({ pool: pool as any });

    const conn = await driver.acquireConnection();
    await driver.releaseConnection(conn);

    expect(pool._lastClient?.release).toHaveBeenCalledTimes(1);
  });

  it("releaseConnection is a no-op on a connection that didn't come from this driver", async () => {
    const pool = makeFakePool();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const driver = createPgDriver({ pool: pool as any });

    // A bare DbConnection (no internal release hook) — release should
    // silently no-op rather than throw.
    const bare: DbConnection = {
      async query() {
        return { rows: [], rowCount: 0 };
      },
      async begin() {},
      async commit() {},
      async rollback() {},
    };
    await expect(driver.releaseConnection(bare)).resolves.toBeUndefined();
  });

  it("close ends the pool exactly once (idempotent)", async () => {
    const pool = makeFakePool();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const driver = createPgDriver({ pool: pool as any });

    await driver.close?.();
    await driver.close?.();
    await driver.close?.();

    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it("mapError delegates to mapPgError (SQLSTATE → DbError)", () => {
    const pool = makeFakePool();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const driver = createPgDriver({ pool: pool as any });

    const err = new Error("unique violation") as Error & { code: string; constraint: string };
    err.code = "23505";
    err.constraint = "users_email_key";

    const mapped = driver.mapError(err);
    expect(mapped.type).toBe("UNIQUE_VIOLATION");
    if (mapped.type === "UNIQUE_VIOLATION") {
      expect(mapped.constraint).toBe("users_email_key");
    }
  });
});
