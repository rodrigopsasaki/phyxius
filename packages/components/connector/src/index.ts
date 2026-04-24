// Primitive
export { defineConnector } from "./define.js";

// Types + runtime-tagged envelope
export { ConnectorFailure, isConnectorFailure, type ConnectorError, type ConnectorSpec } from "./types.js";

// HTTP deepdive — the curated translation table every HTTP-shaped
// connector composes onto.
export { mapHttpStatus, mapFetchError, parseRetryAfter, type HttpErrorContext } from "./http.js";
