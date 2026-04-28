import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { WebhookVerificationError, createInMemoryReplayStore, verifyWebhook } from "../src/webhooks.js";

function sign(body: string, secret: string): string {
  const hex = createHmac("sha256", secret).update(body).digest("hex");
  return `sha256=${hex}`;
}

const SECRET = "shh";

describe("verifyWebhook — happy path", () => {
  it("returns the parsed event when signature is valid", () => {
    const body = JSON.stringify({ action: "opened", number: 42 });
    const result = verifyWebhook<{ action: string; number: number }>({
      body,
      headers: {
        "x-hub-signature-256": sign(body, SECRET),
        "x-github-delivery": "abc-123",
        "x-github-event": "pull_request",
      },
      secret: SECRET,
    });
    expect(result.event).toBe("pull_request");
    expect(result.deliveryId).toBe("abc-123");
    expect(result.payload).toEqual({ action: "opened", number: 42 });
    expect(result.receivedAt).toBeGreaterThan(0);
  });

  it("accepts Buffer body", () => {
    const body = Buffer.from(JSON.stringify({ ok: true }), "utf-8");
    const result = verifyWebhook({
      body,
      headers: {
        "x-hub-signature-256": sign(body.toString("utf-8"), SECRET),
        "x-github-delivery": "buf-1",
        "x-github-event": "push",
      },
      secret: SECRET,
    });
    expect(result.event).toBe("push");
  });

  it("is case-insensitive about header names", () => {
    const body = "{}";
    const result = verifyWebhook({
      body,
      headers: {
        "X-Hub-Signature-256": sign(body, SECRET),
        "X-GitHub-Delivery": "case-1",
        "X-GitHub-Event": "ping",
      },
      secret: SECRET,
    });
    expect(result.event).toBe("ping");
  });
});

describe("verifyWebhook — rejection paths", () => {
  it("rejects when signature is missing", () => {
    expect(() =>
      verifyWebhook({
        body: "{}",
        headers: { "x-github-delivery": "d", "x-github-event": "ping" },
        secret: SECRET,
      }),
    ).toThrow(WebhookVerificationError);
  });

  it("rejects when delivery id is missing", () => {
    const body = "{}";
    expect(() =>
      verifyWebhook({
        body,
        headers: {
          "x-hub-signature-256": sign(body, SECRET),
          "x-github-event": "ping",
        },
        secret: SECRET,
      }),
    ).toThrow(WebhookVerificationError);
  });

  it("rejects when event is missing", () => {
    const body = "{}";
    expect(() =>
      verifyWebhook({
        body,
        headers: {
          "x-hub-signature-256": sign(body, SECRET),
          "x-github-delivery": "d",
        },
        secret: SECRET,
      }),
    ).toThrow(WebhookVerificationError);
  });

  it("rejects mismatched signature", () => {
    expect(() =>
      verifyWebhook({
        body: "{}",
        headers: {
          "x-hub-signature-256": `sha256=${  "0".repeat(64)}`,
          "x-github-delivery": "d",
          "x-github-event": "ping",
        },
        secret: SECRET,
      }),
    ).toThrow(WebhookVerificationError);
  });

  it("rejects sha1-only signature header (we don't accept the deprecated form)", () => {
    expect(() =>
      verifyWebhook({
        body: "{}",
        headers: {
          "x-hub-signature-256": "sha1=abc123",
          "x-github-delivery": "d",
          "x-github-event": "ping",
        },
        secret: SECRET,
      }),
    ).toThrow(WebhookVerificationError);
  });

  it("rejects malformed signature hex", () => {
    expect(() =>
      verifyWebhook({
        body: "{}",
        headers: {
          "x-hub-signature-256": "sha256=not-hex",
          "x-github-delivery": "d",
          "x-github-event": "ping",
        },
        secret: SECRET,
      }),
    ).toThrow(WebhookVerificationError);
  });

  it("rejects body that fails to parse as JSON (after signature verifies)", () => {
    const body = "not json";
    expect(() =>
      verifyWebhook({
        body,
        headers: {
          "x-hub-signature-256": sign(body, SECRET),
          "x-github-delivery": "d",
          "x-github-event": "ping",
        },
        secret: SECRET,
      }),
    ).toThrow(WebhookVerificationError);
  });
});

describe("verifyWebhook — replay protection", () => {
  it("accepts a delivery the first time", () => {
    const store = createInMemoryReplayStore();
    const body = "{}";
    const headers = {
      "x-hub-signature-256": sign(body, SECRET),
      "x-github-delivery": "first-time",
      "x-github-event": "ping",
    };
    expect(() => verifyWebhook({ body, headers, secret: SECRET }, { replayStore: store })).not.toThrow();
  });

  it("rejects a duplicate delivery within the window", () => {
    const store = createInMemoryReplayStore({ windowMs: 1_000_000 });
    const body = "{}";
    const headers = {
      "x-hub-signature-256": sign(body, SECRET),
      "x-github-delivery": "duplicate",
      "x-github-event": "ping",
    };
    verifyWebhook({ body, headers, secret: SECRET }, { replayStore: store });
    expect(() => verifyWebhook({ body, headers, secret: SECRET }, { replayStore: store })).toThrow(
      WebhookVerificationError,
    );
  });

  it("does not fill the replay store with bogus signatures", () => {
    const store = createInMemoryReplayStore();
    const body = "{}";
    expect(() =>
      verifyWebhook(
        {
          body,
          headers: {
            "x-hub-signature-256": `sha256=${  "0".repeat(64)}`,
            "x-github-delivery": "bogus",
            "x-github-event": "ping",
          },
          secret: SECRET,
        },
        { replayStore: store },
      ),
    ).toThrow(WebhookVerificationError);
    expect(store.size).toBe(0);
  });

  it("expires entries after the window", () => {
    let now = 1_000_000;
    const store = createInMemoryReplayStore({ windowMs: 1000 });
    const body = "{}";
    const headers = {
      "x-hub-signature-256": sign(body, SECRET),
      "x-github-delivery": "expiring",
      "x-github-event": "ping",
    };
    verifyWebhook({ body, headers, secret: SECRET }, { replayStore: store, now: () => now });
    now += 5000; // far past windowMs
    expect(() =>
      verifyWebhook({ body, headers, secret: SECRET }, { replayStore: store, now: () => now }),
    ).not.toThrow();
  });
});
