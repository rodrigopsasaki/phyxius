import type { Atom } from "@phyxiusjs/atom";
import { createAtom } from "@phyxiusjs/atom";
import type { Effect } from "@phyxiusjs/effect";
import { effect } from "@phyxiusjs/effect";
import type { Clock } from "@phyxiusjs/clock";
import type { ProcessRef } from "@phyxiusjs/process";
import { createProcess } from "@phyxiusjs/process";
import type { PhyxiusContext } from "@phyxiusjs/context";
import { ok, err, isOk, isErr, some, none, isSome, isNone, unwrapOption, type Option } from "@phyxiusjs/fp";

import type {
  Handler,
  HandlerOptions,
  HandlerState,
  HandlerMetrics,
  Adapter,
  HandlerEvent,
  HandlerMessage,
  HandlerInternalState,
  WorkUnit,
} from "./types.js";
import { HandlerError } from "./types.js";
import { generateHandlerId } from "./utils.js";
import { createMetricsCollector, type MetricsCollector } from "./metrics.js";
import { createCircuitBreaker, type CircuitBreaker } from "./circuit-breaker.js";
import { createBackpressureQueue, type BackpressureQueue } from "./backpressure.js";

/**
 * Production-ready Handler implementation using proper Phyxius constructs.
 * Demonstrates composition of Atom, Effect, Process, and functional primitives.
 */
export class HandlerImpl<TInput, TOutput> implements Handler<TInput, TOutput> {
  public readonly id: string;
  public readonly name: string;

  private readonly options: HandlerOptions<TInput, TOutput>;
  private readonly clock: Clock;

  // Core Phyxius primitives
  private readonly internalState: Atom<HandlerInternalState>;
  private readonly metricsCollector: MetricsCollector;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly backpressureQueue: BackpressureQueue<WorkUnit<TInput>>;
  private readonly processRef: ProcessRef<HandlerMessage>;

  // Adapter state
  private adapter: Option<Adapter<TInput, TOutput>> = none();

  constructor(options: HandlerOptions<TInput, TOutput>) {
    this.name = options.name;
    this.options = options;
    this.clock = options.clock;
    this.id = generateHandlerId(this.clock);

    const now = this.clock.now();

    // Initialize state atom
    const initialState: HandlerInternalState = {
      status: "initializing",
      activeWorkCount: 0,
      queuedWorkCount: 0,
      totalProcessed: 0,
      totalSucceeded: 0,
      totalFailed: 0,
      lastActivityTime: now,
      startTime: none(),
    };

    this.internalState = createAtom(initialState, this.clock);

    // Initialize components
    this.metricsCollector = createMetricsCollector(this.clock, this.internalState, options.journal);

    this.circuitBreaker = createCircuitBreaker(options.config.circuitBreaker, this.clock);

    this.backpressureQueue = createBackpressureQueue<WorkUnit<TInput>>(
      options.config.backpressure,
      this.clock,
      options.journal,
    );

    // Create supervised process
    this.processRef = this.createSupervisedProcess();
  }

  get state(): HandlerState {
    return this.internalState.deref().status;
  }

  start(adapter: Adapter<TInput, TOutput>): Effect<HandlerError, void> {
    return effect(async () => {
      const currentState = this.internalState.deref().status;

      if (currentState !== "initializing" && currentState !== "stopped") {
        return { _tag: "Err", error: new HandlerError("Handler already running", "HANDLER_ALREADY_RUNNING") };
      }

      // Check adapter health
      if (!adapter.isHealthy()) {
        return { _tag: "Err", error: new HandlerError("Adapter is not healthy", "ADAPTER_ERROR") };
      }

      this.adapter = some(adapter);

      // Update state
      const now = this.clock.now();
      this.internalState.swap((state) => ({
        ...state,
        status: "running",
        startTime: some(now),
        lastActivityTime: now,
      }));

      // Emit start event
      this.emit({
        type: "handler:started",
        handlerId: this.id,
        adapterName: adapter.name,
        config: this.options.config,
        at: now,
      });

      // Start processing loop
      this.startProcessingLoop();

      return { _tag: "Ok", value: undefined };
    });
  }

  stop(): Effect<HandlerError, void> {
    return effect(async () => {
      const currentState = this.internalState.deref().status;

      if (currentState === "stopped" || currentState === "initializing") {
        return { _tag: "Err", error: new HandlerError("Handler not running", "HANDLER_NOT_RUNNING") };
      }

      // Update state to stopping
      this.internalState.swap((state) => ({
        ...state,
        status: "stopping",
        lastActivityTime: this.clock.now(),
      }));

      // Wait for active work to complete with timeout
      const shutdownEffect = this.waitForShutdown();
      const timeoutEffect = this.createTimeoutEffect();

      // Race between graceful shutdown and timeout
      const shutdownPromise = shutdownEffect.unsafeRunPromise();
      const timeoutPromise = timeoutEffect.unsafeRunPromise();
      const shutdownResult = await Promise.race([shutdownPromise, timeoutPromise]);

      if (isErr(shutdownResult)) {
        return { _tag: "Err", error: shutdownResult.error };
      }

      // Close adapter
      if (isSome(this.adapter)) {
        const adapter = unwrapOption(this.adapter);
        const closeResult = await adapter.close().unsafeRunPromise();
        if (isErr(closeResult)) {
          console.warn("Error closing adapter:", closeResult.error);
        }
      }

      // Clear remaining queue
      const clearedCount = this.backpressureQueue.clear();
      if (clearedCount > 0) {
        console.warn(`Dropped ${clearedCount} pending work units during shutdown`);
      }

      // Update final state
      const shutdownEnd = this.clock.now();
      this.internalState.swap((state) => ({
        ...state,
        status: "stopped",
        lastActivityTime: shutdownEnd,
      }));

      this.emit({
        type: "handler:stopped",
        handlerId: this.id,
        reason: "graceful",
        at: shutdownEnd,
      });

      return { _tag: "Ok", value: undefined };
    });
  }

  getMetrics(): HandlerMetrics {
    return this.metricsCollector.generateMetrics(this.circuitBreaker.getState(), this.backpressureQueue.size());
  }

  getProcessRef(): ProcessRef<HandlerMessage> {
    return this.processRef;
  }

  /**
   * Main processing loop using proper Effect and functional composition.
   */
  private startProcessingLoop(): void {
    if (isNone(this.adapter)) return;

    const adapter = unwrapOption(this.adapter);

    // Process work in a supervised loop
    this.createProcessingEffect(adapter)
      .unsafeRunPromise()
      .then((result) => {
        if (isErr(result)) {
          console.error("Processing loop error:", result.error);
          this.internalState.swap((state) => ({
            ...state,
            status: "failed",
            lastActivityTime: this.clock.now(),
          }));
        }
      })
      .catch((error) => {
        console.error("Unhandled processing loop error:", error);
        this.internalState.swap((state) => ({
          ...state,
          status: "failed",
          lastActivityTime: this.clock.now(),
        }));
      });
  }

  /**
   * Create the main processing effect using proper Effect composition.
   */
  private createProcessingEffect(adapter: Adapter<TInput, TOutput>): Effect<HandlerError, void> {
    return effect(async () => {
      try {
        const workStream = adapter.receive();

        for await (const workUnit of workStream) {
          // Check if we should stop
          if (this.internalState.deref().status !== "running") {
            break;
          }

          // Process the work unit through our pipeline
          const processResult = await this.processWorkUnit(workUnit).unsafeRunPromise();

          if (isErr(processResult)) {
            console.error("Work processing error:", processResult.error);
          }
        }

        return { _tag: "Ok", value: undefined };
      } catch (error) {
        return {
          _tag: "Err",
          error: new HandlerError(
            error instanceof Error ? error.message : "Processing loop failed",
            "PROCESSOR_ERROR",
            error,
          ),
        };
      }
    });
  }

  /**
   * Process a single work unit using functional composition.
   */
  private processWorkUnit(workUnit: WorkUnit<TInput>): Effect<HandlerError, void> {
    return effect(async () => {
      const startTime = this.clock.now();

      // Update metrics
      this.metricsCollector.recordWorkStarted();

      this.emit({
        type: "work:received",
        handlerId: this.id,
        correlationId: workUnit.correlationId,
        queueSize: 0, // Direct processing, no queue
        at: startTime,
      });

      // Check capacity
      if (!this.hasProcessingCapacity()) {
        this.metricsCollector.recordWorkEnded(); // Decrement active count
        const backpressureError = new HandlerError("No processing capacity available", "BACKPRESSURE");
        await this.sendErrorResponse(workUnit.correlationId, backpressureError);
        return { _tag: "Err", error: backpressureError };
      }

      // Process work unit directly
      const processResult = await this.executeWork(workUnit).unsafeRunPromise();

      const endTime = this.clock.now();
      const duration = endTime.monoMs - startTime.monoMs;

      if (isOk(processResult)) {
        this.metricsCollector.recordRequest(duration, true);
        this.metricsCollector.recordWorkEnded(); // Decrement active count

        // Send success response
        if (isSome(this.adapter)) {
          const adapter = unwrapOption(this.adapter);
          const responseResult = await adapter
            .respond(workUnit.correlationId, ok(processResult.value))
            .unsafeRunPromise();

          if (isErr(responseResult)) {
            console.warn("Failed to send success response:", responseResult.error);
          }
        }

        this.emit({
          type: "work:completed",
          handlerId: this.id,
          correlationId: workUnit.correlationId,
          durationMs: duration,
          success: true,
          at: endTime,
        });
      } else {
        this.metricsCollector.recordRequest(duration, false);
        this.metricsCollector.recordWorkEnded(); // Decrement active count
        await this.sendErrorResponse(workUnit.correlationId, processResult.error);

        this.emit({
          type: "work:completed",
          handlerId: this.id,
          correlationId: workUnit.correlationId,
          durationMs: duration,
          success: false,
          at: endTime,
        });
      }

      return { _tag: "Ok", value: undefined };
    });
  }

  /**
   * Execute work through circuit breaker with proper Effect composition.
   */
  private executeWork(workUnit: WorkUnit<TInput>): Effect<HandlerError, TOutput> {
    return this.circuitBreaker.execute(() => this.runProcessorPipeline(workUnit));
  }

  /**
   * Run the processor pipeline with validation and retry.
   */
  private runProcessorPipeline(workUnit: WorkUnit<TInput>): Effect<HandlerError, TOutput> {
    const pipeline = this.options.processor;
    const context = this.createWorkContext(workUnit);

    // Input validation (if available)
    // TODO: Implement proper validation once Validator interface is clarified

    // Apply timeout to processing
    const processingEffect = pipeline.process(workUnit.input, context);
    const timeoutEffect = this.createWorkTimeoutEffect(workUnit.correlationId);

    // Race between processing and timeout using Promise.race for better typing
    const timedEffect = effect(async (env) => {
      const processingPromise = processingEffect.unsafeRunPromise(env);
      const timeoutPromise = timeoutEffect.unsafeRunPromise(env);

      const result = await Promise.race([processingPromise, timeoutPromise]);
      return result;
    });

    // Apply retry policy if configured
    if (pipeline.retry) {
      // Note: retry may introduce Interrupted type, which we handle as a processing error
      return timedEffect.retry(pipeline.retry).catch((error) => {
        return effect(async () => {
          if (typeof error === "object" && error !== null && "_tag" in error && error._tag === "Interrupted") {
            return { _tag: "Err", error: new HandlerError("Processing interrupted", "PROCESSOR_ERROR") };
          }
          return { _tag: "Err", error: error as HandlerError };
        });
      });
    }

    return timedEffect;
  }

  /**
   * Check if we have capacity to process more work.
   */
  private hasProcessingCapacity(): boolean {
    const activeCount = this.internalState.deref().activeWorkCount;
    return activeCount < this.options.config.maxConcurrency;
  }

  /**
   * Create timeout effect for work processing.
   */
  private createWorkTimeoutEffect(correlationId: string): Effect<HandlerError, never> {
    return effect(async () => {
      await this.clock.sleep(this.options.config.timeoutMs);

      this.emit({
        type: "work:timeout",
        handlerId: this.id,
        correlationId,
        timeoutMs: this.options.config.timeoutMs,
        at: this.clock.now(),
      });

      return { _tag: "Err", error: new HandlerError("Processing timeout", "TIMEOUT") };
    });
  }

  /**
   * Create timeout effect for shutdown.
   */
  private createTimeoutEffect(): Effect<HandlerError, never> {
    return effect(async () => {
      await this.clock.sleep(this.options.config.shutdownTimeoutMs);
      return { _tag: "Err", error: new HandlerError("Shutdown timeout exceeded", "SHUTDOWN_TIMEOUT") };
    });
  }

  /**
   * Wait for graceful shutdown.
   */
  private waitForShutdown(): Effect<HandlerError, void> {
    return effect(async () => {
      // Poll until no active work
      while (this.internalState.deref().activeWorkCount > 0) {
        await this.clock.sleep(100 as import("@phyxiusjs/clock").Millis);
      }
      return { _tag: "Ok", value: undefined };
    });
  }

  /**
   * Send error response through adapter.
   */
  private async sendErrorResponse(correlationId: string, error: HandlerError): Promise<void> {
    if (isSome(this.adapter)) {
      const adapter = unwrapOption(this.adapter);
      const responseResult = await adapter.respond(correlationId, err(error)).unsafeRunPromise();

      if (isErr(responseResult)) {
        console.warn("Failed to send error response:", responseResult.error);
      }
    }
  }

  /**
   * Create work context with proper scoping.
   */
  private createWorkContext(workUnit: WorkUnit<TInput>): PhyxiusContext {
    const rootContext = this.options.rootContext || {
      data: { handlerId: this.id, handlerName: this.name },
    };

    return {
      data: {
        ...rootContext.data,
        correlationId: workUnit.correlationId,
        workUnitId: workUnit.correlationId,
        receivedAt: workUnit.receivedAt,
      },
    };
  }

  /**
   * Create supervised process using proper Process primitives.
   */
  private createSupervisedProcess(): ProcessRef<HandlerMessage> {
    const processBehavior = {
      handle: (state: HandlerInternalState, msg: HandlerMessage) => {
        // Simplified process handling - delegate to handler methods
        switch (msg.type) {
          case "metrics-request":
            msg.reply(this.getMetrics());
            return state;
          default:
            console.warn("Unknown message type:", msg);
            return state;
        }
      },
      init: () => this.internalState.deref(),
      terminate: () => {
        console.warn(`Handler process terminating`);
        // Trigger graceful shutdown
        this.stop()
          .unsafeRunPromise()
          .catch((error) => {
            console.error("Error during process termination:", error);
          });
      },
    };

    return createProcess(processBehavior, { clock: this.clock });
  }

  /**
   * Emit events through configured channels.
   */
  private emit(event: HandlerEvent): void {
    // Always append to journal
    this.options.journal.append(event);

    // Emit through configured function if provided
    if (this.options.emit) {
      this.options.emit(event);
    }
  }
}

/**
 * Create a new Handler instance using proper Phyxius constructs.
 */
export function createHandler<TInput, TOutput>(options: HandlerOptions<TInput, TOutput>): Handler<TInput, TOutput> {
  return new HandlerImpl(options);
}
