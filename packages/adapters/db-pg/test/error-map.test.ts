import { describe, expect, it } from "vitest";

import { mapPgError } from "../src/error-map.js";

// ── Fixture: build a pg-error-shaped object ──────────────────────────────
//
// We don't import `pg.DatabaseError` — the mapper duck-types on `.code` /
// `.constraint` / `.column` and instance-checking across versions is
// fragile. This helper mirrors the shape we actually use.

function pgError(
  code: string,
  extras: { constraint?: string; column?: string; message?: string } = {},
): Error & { code: string; constraint?: string; column?: string } {
  const err = new Error(extras.message ?? `pg error ${code}`) as Error & {
    code: string;
    constraint?: string;
    column?: string;
  };
  err.code = code;
  if (extras.constraint !== undefined) err.constraint = extras.constraint;
  if (extras.column !== undefined) err.column = extras.column;
  return err;
}

// ── Connection errors (class 08 + node errno) ────────────────────────────

describe("mapPgError — connection failures", () => {
  it("maps class 08 SQLSTATE codes to CONNECTION_ERROR", () => {
    for (const code of ["08000", "08003", "08006", "08001", "08004", "08007", "08P01"]) {
      const e = mapPgError(pgError(code));
      expect(e.type).toBe("CONNECTION_ERROR");
    }
  });

  it("maps Node errno codes to CONNECTION_ERROR", () => {
    for (const errno of ["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ECONNRESET"]) {
      const e = mapPgError(pgError(errno));
      expect(e.type).toBe("CONNECTION_ERROR");
    }
  });
});

// ── Integrity violations (class 23) ──────────────────────────────────────

describe("mapPgError — integrity constraints", () => {
  it("23505 → UNIQUE_VIOLATION with constraint", () => {
    const e = mapPgError(pgError("23505", { constraint: "users_email_key" }));
    expect(e.type).toBe("UNIQUE_VIOLATION");
    if (e.type === "UNIQUE_VIOLATION") {
      expect(e.constraint).toBe("users_email_key");
    }
  });

  it("23505 without a constraint name still maps cleanly", () => {
    const e = mapPgError(pgError("23505"));
    expect(e.type).toBe("UNIQUE_VIOLATION");
    if (e.type === "UNIQUE_VIOLATION") {
      expect(e.constraint).toBeUndefined();
    }
  });

  it("23503 → FOREIGN_KEY_VIOLATION", () => {
    const e = mapPgError(pgError("23503", { constraint: "orders_customer_fkey" }));
    expect(e.type).toBe("FOREIGN_KEY_VIOLATION");
    if (e.type === "FOREIGN_KEY_VIOLATION") {
      expect(e.constraint).toBe("orders_customer_fkey");
    }
  });

  it("23502 → NOT_NULL_VIOLATION with column", () => {
    const e = mapPgError(pgError("23502", { column: "email" }));
    expect(e.type).toBe("NOT_NULL_VIOLATION");
    if (e.type === "NOT_NULL_VIOLATION") {
      expect(e.column).toBe("email");
    }
  });

  it("23514 → CHECK_VIOLATION", () => {
    const e = mapPgError(pgError("23514", { constraint: "orders_amount_positive" }));
    expect(e.type).toBe("CHECK_VIOLATION");
    if (e.type === "CHECK_VIOLATION") {
      expect(e.constraint).toBe("orders_amount_positive");
    }
  });
});

// ── Transaction rollbacks (class 40) — retryable ─────────────────────────

describe("mapPgError — retryable failures", () => {
  it("40P01 → DEADLOCK", () => {
    const e = mapPgError(pgError("40P01", { message: "deadlock detected" }));
    expect(e.type).toBe("DEADLOCK");
  });

  it("40001 → SERIALIZATION_FAILURE", () => {
    const e = mapPgError(pgError("40001", { message: "could not serialize access" }));
    expect(e.type).toBe("SERIALIZATION_FAILURE");
  });
});

// ── Query cancellation ────────────────────────────────────────────────────

describe("mapPgError — query cancellation", () => {
  it("57014 (query_canceled) → TIMEOUT with timeoutMs: 0", () => {
    const e = mapPgError(pgError("57014", { message: "canceling statement due to statement timeout" }));
    expect(e.type).toBe("TIMEOUT");
    if (e.type === "TIMEOUT") {
      expect(e.timeoutMs).toBe(0);
    }
  });
});

// ── Fallback — unknown codes go to QUERY_ERROR ───────────────────────────

describe("mapPgError — fallback", () => {
  it("unknown SQLSTATE codes fall through to QUERY_ERROR", () => {
    const e = mapPgError(pgError("XX000"), { sql: "SELECT 1" });
    expect(e.type).toBe("QUERY_ERROR");
    if (e.type === "QUERY_ERROR") {
      expect(e.sql).toBe("SELECT 1");
    }
  });

  it("errors without any code still map to QUERY_ERROR", () => {
    const e = mapPgError(new Error("generic failure"), { sql: "BAD SQL" });
    expect(e.type).toBe("QUERY_ERROR");
    if (e.type === "QUERY_ERROR") {
      expect(e.sql).toBe("BAD SQL");
    }
  });

  it("non-error throws are safely wrapped as QUERY_ERROR", () => {
    const e = mapPgError("a string cause", { sql: "SELECT 1" });
    expect(e.type).toBe("QUERY_ERROR");
  });

  it("null/undefined causes map to QUERY_ERROR", () => {
    expect(mapPgError(null).type).toBe("QUERY_ERROR");
    expect(mapPgError(undefined).type).toBe("QUERY_ERROR");
  });
});

// ── Cause preservation ───────────────────────────────────────────────────

describe("mapPgError — cause preservation", () => {
  it("preserves the original cause for diagnostics", () => {
    const original = pgError("23505", { constraint: "users_email_key" });
    const mapped = mapPgError(original);
    expect(mapped.type).toBe("UNIQUE_VIOLATION");
    if (mapped.type === "UNIQUE_VIOLATION") {
      expect(mapped.cause).toBe(original);
    }
  });

  it("unknown codes preserve the cause on QUERY_ERROR", () => {
    const original = pgError("XX000");
    const mapped = mapPgError(original);
    expect(mapped.type).toBe("QUERY_ERROR");
    if (mapped.type === "QUERY_ERROR") {
      expect(mapped.cause).toBe(original);
    }
  });
});
