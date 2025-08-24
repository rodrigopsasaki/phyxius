import type { Atom } from "@phyxiusjs/atom";
import { createAtom } from "@phyxiusjs/atom";
import type { Clock, Instant } from "@phyxiusjs/clock";
import type { Effect } from "@phyxiusjs/effect";
import type { Result } from "@phyxiusjs/fp";
import { ok, err, some, none, isErr, isSome, unwrapOption } from "@phyxiusjs/fp";
import { effect } from "@phyxiusjs/effect";
import type { CircuitBreakerConfig, CircuitBreakerState, HandlerError } from "./types.js";

/**
 * Circuit breaker implementation using Atom for state management.
 * Provides fault tolerance by preventing calls to failing services.
 */
export class CircuitBreaker {
  private readonly state: Atom<CircuitBreakerState>;
  private readonly config: CircuitBreakerConfig;
  private readonly clock: Clock;

  constructor(config: CircuitBreakerConfig, clock: Clock, initialState?: CircuitBreakerState) {
    this.config = config;
    this.clock = clock;

    // Initialize state atom
    const defaultState: CircuitBreakerState = initialState || {
      status: "closed",
      failureCount: 0,
      successCount: 0,
      lastFailureTime: none(),
      windowStartTime: clock.now(),
    };

    // Create the atom to manage circuit breaker state
    this.state = createAtom(defaultState, clock);
  }

  /**
   * Execute an operation through the circuit breaker.
   * Returns a Result indicating whether the operation should proceed.
   */
  execute<T>(operation: () => Effect<HandlerError, T>): Effect<HandlerError, T> {
    return effect(async (env) => {
      // Check if circuit allows execution
      const canExecute = this.canExecute();
      if (isErr(canExecute)) {
        return { _tag: "Err", error: canExecute.error };
      }

      const startTime = this.clock.now();

      try {
        // Execute the operation
        const result = await operation().unsafeRunPromise(env);

        if (result._tag === "Ok") {
          // Record success
          this.onSuccess();
          return result;
        } else {
          // Record failure
          this.onFailure(startTime);
          return result;
        }
      } catch (error) {
        // Record failure for any uncaught errors
        this.onFailure(startTime);
        throw error;
      }
    });
  }

  /**
   * Check if the circuit breaker allows execution.
   */
  private canExecute(): Result<void, HandlerError> {
    const currentState = this.state.deref();
    const now = this.clock.now();

    switch (currentState.status) {
      case "closed":
        return ok(undefined);

      case "open":
        // Check if cooldown period has passed
        if (isSome(currentState.lastFailureTime)) {
          const timeSinceFailure = now.monoMs - unwrapOption(currentState.lastFailureTime).monoMs;
          if (timeSinceFailure >= this.config.cooldownMs) {
            // Move to half-open state
            this.state.swap((state) => ({
              ...state,
              status: "half-open",
            }));
            return ok(undefined);
          }
        }

        return err({
          name: "HandlerError",
          message: "Circuit breaker is open",
          code: "CIRCUIT_OPEN" as const,
        } as HandlerError);

      case "half-open":
        return ok(undefined);

      default:
        return ok(undefined);
    }
  }

  /**
   * Record a successful operation.
   */
  private onSuccess(): void {
    this.state.swap((state) => {
      const now = this.clock.now();

      if (state.status === "half-open") {
        // Close the circuit after successful execution in half-open state
        return {
          status: "closed",
          failureCount: 0,
          successCount: 0,
          lastFailureTime: none(),
          windowStartTime: now,
        };
      } else {
        // Increment success count
        return {
          ...state,
          successCount: state.successCount + 1,
        };
      }
    });
  }

  /**
   * Record a failed operation.
   */
  private onFailure(failureTime: Instant): void {
    this.state.swap((state) => {
      const now = this.clock.now();
      const windowElapsed = now.monoMs - state.windowStartTime.monoMs;

      let newState = state;

      // Reset window if it has expired
      if (windowElapsed > this.config.windowMs) {
        newState = {
          ...state,
          failureCount: 0,
          successCount: 0,
          windowStartTime: now,
        };
      }

      // Increment failure count
      const updatedFailureCount = newState.failureCount + 1;
      const totalRequests = updatedFailureCount + newState.successCount;

      // Check if we should open the circuit
      const shouldOpen =
        totalRequests >= this.config.minimumRequests && updatedFailureCount >= this.config.failureThreshold;

      return {
        ...newState,
        failureCount: updatedFailureCount,
        lastFailureTime: some(failureTime),
        status: shouldOpen ? "open" : newState.status,
      };
    });
  }

  /**
   * Get the current state of the circuit breaker.
   */
  getState(): CircuitBreakerState {
    return this.state.deref();
  }

  /**
   * Get circuit breaker metrics.
   */
  getMetrics() {
    const state = this.state.deref();
    const now = this.clock.now();
    const windowElapsed = now.monoMs - state.windowStartTime.monoMs;
    const totalRequests = state.failureCount + state.successCount;

    return {
      status: state.status,
      failureCount: state.failureCount,
      successCount: state.successCount,
      totalRequests,
      failureRate: totalRequests > 0 ? state.failureCount / totalRequests : 0,
      windowElapsedMs: windowElapsed,
      windowRemainingMs: Math.max(0, this.config.windowMs - windowElapsed),
      isWindowExpired: windowElapsed > this.config.windowMs,
    };
  }

  /**
   * Force the circuit breaker to a specific state (for testing).
   */
  forceState(newState: CircuitBreakerState): void {
    this.state.reset(newState);
  }

  /**
   * Reset the circuit breaker to its initial closed state.
   */
  reset(): void {
    const now = this.clock.now();
    this.state.reset({
      status: "closed",
      failureCount: 0,
      successCount: 0,
      lastFailureTime: none(),
      windowStartTime: now,
    });
  }
}

/**
 * Create a new circuit breaker instance.
 */
export function createCircuitBreaker(
  config: CircuitBreakerConfig,
  clock: Clock,
  initialState?: CircuitBreakerState,
): CircuitBreaker {
  return new CircuitBreaker(config, clock, initialState);
}
