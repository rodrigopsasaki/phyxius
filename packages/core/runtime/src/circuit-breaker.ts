import type { Clock } from "@phyxiusjs/clock";
import type { CircuitBreakerPolicy, ServiceError } from "@phyxiusjs/service";
import type { CircuitBreakerStore, CircuitBreakerEntry, CircuitState } from "./types.js";

/**
 * Create an in-memory circuit breaker store
 */
export function createInMemoryCircuitBreakerStore(): CircuitBreakerStore {
  const store = new Map<string, CircuitBreakerEntry>();

  return {
    get(functionName: string): CircuitBreakerEntry | undefined {
      return store.get(functionName);
    },
    set(functionName: string, entry: CircuitBreakerEntry): void {
      store.set(functionName, entry);
    },
  };
}

/**
 * Circuit breaker logic for a function
 */
export interface CircuitBreaker {
  /** Check if the circuit allows execution */
  canExecute(): boolean;
  /** Record a successful execution */
  recordSuccess(): void;
  /** Record a failed execution */
  recordFailure(error: ServiceError): void;
  /** Get current state */
  getState(): CircuitBreakerEntry;
  /** Reset the circuit breaker */
  reset(): void;
}

/**
 * Create a circuit breaker for a function
 */
export function createCircuitBreaker(
  functionName: string,
  policy: CircuitBreakerPolicy,
  store: CircuitBreakerStore,
  clock: Clock,
  onStateChange?: (previousState: CircuitState, newState: CircuitState, failureCount: number) => void,
): CircuitBreaker {
  function getEntry(): CircuitBreakerEntry {
    return store.get(functionName) ?? { state: "closed", failureCount: 0 };
  }

  function setEntry(entry: CircuitBreakerEntry): void {
    store.set(functionName, entry);
  }

  function setState(newState: CircuitState, failureCount: number, extras: Partial<CircuitBreakerEntry> = {}): void {
    const current = getEntry();
    if (current.state !== newState && onStateChange) {
      onStateChange(current.state, newState, failureCount);
    }
    setEntry({
      state: newState,
      failureCount,
      ...extras,
    });
  }

  return {
    canExecute(): boolean {
      const entry = getEntry();
      const now = clock.now().monoMs;

      switch (entry.state) {
        case "closed":
          return true;

        case "open": {
          // Check if reset period has elapsed
          if (entry.openedAt !== undefined) {
            const elapsed = now - entry.openedAt;
            if (elapsed >= policy.resetAfter) {
              // Transition to half-open
              setState("half-open", entry.failureCount);
              return true;
            }
          }
          return false;
        }

        case "half-open":
          // Allow one request through to test
          return true;
      }
    },

    recordSuccess(): void {
      const entry = getEntry();

      switch (entry.state) {
        case "half-open":
          // Success in half-open closes the circuit
          setState("closed", 0);
          break;

        case "closed":
          // Reset failure count on success
          if (entry.failureCount > 0) {
            setState("closed", 0);
          }
          break;

        case "open":
          // Should not happen, but handle gracefully
          break;
      }
    },

    recordFailure(error: ServiceError): void {
      const entry = getEntry();
      const now = clock.now().monoMs;

      // Only count retryable errors for circuit breaker
      if (!error.isRetryable()) {
        return;
      }

      switch (entry.state) {
        case "closed": {
          const newFailureCount = entry.failureCount + 1;
          if (newFailureCount >= policy.threshold) {
            // Open the circuit
            setState("open", newFailureCount, {
              openedAt: now,
              lastFailureAt: now,
            });
          } else {
            setState("closed", newFailureCount, { lastFailureAt: now });
          }
          break;
        }

        case "half-open":
          // Failure in half-open re-opens the circuit
          setState("open", entry.failureCount + 1, {
            openedAt: now,
            lastFailureAt: now,
          });
          break;

        case "open":
          // Already open, just update timestamp
          setEntry({
            ...entry,
            lastFailureAt: now,
          });
          break;
      }
    },

    getState(): CircuitBreakerEntry {
      return getEntry();
    },

    reset(): void {
      setState("closed", 0);
    },
  };
}
