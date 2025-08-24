import type { Atom } from "@phyxiusjs/atom";
import { createAtom } from "@phyxiusjs/atom";
import type { Clock, Instant } from "@phyxiusjs/clock";
import type { Journal } from "@phyxiusjs/journal";
import type { Result, Option } from "@phyxiusjs/fp";
import { ok, err, some, none, head, tail, unwrapOption, isSome } from "@phyxiusjs/fp";
import type { BackpressureConfig, HandlerError, HandlerEvent } from "./types.js";

/**
 * Queue item with metadata for backpressure management.
 */
interface QueueItem<T> {
  readonly item: T;
  readonly enqueuedAt: Instant;
  readonly priority: number | undefined;
}

/**
 * Queue state tracked in an Atom.
 */
interface QueueState<T> {
  readonly items: QueueItem<T>[];
  readonly totalEnqueued: number;
  readonly totalDequeued: number;
  readonly totalDropped: number;
  readonly lastActivity: Instant;
}

/**
 * Backpressure implementation using Atom for queue management.
 * Provides flow control with configurable overflow strategies.
 */
export class BackpressureQueue<T> {
  private readonly state: Atom<QueueState<T>>;
  private readonly config: BackpressureConfig;
  private readonly clock: Clock;
  private readonly journal: Journal<HandlerEvent> | undefined;

  constructor(config: BackpressureConfig, clock: Clock, journal?: Journal<HandlerEvent>) {
    this.config = config;
    this.clock = clock;
    this.journal = journal;

    // Initialize queue state atom
    const initialState: QueueState<T> = {
      items: [],
      totalEnqueued: 0,
      totalDequeued: 0,
      totalDropped: 0,
      lastActivity: clock.now(),
    };

    this.state = createAtom(initialState, clock);
  }

  /**
   * Attempt to enqueue an item with backpressure control.
   */
  enqueue(item: T, priority?: number): Result<void, HandlerError> {
    const now = this.clock.now();
    const currentState = this.state.deref();

    // Check if queue is full
    if (currentState.items.length >= this.config.maxQueueSize) {
      return this.handleOverflow(item, priority, now);
    }

    // Enqueue the item
    const queueItem: QueueItem<T> = {
      item,
      enqueuedAt: now,
      priority,
    };

    this.state.swap((state) => ({
      ...state,
      items: [...state.items, queueItem],
      totalEnqueued: state.totalEnqueued + 1,
      lastActivity: now,
    }));

    // Log enqueue event
    this.journal?.append({
      type: "queue:enqueued",
      queueSize: currentState.items.length + 1,
      totalEnqueued: currentState.totalEnqueued + 1,
      at: now,
    } as HandlerEvent);

    return ok(undefined);
  }

  /**
   * Dequeue the next item from the queue.
   */
  dequeue(): Option<T> {
    const now = this.clock.now();
    let dequeuedItem: Option<T> = none();

    this.state.swap((state) => {
      if (state.items.length === 0) {
        return state;
      }

      // Sort by priority if priority is specified, otherwise FIFO
      const sortedItems = [...state.items].sort((a, b) => {
        if (a.priority !== undefined && b.priority !== undefined) {
          return b.priority - a.priority; // Higher priority first
        }
        if (a.priority !== undefined) return -1;
        if (b.priority !== undefined) return 1;
        return 0; // FIFO for items with same/no priority
      });

      const firstItem = head(sortedItems);
      const restItems = tail(sortedItems);

      if (isSome(firstItem)) {
        const first = unwrapOption(firstItem);
        const rest = isSome(restItems) ? unwrapOption(restItems) : [];
        dequeuedItem = some(first.item);

        // Log dequeue event
        this.journal?.append({
          type: "queue:dequeued",
          queueSize: rest.length,
          totalDequeued: state.totalDequeued + 1,
          waitTimeMs: now.monoMs - first.enqueuedAt.monoMs,
          at: now,
        } as HandlerEvent);

        return {
          ...state,
          items: rest as QueueItem<T>[],
          totalDequeued: state.totalDequeued + 1,
          lastActivity: now,
        };
      } else {
        dequeuedItem = none();
        return {
          ...state,
          items: [],
          totalDequeued: state.totalDequeued,
          lastActivity: now,
        };
      }
    });

    return dequeuedItem;
  }

  /**
   * Handle queue overflow based on the configured strategy.
   */
  private handleOverflow(newItem: T, priority: number | undefined, now: Instant): Result<void, HandlerError> {
    switch (this.config.overflowStrategy) {
      case "reject":
        this.journal?.append({
          type: "backpressure:triggered",
          queueSize: this.config.maxQueueSize,
          strategy: "reject",
          at: now,
        } as HandlerEvent);

        return err({
          name: "HandlerError",
          message: `Queue full: maximum size (${this.config.maxQueueSize}) reached`,
          code: "BACKPRESSURE" as const,
        } as HandlerError);

      case "drop-oldest":
        return this.dropOldestAndEnqueue(newItem, priority, now);

      case "drop-newest":
        // Drop the new item (essentially same as reject, but different semantics)
        this.state.swap((state) => ({
          ...state,
          totalDropped: state.totalDropped + 1,
          lastActivity: now,
        }));

        this.journal?.append({
          type: "backpressure:triggered",
          queueSize: this.config.maxQueueSize,
          strategy: "drop-newest",
          at: now,
        } as HandlerEvent);

        return ok(undefined); // Successfully "handled" by dropping

      default:
        return err({
          name: "HandlerError",
          message: "Unknown overflow strategy",
          code: "PROCESSOR_ERROR" as const,
        } as HandlerError);
    }
  }

  /**
   * Drop the oldest item and enqueue the new one.
   */
  private dropOldestAndEnqueue(newItem: T, priority: number | undefined, now: Instant): Result<void, HandlerError> {
    const queueItem: QueueItem<T> = {
      item: newItem,
      enqueuedAt: now,
      priority,
    };

    this.state.swap((state) => {
      const [, ...remaining] = state.items; // Drop first (oldest) item

      return {
        ...state,
        items: [...remaining, queueItem],
        totalEnqueued: state.totalEnqueued + 1,
        totalDropped: state.totalDropped + 1,
        lastActivity: now,
      };
    });

    this.journal?.append({
      type: "backpressure:triggered",
      queueSize: this.config.maxQueueSize,
      strategy: "drop-oldest",
      at: now,
    } as HandlerEvent);

    return ok(undefined);
  }

  /**
   * Get current queue metrics.
   */
  getMetrics() {
    const state = this.state.deref();
    const now = this.clock.now();

    // Calculate wait times
    const waitTimes = state.items.map((item) => now.monoMs - item.enqueuedAt.monoMs);
    const avgWaitTime = waitTimes.length > 0 ? waitTimes.reduce((sum, time) => sum + time, 0) / waitTimes.length : 0;
    const maxWaitTime = waitTimes.length > 0 ? Math.max(...waitTimes) : 0;

    return {
      currentSize: state.items.length,
      maxSize: this.config.maxQueueSize,
      utilizationPercent: (state.items.length / this.config.maxQueueSize) * 100,
      totalEnqueued: state.totalEnqueued,
      totalDequeued: state.totalDequeued,
      totalDropped: state.totalDropped,
      throughput: state.totalDequeued, // Could be refined with time window
      avgWaitTimeMs: avgWaitTime,
      maxWaitTimeMs: maxWaitTime,
      lastActivity: state.lastActivity,
      overflowStrategy: this.config.overflowStrategy,
    };
  }

  /**
   * Check if the queue is full.
   */
  isFull(): boolean {
    return this.state.deref().items.length >= this.config.maxQueueSize;
  }

  /**
   * Check if the queue is empty.
   */
  isEmpty(): boolean {
    return this.state.deref().items.length === 0;
  }

  /**
   * Get current queue size.
   */
  size(): number {
    return this.state.deref().items.length;
  }

  /**
   * Clear all items from the queue.
   */
  clear(): number {
    let clearedCount = 0;
    const now = this.clock.now();

    this.state.swap((state) => {
      clearedCount = state.items.length;

      this.journal?.append({
        type: "queue:cleared",
        clearedCount,
        at: now,
      } as HandlerEvent);

      return {
        ...state,
        items: [],
        lastActivity: now,
      };
    });

    return clearedCount;
  }

  /**
   * Peek at the next item without dequeuing it.
   */
  peek(): Option<T> {
    const state = this.state.deref();

    if (state.items.length === 0) {
      return none();
    }

    // Sort by priority to get the next item that would be dequeued
    const sortedItems = [...state.items].sort((a, b) => {
      if (a.priority !== undefined && b.priority !== undefined) {
        return b.priority - a.priority;
      }
      if (a.priority !== undefined) return -1;
      if (b.priority !== undefined) return 1;
      return 0;
    });

    const firstItem = head(sortedItems);
    return isSome(firstItem) ? some(unwrapOption(firstItem).item) : none();
  }

  /**
   * Get a snapshot of all items currently in the queue.
   */
  snapshot(): T[] {
    return this.state.deref().items.map((queueItem) => queueItem.item);
  }
}

/**
 * Create a new backpressure queue instance.
 */
export function createBackpressureQueue<T>(
  config: BackpressureConfig,
  clock: Clock,
  journal?: Journal<HandlerEvent>,
): BackpressureQueue<T> {
  return new BackpressureQueue(config, clock, journal);
}
