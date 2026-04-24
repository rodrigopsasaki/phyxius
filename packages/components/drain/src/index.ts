// Core
export { createDrain } from "./drain.js";
export type {
  Drain,
  DrainEntry,
  DrainOptions,
  DrainEvent,
  Sink,
  OtlpHttpSinkOptions,
  FileSinkOptions,
} from "./types.js";

// Sinks
export { stdoutSink } from "./sinks/stdout.js";
export { otlpHttpSink } from "./sinks/otlp-http.js";
export { fileSink } from "./sinks/file.js";
export { compositeSink } from "./sinks/composite.js";
