import { describe, expect, it } from "vitest";

import { ConnectorFailure, isConnectorFailure, type ConnectorError } from "../src/index.js";

describe("ConnectorFailure", () => {
  it("carries the provider and typed error", () => {
    const err: ConnectorError = { type: "RATE_LIMITED", retryAfterMs: 1000, cause: "throttled" };
    const failure = new ConnectorFailure("stripe", err);

    expect(failure.provider).toBe("stripe");
    expect(failure.error).toBe(err);
    expect(failure.error.type).toBe("RATE_LIMITED");
  });

  it("is an Error subclass with a meaningful message", () => {
    const failure = new ConnectorFailure("slack", { type: "UNAUTHORIZED", cause: {} });

    expect(failure).toBeInstanceOf(Error);
    expect(failure.name).toBe("ConnectorFailure");
    expect(failure.message).toBe("[slack] UNAUTHORIZED");
  });

  it("preserves stack traces for incident investigation", () => {
    const failure = new ConnectorFailure("openai", { type: "PROVIDER_ERROR", cause: new Error("upstream") });
    expect(typeof failure.stack).toBe("string");
    expect(failure.stack).toContain("ConnectorFailure");
  });
});

describe("isConnectorFailure", () => {
  it("narrows a ConnectorFailure", () => {
    const failure = new ConnectorFailure("twilio", { type: "NOT_FOUND", cause: {} });
    expect(isConnectorFailure(failure)).toBe(true);
  });

  it("returns false for plain Errors", () => {
    expect(isConnectorFailure(new Error("generic"))).toBe(false);
  });

  it("returns false for typed-but-not-thrown ConnectorError objects", () => {
    // A raw ConnectorError isn't a failure envelope — `isConnectorFailure`
    // is specifically the runtime check for "did this throw come from a
    // defineConnector-wrapped run?"
    const raw: ConnectorError = { type: "TIMEOUT", timeoutMs: 30_000 };
    expect(isConnectorFailure(raw)).toBe(false);
  });

  it("returns false for undefined / null / primitives", () => {
    expect(isConnectorFailure(undefined)).toBe(false);
    expect(isConnectorFailure(null)).toBe(false);
    expect(isConnectorFailure("string")).toBe(false);
    expect(isConnectorFailure(42)).toBe(false);
  });
});
