import { describe, expect, it } from "vitest";

import { err, ok } from "@phyxiusjs/fp";
import type { Instant } from "@phyxiusjs/clock";
import type { ValidationError } from "@phyxiusjs/validate";

import { defaultOnResult } from "../src/encode.js";
import type { QueueMessage } from "../src/types.js";

const dummyMessage: QueueMessage = {
  id: "msg-1",
  body: {},
  receivedAt: { wallMs: 0, monoMs: 0 } as Instant,
  deliveryCount: 1,
};

describe("defaultOnResult", () => {
  it("Ok → ack", () => {
    expect(defaultOnResult(ok({ v: 1 }), dummyMessage)).toEqual({ action: "ack" });
  });

  it("VALIDATION_ERROR(input) → dead-letter with target in cause", () => {
    const error: ValidationError = { issues: [{ path: ["x"], message: "bad" }] };
    const outcome = defaultOnResult(err({ type: "VALIDATION_ERROR", target: "input", error } as const), dummyMessage);
    expect(outcome).toEqual({
      action: "nack",
      reason: { type: "dead-letter", cause: "validation:input" },
    });
  });

  it("VALIDATION_ERROR(output) → dead-letter (server bug, but message is toxic)", () => {
    const error: ValidationError = { issues: [] };
    const outcome = defaultOnResult(err({ type: "VALIDATION_ERROR", target: "output", error } as const), dummyMessage);
    expect(outcome.action).toBe("nack");
    if (outcome.action === "nack") {
      expect(outcome.reason.type).toBe("dead-letter");
    }
  });

  it("TIMEOUT → retry with timeout in cause", () => {
    const outcome = defaultOnResult(err({ type: "TIMEOUT", timeoutMs: 5000 } as const), dummyMessage);
    expect(outcome).toEqual({
      action: "nack",
      reason: { type: "retry", cause: "timeout:5000ms" },
    });
  });

  it("HANDLER_ERROR → retry (transient by default)", () => {
    const outcome = defaultOnResult(err({ type: "HANDLER_ERROR", cause: new Error("boom") } as const), dummyMessage);
    expect(outcome).toEqual({
      action: "nack",
      reason: { type: "retry", cause: "handler_error" },
    });
  });

  it("RETRY_EXHAUSTED → dead-letter (handler already retried)", () => {
    const outcome = defaultOnResult(
      err({ type: "RETRY_EXHAUSTED", attempts: 3, lastCause: new Error("x") } as const),
      dummyMessage,
    );
    expect(outcome).toEqual({
      action: "nack",
      reason: { type: "dead-letter", cause: "retry_exhausted:3" },
    });
  });

  it("CIRCUIT_OPEN → retry with computed delay", () => {
    const outcome = defaultOnResult(
      err({ type: "CIRCUIT_OPEN", openedAt: 1000, willRetryAfter: 6000 } as const),
      dummyMessage,
    );
    expect(outcome.action).toBe("nack");
    if (outcome.action === "nack" && outcome.reason.type === "retry") {
      expect(outcome.reason.delayMs).toBe(5000);
      expect(outcome.reason.cause).toBe("circuit_open");
    }
  });

  it("BACKPRESSURE_REJECT → requeue-now", () => {
    const outcome = defaultOnResult(err({ type: "BACKPRESSURE_REJECT" } as const), dummyMessage);
    expect(outcome).toEqual({
      action: "nack",
      reason: { type: "requeue-now", cause: "queue_full" },
    });
  });

  it("DROPPED → requeue-now", () => {
    const outcome = defaultOnResult(err({ type: "DROPPED" } as const), dummyMessage);
    expect(outcome).toEqual({
      action: "nack",
      reason: { type: "requeue-now", cause: "dropped" },
    });
  });

  it("HANDLER_NOT_RUNNING → requeue-now", () => {
    const outcome = defaultOnResult(err({ type: "HANDLER_NOT_RUNNING" } as const), dummyMessage);
    expect(outcome).toEqual({
      action: "nack",
      reason: { type: "requeue-now", cause: "shutting_down" },
    });
  });
});
