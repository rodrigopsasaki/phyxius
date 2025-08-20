import type { Handler, HandlerOptions, HandlerState, HandlerMetrics, Adapter, HandlerEvent } from "./types.js";
import type { ProcessRef } from "@phyxiusjs/process";
import { HandlerError } from "./types.js";
import { EffectUtils, generateHandlerId } from "./utils.js";

/**
 * Simple Handler implementation that demonstrates the interface.
 * This is a minimal but correct implementation that can be extended.
 */
export class HandlerImpl<TInput, TOutput> implements Handler<TInput, TOutput> {
  public readonly id: string;
  public readonly name: string;
  private readonly options: HandlerOptions<TInput, TOutput>;
  private _state: HandlerState = "stopped";
  private adapter?: Adapter<TInput, TOutput>;

  constructor(options: HandlerOptions<TInput, TOutput>) {
    this.id = generateHandlerId();
    this.name = options.name;
    this.options = options;
  }

  get state(): HandlerState {
    return this._state;
  }

  start(adapter: Adapter<TInput, TOutput>): import("@phyxiusjs/effect").Effect<HandlerError, void> {
    return EffectUtils.fromPromise(this.startHandler(adapter));
  }

  stop(): import("@phyxiusjs/effect").Effect<HandlerError, void> {
    return EffectUtils.fromPromise(this.stopHandler());
  }

  getMetrics(): HandlerMetrics {
    return {
      state: this._state,
      activeCount: 0,
      queueSize: 0,
      successCount: 0,
      errorCount: 0,
      errorRate: 0,
      avgProcessingTimeMs: 0,
    };
  }

  getProcessRef(): ProcessRef<unknown> {
    // For now, throw an error - this will be implemented when we add Process supervision
    throw new HandlerError("Process supervision not yet implemented", "HANDLER_NOT_RUNNING");
  }

  private async startHandler(adapter: Adapter<TInput, TOutput>): Promise<void> {
    if (this._state !== "stopped") {
      throw new HandlerError("Handler already running", "HANDLER_ALREADY_RUNNING");
    }

    this._state = "initializing";
    this.adapter = adapter;

    try {
      // Check if adapter is healthy
      if (!adapter.isHealthy()) {
        throw new HandlerError("Adapter is not healthy", "ADAPTER_ERROR");
      }

      this._state = "running";

      this.emit({
        type: "handler:started",
        handlerId: this.id,
        adapterName: adapter.name,
        config: this.options.config,
        at: this.options.clock.now(),
      });

      // Start processing work (simplified for now)
      this.processWork();
    } catch (error) {
      this._state = "failed";
      throw new HandlerError(
        `Failed to start handler: ${error instanceof Error ? error.message : "Unknown error"}`,
        "ADAPTER_ERROR",
        error,
      );
    }
  }

  private async stopHandler(): Promise<void> {
    if (this._state === "stopped") {
      throw new HandlerError("Handler not running", "HANDLER_NOT_RUNNING");
    }

    this._state = "stopping";

    try {
      // Close adapter if it exists
      if (this.adapter) {
        const closeResult = await this.adapter.close().unsafeRunPromise();
        if (closeResult._tag === "Err") {
          console.warn("Error closing adapter:", closeResult.error);
        }
      }

      this._state = "stopped";

      this.emit({
        type: "handler:stopped",
        handlerId: this.id,
        reason: "graceful",
        at: this.options.clock.now(),
      });
    } catch (error) {
      this._state = "failed";
      throw new HandlerError(
        `Failed to stop handler: ${error instanceof Error ? error.message : "Unknown error"}`,
        "ADAPTER_ERROR",
        error,
      );
    }
  }

  private async processWork(): Promise<void> {
    if (!this.adapter) return;

    try {
      // Simple work processing loop
      for await (const workUnit of this.adapter.receive()) {
        if (this._state !== "running") break;

        this.emit({
          type: "work:received",
          handlerId: this.id,
          correlationId: workUnit.correlationId,
          queueSize: 0,
          at: this.options.clock.now(),
        });

        // Process the work unit (simplified)
        try {
          const startTime = this.options.clock.now();

          this.emit({
            type: "work:started",
            handlerId: this.id,
            correlationId: workUnit.correlationId,
            activeCount: 1,
            at: startTime,
          });

          // Use a simple context for now
          const context = this.options.rootContext || { id: "default", data: new Map() };

          // Process the work
          const processingResult = await this.options.processor(workUnit.input, context).unsafeRunPromise();

          const endTime = this.options.clock.now();
          const duration = endTime.wallMs - startTime.wallMs;

          if (processingResult._tag === "Ok") {
            // Send successful response
            await this.adapter.respond(workUnit.correlationId, processingResult).unsafeRunPromise();

            this.emit({
              type: "work:completed",
              handlerId: this.id,
              correlationId: workUnit.correlationId,
              durationMs: duration,
              success: true,
              at: endTime,
            });
          } else {
            // Send error response
            await this.adapter.respond(workUnit.correlationId, processingResult).unsafeRunPromise();

            this.emit({
              type: "work:completed",
              handlerId: this.id,
              correlationId: workUnit.correlationId,
              durationMs: duration,
              success: false,
              at: endTime,
            });
          }
        } catch (error) {
          const errorResult = {
            _tag: "Err" as const,
            error: new HandlerError(
              error instanceof Error ? error.message : "Processing failed",
              "PROCESSOR_ERROR",
              error,
            ),
          };

          await this.adapter.respond(workUnit.correlationId, errorResult).unsafeRunPromise();

          this.emit({
            type: "work:completed",
            handlerId: this.id,
            correlationId: workUnit.correlationId,
            durationMs: 0,
            success: false,
            at: this.options.clock.now(),
          });
        }
      }
    } catch (error) {
      console.error("Error in work processing loop:", error);
      this._state = "failed";
    }
  }

  private emit(event: HandlerEvent): void {
    if (this.options.emit) {
      this.options.emit(event);
    }
  }
}

/**
 * Create a new Handler instance.
 */
export function createHandler<TInput, TOutput>(options: HandlerOptions<TInput, TOutput>): Handler<TInput, TOutput> {
  return new HandlerImpl(options);
}
