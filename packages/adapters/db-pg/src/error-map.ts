import type { DbError } from "@phyxiusjs/db";

// ── Postgres SQLSTATE deepdive ────────────────────────────────────────────
//
// The curated artifact. Every variant in the Phyxius `DbError` union maps to
// one or more Postgres SQLSTATE codes. We intentionally map only the codes
// that have a clear handler-policy implication — retry vs surface vs
// dead-letter — and fall through everything else to `QUERY_ERROR`. Adding
// a new specific code later is a one-line change in this table.
//
// Reference: https://www.postgresql.org/docs/current/errcodes-appendix.html

// ── Class 08 — Connection Exception ──────────────────────────────────────
// These are infrastructure-level failures, almost always retryable.
const CONNECTION_CODES = new Set([
  "08000", // connection_exception
  "08003", // connection_does_not_exist
  "08006", // connection_failure
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08004", // sqlserver_rejected_establishment_of_sqlconnection
  "08007", // transaction_resolution_unknown
  "08P01", // protocol_violation
]);

// ── Class 23 — Integrity Constraint Violation ────────────────────────────
// These surface to the caller — they're not retryable, they indicate a
// real condition the application must handle (duplicate entry, missing
// parent, etc.).
const INTEGRITY_CODES: Record<
  string,
  "UNIQUE_VIOLATION" | "FOREIGN_KEY_VIOLATION" | "NOT_NULL_VIOLATION" | "CHECK_VIOLATION"
> = {
  "23505": "UNIQUE_VIOLATION",
  "23503": "FOREIGN_KEY_VIOLATION",
  "23502": "NOT_NULL_VIOLATION",
  "23514": "CHECK_VIOLATION",
  // Note: 23001 (restrict_violation), 23P01 (exclusion_violation) fall
  // through to QUERY_ERROR — they're rare enough that adding variants
  // would over-model. Revisit if a real system hits one regularly.
};

// ── Class 40 — Transaction Rollback ──────────────────────────────────────
// These are retryable. The handler's `retry.exponential` with a
// `shouldRetry` predicate on DEADLOCK / SERIALIZATION_FAILURE is the
// standard pattern.
const DEADLOCK_CODE = "40P01";
const SERIALIZATION_FAILURE_CODE = "40001";

// ── Class 57 — Operator Intervention / Query Cancel ──────────────────────
// 57014 (query_canceled) is what fires when statement_timeout hits. We
// surface it as TIMEOUT with the configured timeout (or 0 if we don't
// know it — the caller's wrap, not ours). Callers using db.queryTimeoutMs
// already get their own TIMEOUT from the racing mechanism in @phyxiusjs/db;
// this covers the server-side timeout case.
const QUERY_CANCELED_CODE = "57014";

// ── Shape helpers ────────────────────────────────────────────────────────

/**
 * Extract the SQLSTATE code from a thrown value. pg's errors carry `.code`
 * as a 5-char string. We duck-type against that shape instead of importing
 * `pg.DatabaseError` — the driver's error class isn't guaranteed to be
 * instance-checkable across versions / proxies, and duck-typing is more
 * robust for a mapping layer.
 */
function codeOf(cause: unknown): string | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  const c = (cause as { code?: unknown }).code;
  return typeof c === "string" ? c : undefined;
}

function constraintOf(cause: unknown): string | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  const c = (cause as { constraint?: unknown }).constraint;
  return typeof c === "string" ? c : undefined;
}

function columnOf(cause: unknown): string | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  const c = (cause as { column?: unknown }).column;
  return typeof c === "string" ? c : undefined;
}

// ── Public mapper ────────────────────────────────────────────────────────

/**
 * Translate a pg-thrown error into a typed `DbError`. Used by the driver's
 * `mapError` method and the connection's own catch paths.
 *
 * Not exported as an instance method because it's pure — same input always
 * produces same output — so tests and custom drivers can import it
 * directly to reuse the mapping.
 */
export function mapPgError(cause: unknown, context?: { readonly sql?: string }): DbError {
  // Non-error throws (shouldn't normally happen but defensively):
  if (cause instanceof Error === false && (typeof cause !== "object" || cause === null)) {
    return { type: "QUERY_ERROR", sql: context?.sql ?? "", cause };
  }

  const code = codeOf(cause);

  // Network / ENOTFOUND / ECONNREFUSED — these don't have SQLSTATE codes;
  // they're node-style errno-coded errors from the socket layer.
  const errno = (cause as { code?: string })?.code;
  if (errno === "ECONNREFUSED" || errno === "ENOTFOUND" || errno === "EHOSTUNREACH" || errno === "ECONNRESET") {
    return { type: "CONNECTION_ERROR", cause };
  }

  if (code === undefined) {
    // No SQLSTATE — unclassifiable. Default to QUERY_ERROR.
    return { type: "QUERY_ERROR", sql: context?.sql ?? "", cause };
  }

  if (CONNECTION_CODES.has(code)) {
    return { type: "CONNECTION_ERROR", cause };
  }

  if (code === DEADLOCK_CODE) {
    return { type: "DEADLOCK", cause };
  }

  if (code === SERIALIZATION_FAILURE_CODE) {
    return { type: "SERIALIZATION_FAILURE", cause };
  }

  if (code === QUERY_CANCELED_CODE) {
    // Server-side cancel — usually statement_timeout. The caller doesn't
    // know our timeout budget, so we report 0 and let the caller's own
    // QueryTimeout settings (if any) be authoritative.
    return { type: "TIMEOUT", timeoutMs: 0 };
  }

  const integrity = INTEGRITY_CODES[code];
  if (integrity) {
    const constraint = constraintOf(cause);
    const column = columnOf(cause);
    switch (integrity) {
      case "UNIQUE_VIOLATION":
        return constraint !== undefined
          ? { type: "UNIQUE_VIOLATION", constraint, cause }
          : { type: "UNIQUE_VIOLATION", cause };
      case "FOREIGN_KEY_VIOLATION":
        return constraint !== undefined
          ? { type: "FOREIGN_KEY_VIOLATION", constraint, cause }
          : { type: "FOREIGN_KEY_VIOLATION", cause };
      case "NOT_NULL_VIOLATION":
        return column !== undefined
          ? { type: "NOT_NULL_VIOLATION", column, cause }
          : { type: "NOT_NULL_VIOLATION", cause };
      case "CHECK_VIOLATION":
        return constraint !== undefined
          ? { type: "CHECK_VIOLATION", constraint, cause }
          : { type: "CHECK_VIOLATION", cause };
    }
  }

  return { type: "QUERY_ERROR", sql: context?.sql ?? "", cause };
}
