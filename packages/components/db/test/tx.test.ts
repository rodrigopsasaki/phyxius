import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createControlledClock, ms } from "@phyxiusjs/clock";

import { createDb } from "../src/db.js";
import { createMemoryDriver } from "../src/memory-driver.js";
import type { DbQueryResult } from "../src/types.js";

function setup(handler?: (sql: string, params: readonly unknown[]) => DbQueryResult | Promise<DbQueryResult>) {
  const clock = createControlledClock({ initialTime: 0 });
  const driver = createMemoryDriver({ handler });
  const db = createDb({ driver, clock });
  return { clock, driver, db };
}

describe("tx.query — row validation", () => {
  it("returns typed rows when every row validates", async () => {
    const { db } = setup(() => ({
      rows: [
        { id: 1, name: "alice" },
        { id: 2, name: "bob" },
      ],
      rowCount: 2,
    }));

    const userSchema = z.object({ id: z.number(), name: z.string() });

    const result = await db.transaction(async () => {
      const rows = await db.current().query(userSchema, "SELECT * FROM users");
      if (rows._tag === "Err") throw new Error("unexpected failure");
      return rows.value;
    });

    expect(result._tag).toBe("Ok");
    if (result._tag === "Ok") {
      expect(result.value).toEqual([
        { id: 1, name: "alice" },
        { id: 2, name: "bob" },
      ]);
    }
  });

  it("returns VALIDATION_ERROR when any row fails the schema", async () => {
    const { db } = setup(() => ({
      rows: [
        { id: 1, name: "alice" },
        { id: "not-a-number", name: "bob" },
      ],
      rowCount: 2,
    }));

    const userSchema = z.object({ id: z.number(), name: z.string() });

    const result = await db.transaction(async () => {
      const rows = await db.current().query(userSchema, "SELECT * FROM users");
      return rows;
    });

    expect(result._tag).toBe("Ok"); // transaction returned the nested Result
    if (result._tag === "Ok") {
      expect(result.value._tag).toBe("Err");
      if (result.value._tag === "Err") {
        expect(result.value.error.type).toBe("VALIDATION_ERROR");
      }
    }
  });
});

describe("tx.queryOne", () => {
  it("returns the first row validated", async () => {
    const { db } = setup(() => ({
      rows: [{ id: 1, name: "alice" }],
      rowCount: 1,
    }));

    const userSchema = z.object({ id: z.number(), name: z.string() });

    const result = await db.transaction(async () => {
      return await db.current().queryOne(userSchema, "SELECT * FROM users WHERE id = $1", [1]);
    });

    expect(result._tag).toBe("Ok");
    if (result._tag === "Ok" && result.value._tag === "Ok") {
      expect(result.value.value).toEqual({ id: 1, name: "alice" });
    }
  });

  it("returns QUERY_ERROR when zero rows came back", async () => {
    const { db } = setup(() => ({ rows: [], rowCount: 0 }));

    const userSchema = z.object({ id: z.number() });

    const result = await db.transaction(async () => {
      return await db.current().queryOne(userSchema, "SELECT * FROM users WHERE id = $1", [999]);
    });

    expect(result._tag).toBe("Ok");
    if (result._tag === "Ok" && result.value._tag === "Err") {
      expect(result.value.error.type).toBe("QUERY_ERROR");
    }
  });
});

describe("tx.execute", () => {
  it("returns rowsAffected on successful execute", async () => {
    const { db } = setup(() => ({ rows: [], rowCount: 3 }));

    const result = await db.transaction(async () => {
      return await db.current().execute("DELETE FROM users WHERE active = false");
    });

    expect(result._tag).toBe("Ok");
    if (result._tag === "Ok" && result.value._tag === "Ok") {
      expect(result.value.value.rowsAffected).toBe(3);
    }
  });
});

describe("tx — driver error mapping", () => {
  it("surfaces QUERY_ERROR when the driver throws a generic error", async () => {
    const { db } = setup(() => {
      throw new Error("syntax error");
    });

    const result = await db.transaction(async () => {
      return await db.current().execute("NOT VALID SQL");
    });

    expect(result._tag).toBe("Ok");
    if (result._tag === "Ok" && result.value._tag === "Err") {
      expect(result.value.error.type).toBe("QUERY_ERROR");
    }
  });

  it("passes through a pre-shaped DbError (drivers emit typed variants)", async () => {
    const { db } = setup(() => {
      // Driver simulates a unique-constraint violation.
      throw { type: "UNIQUE_VIOLATION", constraint: "users_email_key" };
    });

    const result = await db.transaction(async () => {
      return await db.current().execute("INSERT INTO users ...");
    });

    expect(result._tag).toBe("Ok");
    if (result._tag === "Ok" && result.value._tag === "Err") {
      expect(result.value.error.type).toBe("UNIQUE_VIOLATION");
    }
  });
});

describe("tx — queryTimeoutMs", () => {
  it("returns TIMEOUT when a query exceeds the configured budget", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const driver = createMemoryDriver({
      handler: () =>
        new Promise<DbQueryResult>(() => {
          // Never resolves — the timeout must win.
        }),
    });
    const db = createDb({ driver, clock, queryTimeoutMs: ms(100) });

    const resultPromise = db.transaction(async () => {
      return await db.current().execute("SELECT 1");
    });

    // Let the transaction body reach the await on the query — otherwise
    // the clock advance happens before any timer is registered, and the
    // timeout never fires.
    await clock.flush();

    // Now advance past the deadline.
    clock.advanceBy(ms(150));
    await clock.flush();

    const result = await resultPromise;

    // The transaction body returned an Err (query timed out). That inner Err
    // wasn't thrown, so the transaction commits successfully around it.
    expect(result._tag).toBe("Ok");
    if (result._tag === "Ok" && result.value._tag === "Err") {
      expect(result.value.error.type).toBe("TIMEOUT");
      if (result.value.error.type === "TIMEOUT") {
        expect(result.value.error.timeoutMs).toBe(100);
      }
    }
  });
});
