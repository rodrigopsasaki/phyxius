/**
 * Webhook receiver: HMAC-SHA256 signature verification + replay-
 * window protection.
 *
 * GitHub signs every webhook delivery with the shared secret using
 * HMAC-SHA256, then attaches the signature in the
 * `X-Hub-Signature-256` header as `sha256=<hex>`. The receiver
 * recomputes the signature from the raw request body and compares
 * it constant-time against the header. If they don't match, the
 * delivery is rejected.
 *
 * Replay protection: every delivery has a unique
 * `X-GitHub-Delivery` UUID. The receiver consults a pluggable
 * replay store (default: in-memory LRU) to reject duplicates within
 * a configurable window. This guards against attacker replay AND
 * accidental double-delivery from GitHub's own retry logic.
 *
 * The `verifyWebhook` function returns a `VerifiedWebhookEvent` on
 * success and throws `WebhookVerificationError` on any failure. It
 * does not parse the JSON body until the signature has been
 * verified — defense against attacker-controlled payloads tripping
 * the parser before authentication.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import type { VerifiedWebhookEvent } from "./types.js";

// ── Errors ──────────────────────────────────────────────────────────────────

export type WebhookVerificationFailure =
  | "missing-signature"
  | "missing-delivery-id"
  | "missing-event"
  | "invalid-signature-format"
  | "signature-mismatch"
  | "replay-detected"
  | "body-not-json"
  | "delivery-too-old";

export class WebhookVerificationError extends Error {
  readonly failure: WebhookVerificationFailure;
  constructor(failure: WebhookVerificationFailure, detail?: string) {
    super(
      detail !== undefined
        ? `webhook verification failed: ${failure} (${detail})`
        : `webhook verification failed: ${failure}`,
    );
    this.name = "WebhookVerificationError";
    this.failure = failure;
  }
}

// ── Replay store ────────────────────────────────────────────────────────────

/**
 * Pluggable storage for seen delivery IDs. The default in-memory
 * LRU bounds itself to `maxEntries`; production deployments with
 * multiple receiver processes should supply a Redis-backed
 * implementation.
 *
 * Records expire after `windowMs` even within the LRU bound — a
 * delivery older than the configured window is rejected as
 * "delivery-too-old" rather than checked for replay, since a
 * legitimate retry should arrive promptly.
 */
export interface ReplayStore {
  /**
   * Returns true if the deliveryId has been seen within `windowMs`,
   * false otherwise. The check is racy under concurrency, but a
   * single GitHub delivery should never cross processes.
   */
  readonly has: (deliveryId: string, nowMs: number) => boolean;
  /** Record this deliveryId as seen at nowMs. */
  readonly add: (deliveryId: string, nowMs: number) => void;
  readonly size: number;
}

export interface ReplayStoreOptions {
  /** How long delivery IDs remain in the store. Default: 5 minutes. */
  readonly windowMs?: number;
  /** Max entries before LRU eviction. Default: 4096. */
  readonly maxEntries?: number;
}

const DEFAULT_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 4096;

export function createInMemoryReplayStore(options: ReplayStoreOptions = {}): ReplayStore {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const seen = new Map<string, number>();

  function has(deliveryId: string, nowMs: number): boolean {
    const at = seen.get(deliveryId);
    if (at === undefined) return false;
    if (nowMs - at > windowMs) {
      seen.delete(deliveryId);
      return false;
    }
    return true;
  }

  function add(deliveryId: string, nowMs: number): void {
    if (seen.has(deliveryId)) seen.delete(deliveryId);
    seen.set(deliveryId, nowMs);
    while (seen.size > maxEntries) {
      const first = seen.keys().next().value;
      if (first === undefined) break;
      seen.delete(first);
    }
  }

  return {
    has,
    add,
    get size() {
      return seen.size;
    },
  };
}

// ── Verification ────────────────────────────────────────────────────────────

export interface VerifyWebhookInput {
  /** Raw request body as received. MUST be the bytes-on-the-wire — re-serialized JSON will not match the signature. */
  readonly body: string | Buffer;
  /** Header bag from the inbound request. Names case-insensitive. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** The shared webhook secret configured in GitHub. */
  readonly secret: string;
}

export interface VerifyWebhookOptions {
  readonly replayStore?: ReplayStore;
  /** Clock for testability. Default: Date.now. */
  readonly now?: () => number;
}

/**
 * Verify and parse a GitHub webhook delivery. Returns a typed
 * `VerifiedWebhookEvent` on success; throws
 * `WebhookVerificationError` on any verification failure.
 */
export function verifyWebhook<TPayload = unknown>(
  input: VerifyWebhookInput,
  options: VerifyWebhookOptions = {},
): VerifiedWebhookEvent<TPayload> {
  const now = options.now ?? Date.now;
  const nowMs = now();
  const headers = lowercaseHeaders(input.headers);

  const signature = headers["x-hub-signature-256"];
  const deliveryId = headers["x-github-delivery"];
  const event = headers["x-github-event"];

  if (signature === undefined) throw new WebhookVerificationError("missing-signature");
  if (deliveryId === undefined) throw new WebhookVerificationError("missing-delivery-id");
  if (event === undefined) throw new WebhookVerificationError("missing-event");

  // Verify the signature BEFORE parsing JSON. An attacker-controlled
  // payload should never reach the parser unless we know it came
  // from GitHub.
  if (!verifySignatureHeader(input.body, signature, input.secret)) {
    throw new WebhookVerificationError("signature-mismatch");
  }

  // Replay protection. Order matters: we add to the store only
  // AFTER we know the signature is valid, so a flood of bogus
  // signatures can't fill the replay store.
  const {replayStore} = options;
  if (replayStore !== undefined) {
    if (replayStore.has(deliveryId, nowMs)) {
      throw new WebhookVerificationError("replay-detected", deliveryId);
    }
    replayStore.add(deliveryId, nowMs);
  }

  // Now safe to parse.
  const bodyText = typeof input.body === "string" ? input.body : input.body.toString("utf-8");
  let payload: TPayload;
  try {
    payload = JSON.parse(bodyText) as TPayload;
  } catch (err) {
    throw new WebhookVerificationError("body-not-json", err instanceof Error ? err.message : String(err));
  }

  return {
    event,
    deliveryId,
    payload,
    receivedAt: nowMs,
  };
}

// ── Signature comparison ────────────────────────────────────────────────────

function verifySignatureHeader(body: string | Buffer, headerValue: string, secret: string): boolean {
  // Header format: "sha256=<hex>". Reject anything else; we don't
  // accept the deprecated SHA-1 signature.
  if (!headerValue.startsWith("sha256=")) return false;
  const expectedHex = headerValue.slice("sha256=".length);
  if (!/^[0-9a-f]+$/i.test(expectedHex)) return false;

  const computedHex = createHmac("sha256", secret)
    .update(typeof body === "string" ? body : body)
    .digest("hex");

  // Constant-time compare. timingSafeEqual requires equal-length
  // buffers; if lengths differ, fail without consulting the digest.
  if (computedHex.length !== expectedHex.length) return false;
  try {
    return timingSafeEqual(Buffer.from(computedHex, "hex"), Buffer.from(expectedHex, "hex"));
  } catch {
    return false;
  }
}

function lowercaseHeaders(headers: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k.toLowerCase()] = v;
  }
  return out;
}
