import { describe, expect, it } from "vitest";

import { err, ok } from "@phyxiusjs/fp";
import type { ValidationError } from "@phyxiusjs/validate";

import { defaultEncode } from "../src/encode.js";

describe("defaultEncode", () => {
  it("encodes Ok as 200 + JSON body", () => {
    const response = defaultEncode(ok({ hello: "world" }));
    expect(response.status).toBe(200);
    expect(response.headers?.["content-type"]).toBe("application/json");
    expect(response.body).toEqual({ hello: "world" });
  });

  it("encodes input VALIDATION_ERROR as 400 with issues", () => {
    const issues = [{ path: ["customerId"], message: "Required" }];
    const error: ValidationError = { issues };
    const response = defaultEncode(err({ type: "VALIDATION_ERROR", target: "input", error } as const));
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "ValidationError", issues });
  });

  it("encodes output VALIDATION_ERROR as 500 (internal bug)", () => {
    const issues = [{ path: ["amount"], message: "Expected number" }];
    const error: ValidationError = { issues };
    const response = defaultEncode(err({ type: "VALIDATION_ERROR", target: "output", error } as const));
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "InternalError" });
  });

  it("encodes TIMEOUT as 504", () => {
    const response = defaultEncode(err({ type: "TIMEOUT", timeoutMs: 5000 } as const));
    expect(response.status).toBe(504);
    expect(response.body).toEqual({ error: "Timeout", timeoutMs: 5000 });
  });

  it("encodes HANDLER_ERROR as 500 without leaking the cause", () => {
    const response = defaultEncode(err({ type: "HANDLER_ERROR", cause: new Error("secret") } as const));
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "InternalError" });
  });

  it("encodes RETRY_EXHAUSTED as 500 with attempts", () => {
    const response = defaultEncode(err({ type: "RETRY_EXHAUSTED", attempts: 3, lastCause: new Error("x") } as const));
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "InternalError", attempts: 3 });
  });

  it("encodes CIRCUIT_OPEN as 503 with Retry-After header", () => {
    const response = defaultEncode(err({ type: "CIRCUIT_OPEN", openedAt: 1000, willRetryAfter: 6000 } as const));
    expect(response.status).toBe(503);
    expect(response.headers?.["retry-after"]).toBe("5");
    expect(response.body).toEqual({ error: "ServiceUnavailable", reason: "circuit_open" });
  });

  it("encodes BACKPRESSURE_REJECT / DROPPED / HANDLER_NOT_RUNNING as 503 with reason", () => {
    expect(defaultEncode(err({ type: "BACKPRESSURE_REJECT" } as const)).body).toEqual({
      error: "ServiceUnavailable",
      reason: "queue_full",
    });
    expect(defaultEncode(err({ type: "DROPPED" } as const)).body).toEqual({
      error: "ServiceUnavailable",
      reason: "dropped",
    });
    expect(defaultEncode(err({ type: "HANDLER_NOT_RUNNING" } as const)).body).toEqual({
      error: "ServiceUnavailable",
      reason: "shutting_down",
    });
  });
});
