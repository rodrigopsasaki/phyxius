export { createQueueConsumer } from "./consumer.js";
export { defaultOnResult } from "./encode.js";
export { createMemorySource } from "./memory-source.js";

export type {
  MessageSource,
  NackReason,
  QueueConsumer,
  QueueConsumerEvent,
  QueueConsumerOptions,
  QueueConsumerStatus,
  QueueMessage,
  QueueOutcome,
} from "./types.js";

export type { MemoryQueue, MemorySourceOptions } from "./memory-source.js";
