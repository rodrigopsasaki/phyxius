import { randomUUID } from "node:crypto";
import { createAtom } from "@phyxiusjs/atom";
import { createProcess } from "@phyxiusjs/process";
import { context } from "@phyxiusjs/context";
import { observe } from "@phyxiusjs/observe";
import { ok, err } from "@phyxiusjs/fp";
import type { Result } from "@phyxiusjs/fp";
import type { Millis } from "@phyxiusjs/clock";
import type {
  Handler,
  HandlerDefinition,
  HandlerConfig,
  HandlerState,
  HandlerMetrics,
  HandlerInternalState,
  HandlerEvent,
  WorkMeta,
  HandlerMsg,
  CircuitBreakerInternalState,
} from "./types.js";
import { HandlerError } from "./types.js";

// ── Internal types ──────────────────────────────────────────────────────────

/**
 * A pending work item holding the input and its settlement callback.
 * Lives in the mutable work queue, which is only accessed from within
 * the Process message pump (single-threaded — no races).
 */
interface QueuedWork<TInput, TOutput> {
  readonly correlationId: string;
  readonly input: TInput;
  readonly meta: WorkMeta;
  readonly resolve: (result: Result<TOutput, HandlerError>) => void;
}

// ── defineHandler ───────────────────────────────────────────────────────────

/**
 * Declare a handler definition.
 * Nothing runs — this is pure configuration.
 * Call `createHandler()` to materialize it into a running process.
 *
 * @example
 * const myHandler = defineHandler({
 *   name: "user.processor",
 *   processor: async (input) => processUser(input),
 *   concurrency: { max: 10, backpressure: "reject", queueSize: 100 },
 *   timeout: 5_000 as Millis,
 *   retry: { maxAttempts: 3, backoff: "exponential" },
 * });
 */
export function defineHandler<TInput, TOutput>(
  definition: HandlerDefinition<TInput, TOutput>,
): HandlerDefinition<TInput, TOutput> {
  return definition;
}

// ── createHandler ───────────────────────────────────────────────────────────

/**
 * Materialize a HandlerDefinition into a running supervised Process.
 *
 * The Handler is fully self-contained:
 * - Process lifecycle (start, stop, supervision/restart)
 * - Concurrency cap (at most `concurrency.max` simultaneous executions)
 * - Backpressure (what happens when the work queue is full)
 * - Timeout, retry, circuit-breaker (built-in, not delegated)
 * - Context scope + Observe per execution (captured into Journal event)
 * - One mandatory Journal entry per completed work unit
 *
 * @example
 * const handler = createHandler(myDefinition, { clock, journal });
 * await handler.start();
 * const result = await handler.submit(input, { source: "http" });
 */
export function createHandler<TInput, TOutput>(
  definition: HandlerDefinition<TInput, TOutput>,
  config: HandlerConfig,
): Handler<TInput, TOutput> {
  const { clock, journal } = config;
  const { processor, concurrency, name: handlerName } = definition;

  // ── Resilience defaults ─────────────────────────────────────────────────
  const retryConfig = definition.retry;
  const timeoutMs = definition.timeout;
  const cbConfig = definition.circuitBreaker;

  // ── Circuit breaker state ───────────────────────────────────────────────
  const circuitBreaker = cbConfig
    ? createAtom<CircuitBreakerInternalState>(
        { state: "closed", consecutiveFailures: 0, openedAt: 0 },
        clock,
      )
    : undefined;

  // ── Handler state ───────────────────────────────────────────────────────
  const initialState: HandlerInternalState = {
    status: "idle",
    activeCount: 0,
    queuedCount: 0,
    pendingCount: 0,
    totalProcessed: 0,
    totalSucceeded: 0,
    totalFailed: 0,
  };

  const stateAtom = createAtom(initialState, clock);

  // Work queue — mutable but only accessed from within the Process message pump.
  const workQueue: QueuedWork<TInput, TOutput>[] = [];

  // ── Resilience: timeout wrapper ─────────────────────────────────────────

  async function withTimeout<T>(fn: () => Promise<T>, ms: Millis): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new HandlerError(`Execution timed out after ${ms}ms`, "EXECUTION_TIMEOUT"));
        }
      }, ms);

      fn()
        .then((value) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(value);
          }
        })
        .catch((error: unknown) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(error);
          }
        });
    });
  }

  // ── Resilience: retry wrapper ───────────────────────────────────────────

  async function withRetry(
    fn: () => Promise<TOutput>,
    config: NonNullable<HandlerDefinition<TInput, TOutput>["retry"]>,
  ): Promise<{ value: TOutput; attempts: number }> {
    const { maxAttempts, backoff } = config;
    const initialDelay = config.initialDelay ?? (100 as Millis);
    const maxDelay = config.maxDelay ?? (30_000 as Millis);

    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const value = await fn();
        return { value, attempts: attempt };
      } catch (error: unknown) {
        lastError = error;
        if (attempt < maxAttempts) {
          const delay =
            backoff === "exponential"
              ? Math.min(initialDelay * 2 ** (attempt - 1), maxDelay)
              : initialDelay;
          await clock.sleep(delay as Millis);
        }
      }
    }

    throw lastError;
  }

  // ── Resilience: circuit breaker ─────────────────────────────────────────

  function checkCircuitBreaker(): void {
    if (!circuitBreaker || !cbConfig) return;

    const cb = circuitBreaker.deref();

    if (cb.state === "open") {
      const elapsed = clock.now().monoMs - cb.openedAt;
      if (elapsed >= cbConfig.resetTimeout) {
        // Transition to half-open — allow one probe
        circuitBreaker.swap((s) => ({ ...s, state: "half-open" }));
      } else {
        throw new HandlerError("Circuit breaker is open", "CIRCUIT_OPEN");
      }
    }
    // "closed" and "half-open" allow execution
  }

  function recordCircuitSuccess(): void {
    if (!circuitBreaker) return;
    circuitBreaker.swap(() => ({ state: "closed", consecutiveFailures: 0, openedAt: 0 }));
  }

  function recordCircuitFailure(): void {
    if (!circuitBreaker || !cbConfig) return;

    circuitBreaker.swap((s) => {
      const failures = s.consecutiveFailures + 1;
      if (failures >= cbConfig.failureThreshold) {
        return { state: "open", consecutiveFailures: failures, openedAt: clock.now().monoMs };
      }
      return { ...s, consecutiveFailures: failures };
    });
  }

  // ── Work execution ────────────────────────────────────────────────────────

  /**
   * Execute a work unit with full resilience and observability wiring.
   * Establishes a Context scope, captures observe data, applies timeout/retry/CB,
   * and appends a mandatory Journal event on completion.
   */
  async function executeWork(
    work: QueuedWork<TInput, TOutput>,
    executionId: string,
    startedAt: ReturnType<typeof clock.now>,
  ): Promise<void> {
    // Check circuit breaker before executing
    try {
      checkCircuitBreaker();
    } catch (cbError: unknown) {
      const completedAt = clock.now();
      const durationMs = completedAt.monoMs - startedAt.monoMs;

      const journalEvent: HandlerEvent = {
        handlerName,
        executionId,
        startedAt,
        completedAt,
        durationMs,
        attempts: 0,
        outcome: "failure",
        source: work.meta.source ?? "unknown",
        correlationId: work.meta.correlationId ?? executionId,
        observed: {},
        error:
          cbError instanceof Error
            ? { message: cbError.message }
            : { message: String(cbError) },
        meta: work.meta,
      };
      journal.append(journalEvent);

      stateAtom.swap((s) => ({
        ...s,
        activeCount: s.activeCount - 1,
        totalProcessed: s.totalProcessed + 1,
        totalFailed: s.totalFailed + 1,
      }));

      work.resolve(
        err(
          cbError instanceof HandlerError
            ? cbError
            : new HandlerError("Circuit breaker error", "CIRCUIT_OPEN", cbError),
        ),
      );

      notifyWorkDone();
      return;
    }

    // Execute within Context scope to capture observe data
    type ExecutionOutcome =
      | {
          readonly success: true;
          readonly value: TOutput;
          readonly attempts: number;
          readonly observed: Readonly<Record<string, unknown>>;
        }
      | {
          readonly success: false;
          readonly error: { readonly message: string; readonly stack?: string };
          readonly attempts: number;
          readonly observed: Readonly<Record<string, unknown>>;
        };

    const outcome = await context.scope<Record<string, unknown>, ExecutionOutcome>(async () => {
      // Seed observe context with handler metadata
      observe.set("handler", handlerName);
      observe.set("executionId", executionId);
      observe.set("source", work.meta.source ?? "unknown");

      // Copy adapter-provided context (e.g., HTTP method, path, query) into observe
      if (work.meta.context) {
        for (const [key, value] of Object.entries(work.meta.context)) {
          observe.set(key, value);
        }
      }

      let attempts = 1;

      try {
        function makeExecutor(): () => Promise<TOutput> {
          if (timeoutMs !== undefined) {
            return () => withTimeout(() => processor(work.input), timeoutMs);
          }
          return () => processor(work.input);
        }

        const executor = makeExecutor();

        let value: TOutput;
        if (retryConfig) {
          const retryResult = await withRetry(executor, retryConfig);
          ({ attempts } = retryResult);
          ({ value } = retryResult);
        } else {
          value = await executor();
        }

        observe.set("attempts", attempts);
        const observed = { ...observe.all() };
        return { success: true as const, value, attempts, observed };
      } catch (error: unknown) {
        observe.set("attempts", attempts);
        const observed = { ...observe.all() };

        if (error instanceof Error) {
          const errorDetail: { readonly message: string; readonly stack?: string } = error.stack
            ? { message: error.message, stack: error.stack }
            : { message: error.message };
          return {
            success: false as const,
            error: errorDetail,
            attempts,
            observed,
          };
        }
        return {
          success: false as const,
          error: { message: String(error) },
          attempts,
          observed,
        };
      }
    });

    const completedAt = clock.now();
    const durationMs = completedAt.monoMs - startedAt.monoMs;

    // Record circuit breaker result
    if (outcome.success) {
      recordCircuitSuccess();
    } else {
      recordCircuitFailure();
    }

    // Mandatory Journal event
    const baseEvent = {
      handlerName,
      executionId,
      startedAt,
      completedAt,
      durationMs,
      attempts: outcome.attempts,
      source: work.meta.source ?? "unknown",
      correlationId: work.meta.correlationId ?? executionId,
      observed: outcome.observed,
      meta: work.meta,
    } as const;

    const journalEvent: HandlerEvent = outcome.success
      ? { ...baseEvent, outcome: "success" }
      : { ...baseEvent, outcome: "failure", error: outcome.error };
    journal.append(journalEvent);

    // Update counters
    stateAtom.swap((s) => ({
      ...s,
      activeCount: s.activeCount - 1,
      totalProcessed: s.totalProcessed + 1,
      totalSucceeded: s.totalSucceeded + (outcome.success ? 1 : 0),
      totalFailed: s.totalFailed + (outcome.success ? 0 : 1),
    }));

    // Settle the submit() promise
    if (outcome.success) {
      work.resolve(ok(outcome.value as TOutput));
    } else {
      work.resolve(
        err(
          new HandlerError(
            outcome.error?.message ?? "Execution failed",
            "EXECUTION_FAILED",
            outcome.error,
          ),
        ),
      );
    }

    notifyWorkDone();
  }

  function notifyWorkDone(): void {
    void processRef.send({ type: "work-done" }).catch(() => {
      // Process has already stopped — ignore
    });
  }

  // ── Queue management ──────────────────────────────────────────────────────

  /**
   * Pick the next queued work item (if any) and begin executing it.
   * Only called from within the Process message pump.
   */
  function tryDequeueAndExecute(): void {
    const current = stateAtom.deref();
    if (current.status !== "running") return;
    if (workQueue.length > 0 && current.activeCount < concurrency.max) {
      const work = workQueue.shift()!;
      stateAtom.swap((s) => ({
        ...s,
        activeCount: s.activeCount + 1,
        queuedCount: s.queuedCount - 1,
      }));
      void executeWork(work, work.correlationId, clock.now());
    }
  }

  // ── Process ───────────────────────────────────────────────────────────────

  // eslint-disable-next-line prefer-const
  let processRef = createProcess<HandlerMsg<TInput, TOutput>, HandlerInternalState>(
    {
      init: () => stateAtom.deref(),

      handle: (_state, msg) => {
        if (msg === undefined) {
          return stateAtom.deref();
        }

        if (msg.type === "work-done") {
          tryDequeueAndExecute();
          return stateAtom.deref();
        }

        const submitMsg = msg;

        // Move out of pending
        stateAtom.swap((s) => ({ ...s, pendingCount: s.pendingCount - 1 }));
        const current = stateAtom.deref();

        // Slot available and queue is empty — execute immediately
        if (current.activeCount < concurrency.max && workQueue.length === 0) {
          stateAtom.swap((s) => ({ ...s, activeCount: s.activeCount + 1 }));
          void executeWork(
            {
              correlationId: submitMsg.correlationId,
              input: submitMsg.input,
              meta: submitMsg.meta,
              resolve: submitMsg.resolve,
            },
            submitMsg.correlationId,
            clock.now(),
          );
          return stateAtom.deref();
        }

        // Queue has capacity — enqueue
        if (workQueue.length < concurrency.queueSize) {
          workQueue.push({
            correlationId: submitMsg.correlationId,
            input: submitMsg.input,
            meta: submitMsg.meta,
            resolve: submitMsg.resolve,
          });
          stateAtom.swap((s) => ({ ...s, queuedCount: s.queuedCount + 1 }));
          return stateAtom.deref();
        }

        // Queue is full — apply backpressure
        if (concurrency.backpressure === "reject") {
          submitMsg.resolve(
            err(new HandlerError("Queue is full — backpressure: reject", "BACKPRESSURE_REJECT")),
          );
          return stateAtom.deref();
        }

        // "drop-oldest": evict the oldest queued item and enqueue the new one
        const dropped = workQueue.shift();
        if (dropped) {
          dropped.resolve(
            err(
              new HandlerError(
                "Dropped by drop-oldest backpressure policy",
                "BACKPRESSURE_REJECT",
              ),
            ),
          );
          stateAtom.swap((s) => ({ ...s, queuedCount: s.queuedCount - 1 }));
        }
        workQueue.push({
          correlationId: submitMsg.correlationId,
          input: submitMsg.input,
          meta: submitMsg.meta,
          resolve: submitMsg.resolve,
        });
        stateAtom.swap((s) => ({ ...s, queuedCount: s.queuedCount + 1 }));
        return stateAtom.deref();
      },

      terminate: () => {
        for (const work of workQueue.splice(0)) {
          work.resolve(err(new HandlerError("Handler stopped", "HANDLER_NOT_RUNNING")));
        }
      },
    },
    { clock },
  );

  // ── Public Handler ────────────────────────────────────────────────────────

  const handler: Handler<TInput, TOutput> = {
    async start(): Promise<void> {
      const current = stateAtom.deref();
      if (current.status === "running") {
        throw new HandlerError("Handler is already running", "HANDLER_ALREADY_RUNNING");
      }
      if (current.status === "stopping" || current.status === "stopped") {
        throw new HandlerError(
          "Handler cannot be restarted once stopped",
          "HANDLER_ALREADY_RUNNING",
        );
      }
      stateAtom.swap((s) => ({ ...s, status: "running" }));
      await processRef.start();
    },

    async stop(): Promise<void> {
      const current = stateAtom.deref();
      if (current.status !== "running") {
        return;
      }

      stateAtom.swap((s) => ({ ...s, status: "stopping" }));

      // Drain active work with a timeout
      const shutdownTimeoutMs = 10_000;
      const deadline = clock.now().monoMs + shutdownTimeoutMs;

      while (stateAtom.deref().activeCount > 0 || stateAtom.deref().pendingCount > 0) {
        if (clock.now().monoMs > deadline) {
          throw new HandlerError("Graceful shutdown timeout exceeded", "SHUTDOWN_TIMEOUT");
        }
        await clock.sleep(10 as Millis);
      }

      // Reject remaining queued items that haven't started
      for (const work of workQueue.splice(0)) {
        work.resolve(err(new HandlerError("Handler stopped", "HANDLER_NOT_RUNNING")));
      }

      stateAtom.swap((s) => ({ ...s, status: "stopped", queuedCount: 0 }));
      await processRef.stop();
    },

    async submit(input: TInput, meta: WorkMeta = {}): Promise<Result<TOutput, HandlerError>> {
      const current = stateAtom.deref();
      if (current.status !== "running") {
        return err(new HandlerError("Handler is not running", "HANDLER_NOT_RUNNING"));
      }

      stateAtom.swap((s) => ({ ...s, pendingCount: s.pendingCount + 1 }));

      return new Promise((resolve) => {
        const correlationId = meta.correlationId ?? randomUUID();
        const msg: HandlerMsg<TInput, TOutput> = {
          type: "submit",
          correlationId,
          input,
          meta,
          resolve,
        };

        processRef
          .send(msg)
          .then((sent) => {
            if (!sent) {
              stateAtom.swap((s) => ({ ...s, pendingCount: s.pendingCount - 1 }));
              resolve(
                err(new HandlerError("Process mailbox full", "BACKPRESSURE_REJECT")),
              );
            }
          })
          .catch(() => {
            stateAtom.swap((s) => ({ ...s, pendingCount: s.pendingCount - 1 }));
            resolve(
              err(new HandlerError("Handler is not running", "HANDLER_NOT_RUNNING")),
            );
          });
      });
    },

    getMetrics(): HandlerMetrics {
      const s = stateAtom.deref();
      return {
        state: s.status,
        activeCount: s.activeCount,
        queuedCount: s.queuedCount,
        totalProcessed: s.totalProcessed,
        totalSucceeded: s.totalSucceeded,
        totalFailed: s.totalFailed,
      };
    },

    getState(): HandlerState {
      return stateAtom.deref().status;
    },
  };

  return handler;
}
