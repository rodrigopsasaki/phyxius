import type { Budget, Millis } from "@phyxiusjs/clock";
import { createAtom, type Atom } from "@phyxiusjs/atom";
import { context } from "@phyxiusjs/context";
import { observe } from "@phyxiusjs/observe";
import { ok, err, type Result } from "@phyxiusjs/fp";
import { validate } from "@phyxiusjs/validate";
import { runWithRetry } from "@phyxiusjs/retry";
import { createCircuitBreaker, type CircuitBreaker } from "@phyxiusjs/circuit-breaker";
import { spawn as spawnProcess } from "@phyxiusjs/process";
import type {
  HandlerSpec,
  HandlerRuntime,
  HandlerTools,
  RunningHandler,
  HandlerStatus,
  HandlerMetrics,
  InvocationMeta,
  HandlerError,
  HandlerEvent,
} from "./types.js";

// ── defineHandler ───────────────────────────────────────────────────────────

/**
 * Declare a handler as pure data. Nothing is running yet — `spawn` materializes
 * the spec into a supervised, dispatching instance.
 *
 * All stability fields on `HandlerSpec` are required. A missing `timeout`,
 * `retry`, `circuitBreaker`, or `concurrency` is a compile error. Use
 * `retry.none()` / `cb.none()` to declare "no retry / no breaker" as
 * explicit values — silence is not a valid answer.
 */
export function defineHandler<TInput, TOutput, TFields>(
  spec: HandlerSpec<TInput, TOutput, TFields>,
): HandlerSpec<TInput, TOutput, TFields> {
  if (spec.concurrency.max < 1) {
    throw new Error(`handler "${spec.name}": concurrency.max must be >= 1`);
  }
  if (spec.concurrency.queueSize < 0) {
    throw new Error(`handler "${spec.name}": concurrency.queueSize must be >= 0`);
  }
  if (spec.timeout < 0) {
    throw new Error(`handler "${spec.name}": timeout must be >= 0`);
  }
  return spec;
}

// ── spawn ───────────────────────────────────────────────────────────────────

/**
 * Materialize a handler spec into a supervised, running instance.
 *
 * The instance is backed by a Process (per the authored invariant: "Handler
 * lifecycles must be supervised by Process"). Dispatch of invocations uses
 * atom-managed state for concurrency accounting + a simple work queue. The
 * work body composes circuit-breaker → retry → budget timeout → the user's
 * `run` function, wrapped in a context scope that captures every typed field
 * into one journal entry per invocation.
 */
export async function spawn<TInput, TOutput, TFields>(
  spec: HandlerSpec<TInput, TOutput, TFields>,
  runtime: HandlerRuntime,
): Promise<RunningHandler<TInput, TOutput>> {
  const { clock, journal } = runtime;
  const includeExtra = runtime.includeExtra ?? (() => true);

  // Per-factory invocation counter — avoid module-global state.
  let invocationCounter = 0;
  const nextInvocationId =
    runtime.idGenerator ??
    ((): string => {
      invocationCounter += 1;
      return `inv-${clock.now().wallMs.toString(36)}-${invocationCounter.toString(36)}`;
    });

  // ── Internal state ──────────────────────────────────────────────────────

  interface InternalState {
    readonly status: HandlerStatus;
    readonly activeCount: number;
    readonly queuedCount: number;
    readonly totalInvocations: number;
    readonly totalSuccesses: number;
    readonly totalFailures: number;
  }

  const state: Atom<InternalState> = createAtom<InternalState>(
    {
      status: "idle",
      activeCount: 0,
      queuedCount: 0,
      totalInvocations: 0,
      totalSuccesses: 0,
      totalFailures: 0,
    },
    clock,
  );

  // Circuit breaker — shared across all invocations, per the handler spec.
  const breaker: CircuitBreaker = createCircuitBreaker({
    policy: spec.circuitBreaker,
    clock,
  });

  // Work queue — mutated only from sync dispatch paths, no cross-thread
  // concerns in Node single-threaded execution.
  interface QueuedWork {
    readonly invocationId: string;
    readonly input: TInput;
    readonly meta: InvocationMeta;
    readonly resolve: (result: Result<TOutput, HandlerError>) => void;
  }
  const queue: QueuedWork[] = [];

  // ── Internal schema for the journal entry's structured fields ───────────
  //
  // The handler's infrastructure fields are stamped via these typed handles
  // inside each invocation's context scope. The caller's `spec.fields` bag
  // accumulates domain data in the same scope; everything merges into one
  // journal event at completion.

  const infraFields = observe.fields({
    __handlerName: observe.field<string>(),
    __invocationId: observe.field<string>(),
    __correlationId: observe.field<string>(),
    __source: observe.field<string>(),
    __startedAtWallMs: observe.field<number>(),
  });

  // ── Process for lifecycle supervision ───────────────────────────────────

  interface HandlerProcessMsg {
    readonly type: "__noop";
  }

  const process = await spawnProcess<HandlerProcessMsg, void>(
    {
      name: `handler:${spec.name}`,
      handle: () => {
        // The handler's work dispatch happens outside the process loop —
        // this process exists to satisfy the "supervised lifecycle"
        // invariant, hold start/stop semantics, and emit lifecycle events.
      },
      onStop: async () => {
        // Cleanup hook — the outer `stop()` has already drained/rejected.
      },
    },
    { clock },
  );

  state.swap((s) => ({ ...s, status: "running" }));

  // ── Dispatch loop ───────────────────────────────────────────────────────

  function tryDispatch(): void {
    const s = state.deref();
    if (s.status !== "running" && s.status !== "stopping") return;
    if (s.activeCount >= spec.concurrency.max) return;
    if (queue.length === 0) return;

    const work = queue.shift();
    if (!work) return;

    state.swap((prev) => ({
      ...prev,
      activeCount: prev.activeCount + 1,
      queuedCount: prev.queuedCount - 1,
    }));

    void executeWork(work).finally(() => {
      state.swap((prev) => ({ ...prev, activeCount: prev.activeCount - 1 }));
      tryDispatch();
    });
  }

  // ── Single-invocation execution ─────────────────────────────────────────
  //
  // Everything runs inside a single `context.scope` so:
  //   - infra fields + caller's observe fields accumulate in one bag
  //   - the observed snapshot can be captured before the scope exits
  //
  // The outcome returned from the scope carries both the Result and the
  // observed data we want on the journal event.

  interface InvocationOutcome {
    readonly result: Result<TOutput, HandlerError>;
    readonly attempts: number;
    readonly observed: Record<string, unknown>;
  }

  async function executeWork(work: QueuedWork): Promise<void> {
    const { invocationId, input, meta } = work;
    const startedAt = clock.now();

    const outcome: InvocationOutcome = await context.scope<Record<string, unknown>, InvocationOutcome>(
      async () => {
        // Stamp infra fields into the scope.
        infraFields.__handlerName.set(spec.name);
        infraFields.__invocationId.set(invocationId);
        infraFields.__source.set(meta.source ?? "internal");
        infraFields.__startedAtWallMs.set(startedAt.wallMs);
        if (meta.correlationId) {
          infraFields.__correlationId.set(meta.correlationId);
        }

        const result = await runInvocation(input, meta);
        return {
          result: result.result,
          attempts: result.attempts,
          observed: snapshotObservedFromCurrentScope(),
        };
      },
      { initial: { ...(meta.context ?? {}) } },
    );

    const completedAt = clock.now();
    const durationMs = completedAt.monoMs - startedAt.monoMs;

    const baseEvent = {
      name: spec.name,
      invocationId,
      source: meta.source ?? "internal",
      startedAt,
      completedAt,
      durationMs,
      attempts: outcome.attempts,
      observed: outcome.observed,
      ...(meta.correlationId ? { correlationId: meta.correlationId } : {}),
      ...(meta.context ? { meta: { ...meta.context } } : {}),
    } as const;

    const event: HandlerEvent =
      outcome.result._tag === "Ok"
        ? { ...baseEvent, outcome: "success" as const }
        : {
            ...baseEvent,
            outcome: "failure" as const,
            error: describeError(outcome.result.error),
          };

    journal.append(event);

    state.swap((s) => ({
      ...s,
      totalInvocations: s.totalInvocations + 1,
      totalSuccesses: s.totalSuccesses + (outcome.result._tag === "Ok" ? 1 : 0),
      totalFailures: s.totalFailures + (outcome.result._tag === "Ok" ? 0 : 1),
    }));

    work.resolve(outcome.result);
  }

  /**
   * Run the validate → breaker → retry → run → validate pipeline. Returns the
   * Result and the number of attempts made (1 for "no retry," N for N
   * attempts when retries were configured).
   */
  async function runInvocation(
    input: TInput,
    _meta: InvocationMeta,
  ): Promise<{ result: Result<TOutput, HandlerError>; attempts: number }> {
    const parsedInput = validate(spec.input, input);
    if (parsedInput._tag === "Err") {
      return {
        result: err({
          type: "VALIDATION_ERROR" as const,
          target: "input" as const,
          error: parsedInput.error,
        }),
        attempts: 0,
      };
    }

    // One Budget per invocation; retries SHARE it. The budget bounds the
    // entire operation — if it expires during a retry wait or mid-attempt,
    // we surface TIMEOUT.
    const budget: Budget = clock.timeout(spec.timeout);

    const tools: HandlerTools = {
      clock,
      budget,
      signal: budget.signal,
    };

    // Count attempts by incrementing before each `spec.run` call.
    let attempts = 0;

    const attemptOnce = async (): Promise<TOutput> => {
      attempts += 1;
      const breakerResult = await breaker.execute(() => spec.run(parsedInput.value, tools));
      if (breakerResult._tag === "Err") {
        throw new CircuitOpenThrown(breakerResult.error);
      }
      return breakerResult.value;
    };

    let retryResult: Awaited<ReturnType<typeof runWithRetry<TOutput>>>;
    try {
      retryResult = await runWithRetry(attemptOnce, spec.retry, clock, {
        signal: budget.signal,
      });
    } catch (thrown) {
      budget.release();
      return {
        result: err({ type: "HANDLER_ERROR" as const, cause: thrown }),
        attempts: attempts || 1,
      };
    }

    budget.release();

    if (retryResult._tag === "Err") {
      switch (retryResult.error.type) {
        case "ABORTED":
          return {
            result: err({ type: "TIMEOUT" as const, timeoutMs: spec.timeout }),
            attempts: attempts || retryResult.error.attempts,
          };
        case "REJECTED": {
          const e = retryResult.error.error;
          if (e instanceof CircuitOpenThrown) {
            return { result: err(e.asHandlerError()), attempts: attempts || 1 };
          }
          return {
            result: err({ type: "HANDLER_ERROR" as const, cause: e }),
            attempts: attempts || 1,
          };
        }
        case "EXHAUSTED": {
          const last = retryResult.error.lastError;
          if (last instanceof CircuitOpenThrown) {
            return { result: err(last.asHandlerError()), attempts: attempts || 1 };
          }
          if (spec.retry.maxAttempts === 1) {
            // retry.none() — single attempt, plain handler error.
            return {
              result: err({ type: "HANDLER_ERROR" as const, cause: last }),
              attempts: 1,
            };
          }
          return {
            result: err({
              type: "RETRY_EXHAUSTED" as const,
              attempts: retryResult.error.attempts,
              lastCause: last,
            }),
            attempts: retryResult.error.attempts,
          };
        }
      }
    }

    // Success path — validate output.
    const validated = validate(spec.output, retryResult.value);
    if (validated._tag === "Err") {
      return {
        result: err({
          type: "VALIDATION_ERROR" as const,
          target: "output" as const,
          error: validated.error,
        }),
        attempts,
      };
    }

    return { result: ok(validated.value), attempts };
  }

  /**
   * Build the set of field keys the spec declared as `"extra"`. Computed
   * once at spawn time — field tiers are schema-level and don't change
   * across invocations.
   */
  const extraFieldKeys = new Set<string>();
  for (const handle of Object.values(spec.fields as Record<string, { key: string; tier: "core" | "extra" }>)) {
    if (handle && handle.tier === "extra") extraFieldKeys.add(handle.key);
  }

  /**
   * Snapshot the current context scope's data, stripping handler-internal
   * infra keys (`__handlerName`, etc.) so the `observed` field on the
   * journal entry holds only caller-written observations.
   *
   * Fields declared as `observe.extra*()` are filtered out when the
   * runtime's `includeExtra()` getter returns false. Call the getter once
   * per snapshot so hot-reloadable config takes effect on the next event,
   * no restart required.
   */
  function snapshotObservedFromCurrentScope(): Record<string, unknown> {
    const ctx = context.current();
    if (!ctx) return {};
    const data = ctx.data as Record<string, unknown>;
    const shipExtras = includeExtra();
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (k.startsWith("__")) continue;
      if (!shipExtras && extraFieldKeys.has(k)) continue;
      copy[k] = v;
    }
    return copy;
  }

  // ── Public handle ───────────────────────────────────────────────────────

  function currentCircuitState(): HandlerMetrics["circuitState"] {
    if (!spec.circuitBreaker.enabled) return "disabled";
    return breaker.snapshot().state;
  }

  const handler: RunningHandler<TInput, TOutput> = {
    id: process.id,
    name: spec.name,

    async invoke(input: TInput, meta: InvocationMeta = {}): Promise<Result<TOutput, HandlerError>> {
      const s = state.deref();
      if (s.status !== "running") {
        return err({ type: "HANDLER_NOT_RUNNING" });
      }

      // Admission control: combined active + queued against queueSize.
      const totalInFlight = s.activeCount + s.queuedCount;
      const capacity = spec.concurrency.max + spec.concurrency.queueSize;

      if (totalInFlight >= capacity) {
        if (spec.concurrency.backpressure === "reject") {
          return err({ type: "BACKPRESSURE_REJECT" });
        }
        // drop-oldest: evict the front of the queue.
        const dropped = queue.shift();
        if (dropped) {
          dropped.resolve(err({ type: "DROPPED" }));
          state.swap((prev) => ({ ...prev, queuedCount: prev.queuedCount - 1 }));
        }
      }

      return new Promise<Result<TOutput, HandlerError>>((resolve) => {
        const work: QueuedWork = {
          invocationId: nextInvocationId(),
          input,
          meta,
          resolve,
        };

        queue.push(work);
        state.swap((prev) => ({ ...prev, queuedCount: prev.queuedCount + 1 }));

        tryDispatch();
      });
    },

    getMetrics(): HandlerMetrics {
      const s = state.deref();
      return {
        status: s.status,
        activeCount: s.activeCount,
        queuedCount: s.queuedCount,
        totalInvocations: s.totalInvocations,
        totalSuccesses: s.totalSuccesses,
        totalFailures: s.totalFailures,
        circuitState: currentCircuitState(),
      };
    },

    getStatus(): HandlerStatus {
      return state.deref().status;
    },

    async stop(options?: { drainTimeoutMs?: Millis }): Promise<void> {
      const current = state.deref();
      if (current.status !== "running") return;

      state.swap((s) => ({ ...s, status: "stopping" }));

      const drainTimeoutMs = options?.drainTimeoutMs ?? (10_000 as Millis);
      const deadline = clock.now().monoMs + drainTimeoutMs;

      // Wait for active invocations to drain.
      while (state.deref().activeCount > 0) {
        if (clock.now().monoMs > deadline) break;
        await clock.sleep(10 as Millis);
      }

      // Reject any remaining queued work — they never started.
      while (queue.length > 0) {
        const work = queue.shift();
        if (work) {
          work.resolve(err({ type: "HANDLER_NOT_RUNNING" }));
          state.swap((s) => ({ ...s, queuedCount: s.queuedCount - 1 }));
        }
      }

      state.swap((s) => ({ ...s, status: "stopped" }));
      await process.stop();
    },
  };

  return handler;
}

// ── Internals ───────────────────────────────────────────────────────────────

/** Lets the retry loop distinguish breaker-open failures from generic throws. */
class CircuitOpenThrown extends Error {
  readonly openedAt: number;
  readonly willRetryAfter: number;

  constructor(info: { openedAt: number; willRetryAfter: number }) {
    super("Circuit breaker is open");
    this.name = "CircuitOpenThrown";
    this.openedAt = info.openedAt;
    this.willRetryAfter = info.willRetryAfter;
  }

  asHandlerError(): HandlerError {
    return {
      type: "CIRCUIT_OPEN",
      openedAt: this.openedAt,
      willRetryAfter: this.willRetryAfter,
    };
  }
}

function describeError(error: HandlerError): {
  type: HandlerError["type"];
  message: string;
  stack?: string;
} {
  switch (error.type) {
    case "VALIDATION_ERROR": {
      const firstIssue = error.error.issues[0];
      const path = firstIssue?.path.length ? ` at ${firstIssue.path.join(".")}` : "";
      return {
        type: error.type,
        message: `Validation failed on ${error.target}${path}: ${firstIssue?.message ?? "unknown"}`,
      };
    }
    case "TIMEOUT":
      return { type: error.type, message: `Timed out after ${error.timeoutMs}ms` };
    case "HANDLER_ERROR": {
      const { cause } = error;
      if (cause instanceof Error) {
        const base: { type: HandlerError["type"]; message: string; stack?: string } = {
          type: error.type,
          message: cause.message,
        };
        if (cause.stack) base.stack = cause.stack;
        return base;
      }
      return { type: error.type, message: String(cause) };
    }
    case "RETRY_EXHAUSTED": {
      const cause = error.lastCause;
      const causeMsg = cause instanceof Error ? cause.message : String(cause);
      return {
        type: error.type,
        message: `Retries exhausted after ${error.attempts} attempts: ${causeMsg}`,
      };
    }
    case "CIRCUIT_OPEN":
      return {
        type: error.type,
        message: `Circuit breaker is open (opened at ${error.openedAt})`,
      };
    case "BACKPRESSURE_REJECT":
      return { type: error.type, message: "Queue is full — rejected" };
    case "DROPPED":
      return { type: error.type, message: "Dropped by backpressure: drop-oldest" };
    case "HANDLER_NOT_RUNNING":
      return { type: error.type, message: "Handler is not running" };
  }
}
