import type { Adapter, WorkUnit, WorkResult } from "../types.js";
import type { Effect } from "@phyxiusjs/effect";
import { AdapterError } from "../types.js";
import { generateCorrelationId } from "../utils.js";

/**
 * Convert a Promise to an AdapterError Effect.
 */
function adapterEffectFromPromise<T>(promise: Promise<T>): Effect<AdapterError, T> {
  return {
    unsafeRunPromise: async () => {
      try {
        const value = await promise;
        return { _tag: "Ok", value };
      } catch (error) {
        // If it's already an AdapterError, preserve it
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
    },
    // Minimal implementations to satisfy the interface
    map: () => {
      throw new Error("Map not implemented in adapter utils");
    },
    flatMap: () => {
      throw new Error("FlatMap not implemented in adapter utils");
    },
    catch: () => {
      throw new Error("Catch not implemented in adapter utils");
    },
    timeout: () => {
      throw new Error("Timeout not implemented in adapter utils");
    },
    fork: () => {
      throw new Error("Fork not implemented in adapter utils");
    },
    onInterrupt: () => {
      throw new Error("OnInterrupt not implemented in adapter utils");
    },
    retry: () => {
      throw new Error("Retry not implemented in adapter utils");
    },
  };
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
  timeoutId?: NodeJS.Timeout;
}

/**
 * Simple HTTP adapter that demonstrates the Handler adapter interface.
 * This is a mock implementation that simulates HTTP requests.
 */
export class HttpAdapter implements Adapter<HttpRequest, HttpResponse> {
  public readonly name = "http-adapter";

  private isActive = false;
  private pendingRequests = new Map<string, PendingRequest>();
  private requestQueue: WorkUnit<HttpRequest>[] = [];
  private requestTimeoutMs = 30000;

  constructor(options?: { timeoutMs?: number }) {
    if (options?.timeoutMs) {
      this.requestTimeoutMs = options.timeoutMs;
    }
  }

  /**
   * Simulate receiving HTTP requests.
   * In a real implementation, this would integrate with a web server.
   */
  async *receive(): AsyncIterable<WorkUnit<HttpRequest>> {
    this.isActive = true;

    try {
      while (this.isActive) {
        // Yield any queued requests
        while (this.requestQueue.length > 0) {
          const workUnit = this.requestQueue.shift()!;
          yield workUnit;
        }

        // Wait briefly before checking for more work
        await this.sleep(10);
      }
    } finally {
      this.isActive = false;
    }
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
    const correlationId = generateCorrelationId();

    return new Promise<HttpResponse>((resolve, reject) => {
      // Set up timeout
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(correlationId);
        reject(new Error(`Request timeout after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);

      // Store pending request
      this.pendingRequests.set(correlationId, {
        resolve,
        reject,
        timeoutId,
      });

      // Create work unit
      const workUnit: WorkUnit<HttpRequest> = {
        correlationId,
        input: request,
        receivedAt: { wallMs: Date.now(), monoMs: Date.now() },
        metadata: {
          method: request.method,
          url: request.url,
          userAgent: request.headers["user-agent"] || "unknown",
        },
      };

      // Add to queue for the Handler to process
      this.requestQueue.push(workUnit);
    });
  }

  private async sendResponse(correlationId: string, result: WorkResult<HttpResponse>): Promise<void> {
    const pending = this.pendingRequests.get(correlationId);
    if (!pending) {
      throw new AdapterError(`No pending request found for correlation ID: ${correlationId}`, "SEND_FAILED");
    }

    // Clear timeout
    if (pending.timeoutId) {
      clearTimeout(pending.timeoutId);
    }

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
    this.isActive = false;

    // Reject all pending requests
    for (const [, pending] of this.pendingRequests) {
      if (pending.timeoutId) {
        clearTimeout(pending.timeoutId);
      }
      pending.reject(new Error("Server shutting down"));
    }

    this.pendingRequests.clear();
    this.requestQueue.length = 0;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Create an HTTP adapter.
 */
export function createHttpAdapter(options?: { timeoutMs?: number }): HttpAdapter {
  return new HttpAdapter(options);
}
