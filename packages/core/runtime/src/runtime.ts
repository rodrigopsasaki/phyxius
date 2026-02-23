import { randomUUID } from "node:crypto";
import type { Clock, Millis } from "@phyxiusjs/clock";
import { ok, err, isOk, isErr, type Result } from "@phyxiusjs/fp";
import {
  type FunctionLayer,
  type ServiceFunction,
  type DataContext,
  type DomainContext,
  type OrchestrationContext,
  type ExecutionMetadata,
  ServiceError,
  calculateRetryDelay,
  shouldRetry,
} from "@phyxiusjs/service";
import type {
  Runtime,
  RuntimeConfig,
  ExecuteOptions,
  CircuitBreakerEntry,
} from "./types.js";
import { createObserveContext } from "./observe.js";
import {
  createCircuitBreaker,
  createInMemoryCircuitBreakerStore,
  type CircuitBreaker,
} from "./circuit-breaker.js";

/**
 * Create a runtime execution environment
 */
export function createRuntime(config: RuntimeConfig): Runtime {
  const { clock, hooks } = config;
  const circuitBreakerStore = config.circuitBreakerStore ?? createInMemoryCircuitBreakerStore();

  // Cache circuit breakers by function name
  const circuitBreakers = new Map<string, CircuitBreaker>();

  function getCircuitBreaker(
    fn: ServiceFunction<FunctionLayer, unknown, unknown>,
  ): CircuitBreaker | undefined {
    if (fn.policy.circuitBreaker === "none") {
      return undefined;
    }

    let cb = circuitBreakers.get(fn.name);
    if (!cb) {
      cb = createCircuitBreaker(
        fn.name,
        fn.policy.circuitBreaker,
        circuitBreakerStore,
        clock,
        (previousState, newState, failureCount) => {
          hooks?.onCircuitStateChange?.({
            functionName: fn.name,
            previousState,
            newState,
            failureCount,
            timestamp: clock.now().monoMs,
          });
        },
      );
      circuitBreakers.set(fn.name, cb);
    }
    return cb;
  }

  async function executeWithTimeout<T>(
    fn: () => Promise<T>,
    timeout: Millis | "none",
  ): Promise<Result<T, ServiceError>> {
    if (timeout === "none") {
      try {
        const result = await fn();
        return ok(result);
      } catch (error) {
        return err(ServiceError.from(error));
      }
    }

    // Create a timeout that rejects
    const timeoutPromise = clock.sleep(timeout).then(() => {
      throw ServiceError.timeout(`Operation timed out after ${timeout}ms`);
    });

    try {
      const result = await Promise.race([fn(), timeoutPromise]);
      return ok(result);
    } catch (error) {
      if (error instanceof ServiceError) {
        return err(error);
      }
      return err(ServiceError.from(error));
    }
  }

  function createExecutionMetadata(
    executionId: string,
    functionName: string,
    startedAt: number,
    attempt: number,
  ): ExecutionMetadata {
    return {
      id: executionId,
      name: functionName,
      startedAt,
      attempt,
    };
  }

  function createDataContext(
    clock: Clock,
    execution: ExecutionMetadata,
  ): DataContext {
    return {
      _layer: "data",
      clock,
      observe: createObserveContext(),
      execution,
    };
  }

  function createDomainContext(
    clock: Clock,
    execution: ExecutionMetadata,
    runtime: Runtime,
  ): DomainContext {
    return {
      _layer: "domain",
      clock,
      observe: createObserveContext(),
      execution,
      async call<TIn, TOut>(
        fn: ServiceFunction<"data", TIn, TOut>,
        input: TIn,
      ): Promise<Result<TOut, ServiceError>> {
        return runtime.execute(fn, input);
      },
    };
  }

  function createOrchestrationContext(
    clock: Clock,
    execution: ExecutionMetadata,
    runtime: Runtime,
  ): OrchestrationContext {
    return {
      _layer: "orchestration",
      clock,
      observe: createObserveContext(),
      execution,
      async call<TIn, TOut>(
        fn: ServiceFunction<"data" | "domain", TIn, TOut>,
        input: TIn,
      ): Promise<Result<TOut, ServiceError>> {
        return runtime.execute(fn, input);
      },
      emit(_event: string, _data: unknown): void {
        // TODO: Implement event emission
        throw new Error("emit() not yet implemented");
      },
      async ask<TResp>(_process: string, _message: unknown): Promise<TResp> {
        // TODO: Implement process asking
        throw new Error("ask() not yet implemented");
      },
    };
  }

  function createContext(
    fn: ServiceFunction<FunctionLayer, unknown, unknown>,
    executionId: string,
    startedAt: number,
    attempt: number,
    runtime: Runtime,
  ): DataContext | DomainContext | OrchestrationContext {
    const execution = createExecutionMetadata(executionId, fn.name, startedAt, attempt);

    switch (fn.layer) {
      case "data":
        return createDataContext(clock, execution);
      case "domain":
        return createDomainContext(clock, execution, runtime);
      case "orchestration":
        return createOrchestrationContext(clock, execution, runtime);
    }
  }

  async function executeOnce<TInput, TOutput>(
    fn: ServiceFunction<FunctionLayer, TInput, TOutput>,
    input: TInput,
    executionId: string,
    startedAt: number,
    attempt: number,
    timeout: Millis | "none",
    runtime: Runtime,
  ): Promise<Result<TOutput, ServiceError>> {
    // Validate input
    const inputResult = fn.input.safeParse(input);
    if (!inputResult.success) {
      return err(ServiceError.validation(`Invalid input: ${inputResult.error.message}`));
    }

    // Create context for this execution
    const ctx = createContext(
      fn as ServiceFunction<FunctionLayer, unknown, unknown>,
      executionId,
      startedAt,
      attempt,
      runtime,
    );

    // Execute with timeout
    const result = await executeWithTimeout(
      async () => {
        const handlerResult = await fn.handler(ctx as never, inputResult.data);
        if (isErr(handlerResult)) {
          throw handlerResult.error;
        }
        return handlerResult.value;
      },
      timeout,
    );

    if (isErr(result)) {
      return result;
    }

    // Validate output
    const outputResult = fn.output.safeParse(result.value);
    if (!outputResult.success) {
      return err(ServiceError.internal(`Invalid output: ${outputResult.error.message}`));
    }

    return ok(outputResult.data);
  }

  const runtime: Runtime = {
    async execute<TInput, TOutput>(
      fn: ServiceFunction<FunctionLayer, TInput, TOutput>,
      input: TInput,
      options?: ExecuteOptions,
    ): Promise<Result<TOutput, ServiceError>> {
      const executionId = randomUUID();
      const startedAt = clock.now().monoMs;
      const timeout = options?.timeout ?? fn.policy.timeout;

      // Emit start event
      hooks?.onStart?.({
        executionId,
        functionName: fn.name,
        layer: fn.layer,
        startedAt,
        input,
      });

      // Check circuit breaker
      const circuitBreaker = options?.skipCircuitBreaker
        ? undefined
        : getCircuitBreaker(fn as ServiceFunction<FunctionLayer, unknown, unknown>);
      if (circuitBreaker && !circuitBreaker.canExecute()) {
        const error = ServiceError.circuitOpen(`Circuit breaker open for ${fn.name}`);
        const durationMs = clock.now().monoMs - startedAt;
        hooks?.onError?.({
          executionId,
          functionName: fn.name,
          layer: fn.layer,
          durationMs,
          error,
          attempts: 0,
        });
        return err(error);
      }

      // Execute with retry logic
      const retryPolicy = options?.skipRetry ? "none" : fn.policy.retry;
      const maxAttempts = retryPolicy === "none" ? 1 : retryPolicy.attempts + 1;

      let lastError: ServiceError | undefined;
      let attempt = 1;

      while (attempt <= maxAttempts) {
        const result = await executeOnce(
          fn,
          input,
          executionId,
          startedAt,
          attempt,
          timeout,
          runtime,
        );

        if (isOk(result)) {
          // Record success with circuit breaker
          circuitBreaker?.recordSuccess();

          const durationMs = clock.now().monoMs - startedAt;
          hooks?.onSuccess?.({
            executionId,
            functionName: fn.name,
            layer: fn.layer,
            durationMs,
            output: result.value,
            attempts: attempt,
          });

          return result;
        }

        lastError = result.error;

        // Record failure with circuit breaker
        circuitBreaker?.recordFailure(lastError);

        // Check if we should retry
        if (
          retryPolicy !== "none" &&
          attempt < maxAttempts &&
          shouldRetry(retryPolicy, lastError.code, attempt - 1)
        ) {
          const delay = calculateRetryDelay(retryPolicy, attempt);

          hooks?.onRetry?.({
            executionId,
            functionName: fn.name,
            attempt,
            maxAttempts: retryPolicy.attempts,
            delayMs: delay,
            error: lastError,
          });

          // Wait before retrying
          await clock.sleep(delay as Millis);

          attempt++;
        } else {
          break;
        }
      }

      // All attempts failed
      const durationMs = clock.now().monoMs - startedAt;
      const finalError = lastError ?? ServiceError.internal("Unknown error");

      hooks?.onError?.({
        executionId,
        functionName: fn.name,
        layer: fn.layer,
        durationMs,
        error: finalError,
        attempts: attempt,
      });

      return err(finalError);
    },

    getCircuitState(functionName: string): CircuitBreakerEntry | undefined {
      return circuitBreakerStore.get(functionName);
    },

    resetCircuit(functionName: string): void {
      const cb = circuitBreakers.get(functionName);
      if (cb) {
        cb.reset();
      }
    },
  };

  return runtime;
}
