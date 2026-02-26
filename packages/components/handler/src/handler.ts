import { randomUUID } from "node:crypto";
import { createAtom } from "@phyxiusjs/atom";
import { createProcess } from "@phyxiusjs/process";
import { ok, err, isOk } from "@phyxiusjs/fp";
import type { Result } from "@phyxiusjs/fp";
import type { Millis } from "@phyxiusjs/clock";
import type {
  Handler,
  HandlerDefinition,
  HandlerConfig,
  HandlerState,
  HandlerMetrics,
  HandlerInternalState,
  HandlerJournalEvent,
  WorkMeta,
  HandlerMsg,
} from "./types.js";
import { HandlerError } from "./types.js";

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

/**
 * Declare a handler definition.
 * Nothing runs — this is pure configuration.
 * Call `createHandler()` to materialize it into a running process.
 *
 * @example
 * const myHandler = defineHandler({
 *   name: "user.processor",
 *   fn: getUserFunction,
 *   concurrency: { max: 10, backpressure: "reject", queueSize: 100 },
 * });
 */
export function defineHandler<TInput, TOutput>(
  definition: HandlerDefinition<TInput, TOutput>,
): HandlerDefinition<TInput, TOutput> {
  return definition;
}

/**
 * Materialize a HandlerDefinition into a running supervised Process.
 *
 * The Handler owns:
 * - Process lifecycle (start, stop, supervision/restart)
 * - Concurrency cap (at most `concurrency.max` simultaneous executions)
 * - Backpressure (what happens when the work queue is full)
 * - One mandatory Journal entry per completed work unit
 *
 * The Runtime owns (per-call):
 * - Timeout
 * - Retry
 * - Circuit breaking
 *
 * @example
 * const handler = createHandler(myHandlerDefinition, {
 *   clock, journal, runtime,
 * });
 * await handler.start();
 * const result = await handler.submit(input, { source: "http", correlationId: "abc-123" });
 */
export function createHandler<TInput, TOutput>(
  definition: HandlerDefinition<TInput, TOutput>,
  config: HandlerConfig,
): Handler<TInput, TOutput> {
  const { clock, journal, runtime } = config;
  const { fn, concurrency } = definition;

  // ── State ──────────────────────────────────────────────────────────────────
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
  // The Process processes one message at a time (single-threaded), so no locking needed.
  const workQueue: QueuedWork<TInput, TOutput>[] = [];

  // ── Work execution ─────────────────────────────────────────────────────────

  /**
   * Execute a work unit via the Runtime.
   * Appends a mandatory Journal event on completion.
   * Fires-and-forgets from within the Process message handler.
   */
  async function executeWork(work: QueuedWork<TInput, TOutput>): Promise<void> {
    const startedAt = clock.now().monoMs;

    const result = await runtime.execute(fn, work.input);

    const endedAt = clock.now();
    const durationMs = endedAt.monoMs - startedAt;
    const success = isOk(result);

    // Mandatory Journal event — never opt-in
    const journalEvent: HandlerJournalEvent = {
      executionId: work.correlationId,
      functionName: fn.name,
      source: work.meta.source ?? "unknown",
      correlationId: work.meta.correlationId ?? work.correlationId,
      durationMs,
      attempts: 1, // Runtime doesn't surface retry count; 1 = executed at least once
      outcome: success ? "success" : "failure",
      observedData: {}, // ctx.observe data is not surfaced through the current Runtime interface
      ...(success
        ? {}
        : {
            error: {
              code: result.error.code,
              message: result.error.message,
            },
          }),
      at: endedAt,
    };
    journal.append(journalEvent);

    // Update counters atomically
    stateAtom.swap((s) => ({
      ...s,
      activeCount: s.activeCount - 1,
      totalProcessed: s.totalProcessed + 1,
      totalSucceeded: s.totalSucceeded + (success ? 1 : 0),
      totalFailed: s.totalFailed + (success ? 0 : 1),
    }));

    // Settle the submit() promise
    if (success) {
      work.resolve(ok(result.value));
    } else {
      work.resolve(err(new HandlerError(result.error.message, "EXECUTION_FAILED", result.error)));
    }

    // Notify the Process that a concurrency slot has opened up
    void processRef.send({ type: "work-done" }).catch(() => {
      // Process has already stopped — ignore
    });
  }

  /**
   * Pick the next queued work item (if any) and begin executing it.
   * Only called from within the Process message pump.
   */
  function tryDequeueAndExecute(): void {
    const current = stateAtom.deref();
    // Don't start new work if the handler is draining/stopping
    if (current.status !== "running") return;
    if (workQueue.length > 0 && current.activeCount < concurrency.max) {
      const work = workQueue.shift()!;
      stateAtom.swap((s) => ({
        ...s,
        activeCount: s.activeCount + 1,
        queuedCount: s.queuedCount - 1,
      }));
      void executeWork(work);
    }
  }

  // ── Process ────────────────────────────────────────────────────────────────
  // The Process is the supervision and message-pump backbone.
  // It handles two message types:
  //   "submit"    — a new work unit arrives; enforce concurrency + backpressure
  //   "work-done" — a slot has freed up; dequeue next work if any

  // eslint-disable-next-line prefer-const
  let processRef = createProcess<HandlerMsg<TInput, TOutput>, HandlerInternalState>(
    {
      init: () => stateAtom.deref(),

      handle: (_state, msg) => {
        // The ProcessBehavior signature has optional params — guard against undefined
        if (msg === undefined) {
          return stateAtom.deref();
        }

        if (msg.type === "work-done") {
          tryDequeueAndExecute();
          return stateAtom.deref();
        }

        // At this point TypeScript knows msg is SubmitMsg<TInput, TOutput>
        const submitMsg = msg;

        // This message was counted as "pending" in submit(). Move it out of pending now.
        stateAtom.swap((s) => ({ ...s, pendingCount: s.pendingCount - 1 }));
        const current = stateAtom.deref();

        // Slot available and queue is empty — execute immediately
        if (current.activeCount < concurrency.max && workQueue.length === 0) {
          stateAtom.swap((s) => ({ ...s, activeCount: s.activeCount + 1 }));
          void executeWork({
            correlationId: submitMsg.correlationId,
            input: submitMsg.input,
            meta: submitMsg.meta,
            resolve: submitMsg.resolve,
          });
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
          submitMsg.resolve(err(new HandlerError("Queue is full — backpressure: reject", "BACKPRESSURE_REJECT")));
          return stateAtom.deref();
        }

        // "drop-oldest": evict the oldest queued item and enqueue the new one
        const dropped = workQueue.shift();
        if (dropped) {
          dropped.resolve(err(new HandlerError("Dropped by drop-oldest backpressure policy", "BACKPRESSURE_REJECT")));
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
        // Reject all queued work that hasn't started
        for (const work of workQueue.splice(0)) {
          work.resolve(err(new HandlerError("Handler stopped", "HANDLER_NOT_RUNNING")));
        }
      },
    },
    { clock },
  );

  // ── Public Handler ─────────────────────────────────────────────────────────

  const handler: Handler<TInput, TOutput> = {
    async start(): Promise<void> {
      const current = stateAtom.deref();
      if (current.status === "running") {
        throw new HandlerError("Handler is already running", "HANDLER_ALREADY_RUNNING");
      }
      if (current.status === "stopping" || current.status === "stopped") {
        throw new HandlerError("Handler cannot be restarted once stopped", "HANDLER_ALREADY_RUNNING");
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
      // Reject immediately if the handler is not in a state that accepts new work.
      // This check is synchronous — no await before it — so it's race-free in JS's single-threaded model.
      const current = stateAtom.deref();
      if (current.status !== "running") {
        return err(new HandlerError("Handler is not running", "HANDLER_NOT_RUNNING"));
      }

      // Track this submission as "pending" before sending to the Process mailbox.
      // The drain loop in stop() waits for pendingCount to reach 0, ensuring that
      // messages in the Process mailbox are processed before the Process is stopped.
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
              // Process mailbox was full — decrement pending and treat as immediate backpressure
              stateAtom.swap((s) => ({ ...s, pendingCount: s.pendingCount - 1 }));
              resolve(err(new HandlerError("Process mailbox full", "BACKPRESSURE_REJECT")));
            }
          })
          .catch(() => {
            // Process stopped before it could pick up the message — decrement pending
            stateAtom.swap((s) => ({ ...s, pendingCount: s.pendingCount - 1 }));
            resolve(err(new HandlerError("Handler is not running", "HANDLER_NOT_RUNNING")));
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
