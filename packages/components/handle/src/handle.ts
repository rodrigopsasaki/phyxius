import { context } from "@phyxiusjs/context";
import { observe } from "@phyxiusjs/observe";
import { ok, err } from "@phyxiusjs/fp";
import type { Budget, Millis } from "@phyxiusjs/clock";
import type {
  CreateHandlerOptions,
  Handler,
  HandleParams,
  HandleResult,
  HandleError,
  HandleTools,
  CanonicalLog,
} from "./types.js";

// Internal schema for handle's infrastructure fields. These are written by
// handle itself — the caller's run() uses its own `observe.fields(...)` bags
// for domain data. Both end up in `ctx.data` and flow into the journal entry.
const handleFields = observe.fields({
  handlerName: observe.field<string>(),
  requestId: observe.field<string>(),
  startedAt: observe.field<number>(),
  durationMs: observe.field<number>(),
  success: observe.field<boolean>(),
  errorType: observe.field<string>(),
  errorMessage: observe.field<string>(),
});

// A signal that never aborts — returned to the run function when no timeout
// is configured, so tools.signal is always present and callers can pass it
// to AbortSignal-aware APIs without null-checking.
const NEVER_ABORT_SIGNAL: AbortSignal = new AbortController().signal;

/**
 * Creates a handler factory that wraps async operations with:
 * - AsyncLocalStorage context scope (via @phyxiusjs/context)
 * - Canonical log field accumulation (via @phyxiusjs/observe)
 * - Structured journal entries (via @phyxiusjs/journal)
 * - Clock-driven timeout via Budget (via @phyxiusjs/clock)
 *
 * @example
 * ```ts
 * import { observe } from "@phyxiusjs/observe";
 *
 * const fields = observe.fields({
 *   userId: observe.field<string>(),
 *   foundInCache: observe.field<boolean>(),
 * });
 *
 * const handle = createHandler({ clock, journal });
 *
 * const { result, log } = await handle({
 *   name: "getUser",
 *   initial: { userId: "123" },
 *   run: async ({ clock, signal }) => {
 *     const user = await fetch("/users/123", { signal }); // aborts on timeout
 *     fields.foundInCache.set(false);
 *     return user.json();
 *   },
 * });
 * ```
 */
export function createHandler(options: CreateHandlerOptions): Handler {
  const { clock, journal, defaultTimeoutMs, idGenerator } = options;

  // Per-factory counter. Two independent factories have independent sequences.
  let requestCounter = 0;
  const generateRequestId =
    idGenerator ??
    ((): string => {
      requestCounter += 1;
      return `req-${clock.now().wallMs.toString(36)}-${requestCounter.toString(36)}`;
    });

  return async function handle<T>(params: HandleParams<T>): Promise<HandleResult<T>> {
    const { name, initial = {}, run, timeoutMs } = params;
    const requestId = generateRequestId();
    const effectiveTimeout = timeoutMs ?? defaultTimeoutMs;

    return context.scope(
      async () => {
        const startedAt = clock.now().wallMs;

        handleFields.handlerName.set(name);
        handleFields.requestId.set(requestId);
        handleFields.startedAt.set(startedAt);

        // Budget drives both the timeout deadline and the AbortSignal handed
        // to the work. Release it on normal completion so the timer doesn't
        // leak past the call.
        const budget: Budget | undefined = effectiveTimeout !== undefined ? clock.timeout(effectiveTimeout) : undefined;

        const tools: HandleTools = {
          clock,
          signal: budget?.signal ?? NEVER_ABORT_SIGNAL,
        };

        let handlerResult: HandleResult<T>;

        try {
          const value =
            budget !== undefined ? await raceBudget(Promise.resolve(run(tools)), budget, name) : await run(tools);

          budget?.release();

          const durationMs = clock.now().wallMs - startedAt;
          handleFields.durationMs.set(durationMs);
          handleFields.success.set(true);

          const log = snapshotLog();
          journal.append(log);

          handlerResult = { result: ok(value), log };
        } catch (error) {
          budget?.release();

          const durationMs = clock.now().wallMs - startedAt;
          handleFields.durationMs.set(durationMs);
          handleFields.success.set(false);

          const handleError = toHandleError(error, name);
          handleFields.errorType.set(handleError.type);
          handleFields.errorMessage.set(describeError(handleError));

          const log = snapshotLog();
          journal.append(log);

          handlerResult = { result: err(handleError), log };
        }

        return handlerResult;
      },
      {
        // Caller-provided initial fields flow into the scope's data. They're
        // not declared through typed observe fields because they're seed
        // metadata (headers, correlation IDs, etc.) — the caller's `run` uses
        // its own typed observe.fields bags for domain writes.
        initial: { ...initial },
      },
    );
  };
}

/** Race the work against the Budget's abort signal. */
async function raceBudget<T>(workPromise: Promise<T>, budget: Budget, name: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      reject(new TimeoutError(name, budget.deadline.monoMs, asNumber(budget.remaining())));
    };

    // `budget.signal` aborts exactly once when the deadline passes.
    if (budget.signal.aborted) {
      onAbort();
      return;
    }
    budget.signal.addEventListener("abort", onAbort, { once: true });

    workPromise.then(
      (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      },
    );
  });
}

function asNumber(ms: Millis): number {
  return ms as unknown as number;
}

/**
 * Build the canonical log from the current scope's data. Contains handle's
 * typed infrastructure fields plus whatever the caller wrote via their own
 * typed observe fields or seeded via `initial`.
 */
function snapshotLog(): CanonicalLog {
  return { ...(context.get().data as Record<string, unknown>) } as CanonicalLog;
}

class TimeoutError extends Error {
  constructor(
    readonly handlerName: string,
    readonly deadlineMonoMs: number,
    readonly timeoutMs: number,
  ) {
    super(`Handler '${handlerName}' timed out`);
    this.name = "TimeoutError";
  }
}

function toHandleError(error: unknown, name: string): HandleError {
  if (error instanceof TimeoutError) {
    return { type: "TIMEOUT", timeoutMs: error.timeoutMs, name: error.handlerName };
  }

  return { type: "HANDLER_ERROR", name, cause: error };
}

function describeError(error: HandleError): string {
  switch (error.type) {
    case "TIMEOUT":
      return `Timed out after ${error.timeoutMs}ms`;
    case "HANDLER_ERROR": {
      const { cause } = error;
      if (cause instanceof Error) return cause.message;
      return String(cause);
    }
  }
}
