export type {
  WorkUnit,
  WorkResult,
  ProcessorFn,
  Adapter,
  HandlerConfig,
  CircuitBreakerConfig,
  BackpressureConfig,
  HandlerState,
  HandlerMetrics,
  HandlerEvent,
  EmitFn,
  HandlerOptions,
  Handler,
  HandlerMessage,
  HandlerErrorCode,
  AdapterErrorCode,
} from "./types.js";

export { HandlerError, AdapterError, DEFAULT_HANDLER_CONFIG } from "./types.js";

export { createHandler, HandlerImpl } from "./handler.js";
export {
  generateCorrelationId,
  generateHandlerId,
  promiseToEffect,
  delay,
  safeJsonParse,
  safeJsonStringify,
  raceEffects,
  allEffects,
} from "./utils.js";

// Adapters
export { HttpAdapter, createHttpAdapter } from "./adapters/http.js";
export type { HttpRequest, HttpResponse } from "./adapters/http.js";
