import type { Adapter, WorkUnit, WorkResult } from "../types.js";
import type { Effect } from "@phyxiusjs/effect";
import { effect } from "@phyxiusjs/effect";
import type { Clock, Millis } from "@phyxiusjs/clock";
import { AdapterError } from "../types.js";
import { generateCorrelationId } from "../utils.js";

/**
 * Convert a Promise to an Effect using proper Effect system.
 */
function adapterEffectFromPromise<T>(promise: Promise<T>): Effect<AdapterError, T> {
  return effect(async () => {
    try {
      const value = await promise;
      return { _tag: "Ok", value };
    } catch (error) {
      if (error instanceof AdapterError) {
        return { _tag: "Err", error };
      }
      return {
        _tag: "Err",
        error: new AdapterError(
          error instanceof Error ? error.message : "Unknown adapter error",
          "TRANSPORT_ERROR",
          error,
        ),
      };
    }
  });
}

/**
 * HTTP request data that flows through the Handler.
 */
export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * HTTP response data that comes back from the Handler.
 */
export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Internal HTTP request/response tracking.
 */
interface PendingRequest {
  resolve: (response: HttpResponse) => void;
  reject: (error: Error) => void;
}

/**
 * Simple HTTP adapter that demonstrates the Handler adapter interface.
 * This is a mock implementation that simulates HTTP requests.
 */
export class HttpAdapter implements Adapter<HttpRequest, HttpResponse> {
  public readonly name = "http-adapter";

  private pendingRequests = new Map<string, PendingRequest>();
  private requestQueue: WorkUnit<HttpRequest>[] = [];
  private requestTimeoutMs = 30000 as Millis;
  private readonly clock: Clock;

  constructor(clock: Clock, options?: { timeoutMs?: Millis }) {
    this.clock = clock;
    if (options?.timeoutMs) {
      this.requestTimeoutMs = options.timeoutMs;
    }
  }

  /**
   * Simulate receiving HTTP requests.
   * In a real implementation, this would integrate with a web server.
   */
  async *receive(): AsyncIterable<WorkUnit<HttpRequest>> {
    // Process existing queue items immediately
    while (this.requestQueue.length > 0) {
      const workUnit = this.requestQueue.shift()!;
      yield workUnit;
    }

    // For testing purposes, we don't need an infinite loop
    // In a real HTTP server, this would be driven by incoming connections
    // The Handler will call this method and process what's available
  }

  /**
   * Send response back for an HTTP request.
   */
  respond(correlationId: string, result: WorkResult<HttpResponse>): Effect<AdapterError, void> {
    return adapterEffectFromPromise(this.sendResponse(correlationId, result));
  }

  /**
   * Close the adapter and clean up resources.
   */
  close(): Effect<AdapterError, void> {
    return adapterEffectFromPromise(this.cleanup());
  }

  /**
   * Check if the adapter is healthy.
   */
  isHealthy(): boolean {
    return true; // Simple implementation always reports healthy
  }

  /**
   * Simulate an incoming HTTP request.
   * In a real implementation, this would be called by the web server.
   */
  async simulateRequest(request: HttpRequest): Promise<HttpResponse> {
    const correlationId = generateCorrelationId(this.clock);

    // For testing, we'll process the request immediately rather than queueing
    // This ensures the Handler processes it during its initial receive() call
    const responsePromise = new Promise<HttpResponse>((resolve, reject) => {
      // Set up timeout using Clock
      this.clock.timeout(this.requestTimeoutMs).then(() => {
        this.pendingRequests.delete(correlationId);
        reject(new Error(`Request timeout after ${this.requestTimeoutMs}ms`));
      });

      // Store pending request
      this.pendingRequests.set(correlationId, {
        resolve,
        reject,
      });
    });

    // Create work unit and add to queue immediately
    const workUnit: WorkUnit<HttpRequest> = {
      correlationId,
      input: request,
      receivedAt: this.clock.now(),
      metadata: {
        method: request.method,
        url: request.url,
        userAgent: request.headers["user-agent"] || "unknown",
      },
    };

    this.requestQueue.push(workUnit);

    return responsePromise;
  }

  private async sendResponse(correlationId: string, result: WorkResult<HttpResponse>): Promise<void> {
    const pending = this.pendingRequests.get(correlationId);
    if (!pending) {
      throw new AdapterError(`No pending request found for correlation ID: ${correlationId}`, "SEND_FAILED");
    }

    // No timeout cleanup needed since we use Clock promises

    // Remove from pending
    this.pendingRequests.delete(correlationId);

    // Send response
    if (result._tag === "Ok") {
      pending.resolve(result.value);
    } else {
      // Convert handler error to HTTP error response
      const errorResponse: HttpResponse = {
        statusCode: 500,
        headers: { "content-type": "application/json" },
        body: {
          error: "Internal Server Error",
          message: result.error.message,
          correlationId,
        },
      };
      pending.resolve(errorResponse);
    }
  }

  private async cleanup(): Promise<void> {
    // Reject all pending requests
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error("Server shutting down"));
    }

    this.pendingRequests.clear();
    this.requestQueue.length = 0;
  }
}

/**
 * Create an HTTP adapter with Clock dependency.
 */
export function createHttpAdapter(clock: Clock, options?: { timeoutMs?: Millis }): HttpAdapter {
  return new HttpAdapter(clock, options);
}
