export { defineHandler, spawn } from "./handler.js";

export type {
  // Spec
  HandlerSpec,
  HandlerTools,
  ConcurrencyPolicy,
  // Running
  RunningHandler,
  HandlerStatus,
  HandlerMetrics,
  InvocationMeta,
  // Outcomes
  HandlerError,
  // Observability
  HandlerEvent,
  // Runtime
  HandlerRuntime,
} from "./types.js";

// Re-export the policy helpers so callers don't need to install retry /
// circuit-breaker packages just to declare the policies the handler expects.
export { retry } from "@phyxiusjs/retry";
export type { RetryPolicy, RetryError } from "@phyxiusjs/retry";

export { cb } from "@phyxiusjs/circuit-breaker";
export type { CircuitBreakerPolicy, CircuitState, CircuitEvent } from "@phyxiusjs/circuit-breaker";
