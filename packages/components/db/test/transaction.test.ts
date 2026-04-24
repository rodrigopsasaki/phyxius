import { describe, expect, it } from "vitest";

import { createSystemClock } from "@phyxiusjs/clock";

import { createDb } from "../src/db.js";
import { createMemoryDriver } from "../src/memory-driver.js";
import type { DbEvent, DbQueryResult } from "../src/types.js";

function setup(handler?: (sql: string, params: readonly unknown[]) => DbQueryResult | Promise<DbQueryResult>) {
  const clock = createSystemClock();
  const driver = createMemoryDriver({ handler });
  const events: DbEvent[] = [];
  const db = createDb({ driver, clock, emit: (e) => events.push(e) });
  return { clock, driver, db, events };
}

describe("transaction lifecycle", () => {
  it("BEGINs and COMMITs on a happy path", async () => {
    const { driver, db } = setup();

    const result = await db.transaction(async () => {
      await db.current().execute("INSERT INTO t VALUES (1)");
      return "done";
    });

    expect(result._tag).toBe("Ok");
    if (result._tag === "Ok") expect(result.value).toBe("done");

    const logTypes = driver.getLog().map((e) => e.type);
    expect(logTypes).toContain("acquire");
    expect(logTypes).toContain("begin");
    expect(logTypes).toContain("query");
    expect(logTypes).toContain("commit");
    expect(logTypes).toContain("release");
    // No rollback in the log.
    expect(logTypes).not.toContain("rollback");
  });

  it("ROLLs BACK when the body throws", async () => {
    const { driver, db } = setup();

    const result = await db.transaction(async () => {
      await db.current().execute("INSERT INTO t VALUES (1)");
      throw new Error("boom");
    });

    expect(result._tag).toBe("Err");

    const logTypes = driver.getLog().map((e) => e.type);
    expect(logTypes).toContain("rollback");
    // And crucially, NOT commit.
    expect(logTypes).not.toContain("commit");
  });

  it("ROLLs BACK on sync throws, not just async ones", async () => {
    const { driver, db } = setup();

    const result = await db.transaction(async () => {
       
      throw "synchronous boom";
    });

    expect(result._tag).toBe("Err");
    expect(driver.getLog().map((e) => e.type)).toContain("rollback");
  });

  it("always releases the connection — even on failure", async () => {
    const { driver, db } = setup();

    await db.transaction(async () => {
      throw new Error("body exploded");
    });

    expect(driver.getActiveConnections()).toBe(0);
    const logTypes = driver.getLog().map((e) => e.type);
    expect(logTypes.filter((t) => t === "acquire")).toHaveLength(1);
    expect(logTypes.filter((t) => t === "release")).toHaveLength(1);
  });

  it("emits a full event stream for successful transactions", async () => {
    const { db, events } = setup();

    await db.transaction(async () => {
      await db.current().execute("SELECT 1");
    });

    const types = events.map((e) => e.type);
    expect(types).toContain("db:transaction-started");
    expect(types).toContain("db:query-started");
    expect(types).toContain("db:query-completed");
    expect(types).toContain("db:transaction-committed");
  });

  it("emits transaction-rolled-back with the cause on failure", async () => {
    const { db, events } = setup();

    await db.transaction(async () => {
      throw new Error("intentional");
    });

    const rolledBack = events.find((e) => e.type === "db:transaction-rolled-back");
    expect(rolledBack).toBeDefined();
    if (rolledBack?.type === "db:transaction-rolled-back") {
      expect((rolledBack.cause as Error).message).toBe("intentional");
    }
  });
});

describe("transaction-as-context — db.current()", () => {
  it("provides the current tx to code inside the scope", async () => {
    const { db } = setup(() => ({ rows: [{ count: 1 }], rowCount: 1 }));

    const result = await db.transaction(async () => {
      const tx = db.current();
      expect(tx).toBeDefined();
      const r = await tx.execute("UPDATE t SET x = 2");
      return r;
    });

    expect(result._tag).toBe("Ok");
  });

  it("propagates the tx through nested async calls without prop-drilling", async () => {
    const { db, driver } = setup();

    async function nestedWork(): Promise<void> {
      // No argument — reads the tx from context.
      await db.current().execute("UPDATE nested SET flag = true");
    }

    async function deeplyNestedWork(): Promise<void> {
      await nestedWork();
      await db.current().execute("UPDATE deep SET flag = true");
    }

    await db.transaction(async () => {
      await deeplyNestedWork();
    });

    // Both nested queries ran under the same tx / same connection.
    const queries = driver.getLog().filter((e) => e.type === "query");
    expect(queries).toHaveLength(2);
    const connIds = new Set(queries.map((q) => q.connId));
    expect(connIds.size).toBe(1);
  });

  it("throws when called outside a transaction", () => {
    const { db } = setup();
    expect(() => db.current()).toThrow(/outside a transaction/);
  });

  it("maybeCurrent() returns null outside a transaction", () => {
    const { db } = setup();
    expect(db.maybeCurrent()).toBeNull();
  });

  it("maybeCurrent() returns the tx inside a transaction", async () => {
    const { db } = setup();

    await db.transaction(async () => {
      const tx = db.maybeCurrent();
      expect(tx).not.toBeNull();
    });
  });
});

describe("nested transactions", () => {
  it("reuses the outer transaction — does NOT open a new connection", async () => {
    const { db, driver } = setup();

    await db.transaction(async () => {
      await db.current().execute("INSERT A");
      await db.transaction(async () => {
        await db.current().execute("INSERT B");
      });
      await db.current().execute("INSERT C");
    });

    const acquires = driver.getLog().filter((e) => e.type === "acquire");
    // Single connection for the whole nested block.
    expect(acquires).toHaveLength(1);
    // One BEGIN, one COMMIT — no savepoint behavior.
    expect(driver.getLog().filter((e) => e.type === "begin")).toHaveLength(1);
    expect(driver.getLog().filter((e) => e.type === "commit")).toHaveLength(1);
  });

  it("an inner throw rolls back the whole transaction", async () => {
    const { db, driver } = setup();

    const result = await db.transaction(async () => {
      await db.current().execute("INSERT outer");
      await db.transaction(async () => {
        await db.current().execute("INSERT inner");
        throw new Error("inner failure");
      });
      // Unreachable.
      await db.current().execute("INSERT after");
    });

    expect(result._tag).toBe("Err");
    const logTypes = driver.getLog().map((e) => e.type);
    expect(logTypes).toContain("rollback");
    expect(logTypes).not.toContain("commit");
  });

  it("emits nested: true on the inner transaction-started event", async () => {
    const { db, events } = setup();

    await db.transaction(async () => {
      await db.transaction(async () => {
        return;
      });
    });

    const starts = events.filter((e) => e.type === "db:transaction-started");
    expect(starts).toHaveLength(2);
    if (starts[0]?.type === "db:transaction-started") expect(starts[0].nested).toBe(false);
    if (starts[1]?.type === "db:transaction-started") expect(starts[1].nested).toBe(true);
  });
});

describe("independent transactions", () => {
  it("each transaction gets its own connection", async () => {
    const { db, driver } = setup();

    await db.transaction(async () => {
      await db.current().execute("A");
    });
    await db.transaction(async () => {
      await db.current().execute("B");
    });

    const acquires = driver.getLog().filter((e) => e.type === "acquire");
    expect(acquires).toHaveLength(2);
    const releases = driver.getLog().filter((e) => e.type === "release");
    expect(releases).toHaveLength(2);
  });
});

describe("db.close", () => {
  it("is idempotent", async () => {
    const { db } = setup();
    await db.close();
    await db.close();
    await db.close();
  });

  it("rejects new transactions after close", async () => {
    const { db } = setup();
    await db.close();

    const result = await db.transaction(async () => 1);
    expect(result._tag).toBe("Err");
    if (result._tag === "Err") expect(result.error.type).toBe("INVALID_TRANSACTION");
  });
});
