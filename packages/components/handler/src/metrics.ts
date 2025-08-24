import type { Atom } from "@phyxiusjs/atom";
import { createAtom } from "@phyxiusjs/atom";
import type { Clock, Instant, Millis } from "@phyxiusjs/clock";
import type { Journal } from "@phyxiusjs/journal";
import { some, none, isSome } from "@phyxiusjs/fp";
import type { HandlerMetrics, HandlerInternalState, HandlerState, HandlerEvent, CircuitBreakerState } from "./types.js";

/**
 * Performance metrics tracked over time windows.
 */
interface PerformanceWindow {
  readonly windowStartTime: Instant;
  readonly requestTimes: number[]; // Processing times in milliseconds
  readonly requestCount: number;
  readonly errorCount: number;
  readonly windowDurationMs: Millis;
}

/**
 * Memory usage snapshot.
 */
interface MemorySnapshot {
  readonly heapUsed: number;
  readonly heapTotal: number;
  readonly external: number;
  readonly capturedAt: Instant;
}

/**
 * Comprehensive metrics collector using Atom for state management.
 * Tracks performance, throughput, errors, and resource usage.
 */
export class MetricsCollector {
  private readonly internalState: Atom<HandlerInternalState>;
  private readonly performanceWindow: Atom<PerformanceWindow>;
  private readonly memoryUsage: Atom<MemorySnapshot>;
  private readonly clock: Clock;
  private readonly journal: Journal<HandlerEvent> | undefined;
  private readonly windowDurationMs: Millis;

  constructor(
    clock: Clock,
    internalState: Atom<HandlerInternalState>,
    journal?: Journal<HandlerEvent>,
    windowDurationMs: Millis = 60000 as Millis, // 1 minute default window
  ) {
    this.clock = clock;
    this.internalState = internalState;
    this.journal = journal;
    this.windowDurationMs = windowDurationMs;

    const now = clock.now();

    // Initialize performance window
    this.performanceWindow = createAtom(
      {
        windowStartTime: now,
        requestTimes: [],
        requestCount: 0,
        errorCount: 0,
        windowDurationMs: this.windowDurationMs,
      },
      clock,
    );

    // Initialize memory snapshot
    this.memoryUsage = createAtom(
      {
        heapUsed: 0,
        heapTotal: 0,
        external: 0,
        capturedAt: now,
      },
      clock,
    );

    // Start periodic memory collection
    this.startMemoryCollection();
  }

  /**
   * Record a completed request with its processing time.
   */
  recordRequest(processingTimeMs: number, success: boolean): void {
    const now = this.clock.now();

    // Update internal state
    this.internalState.swap((state) => ({
      ...state,
      totalProcessed: state.totalProcessed + 1,
      totalSucceeded: success ? state.totalSucceeded + 1 : state.totalSucceeded,
      totalFailed: success ? state.totalFailed : state.totalFailed + 1,
      lastActivityTime: now,
    }));

    // Update performance window
    this.performanceWindow.swap((window) => {
      // Check if window has expired
      const windowAge = now.monoMs - window.windowStartTime.monoMs;

      if (windowAge > window.windowDurationMs) {
        // Start new window
        return {
          windowStartTime: now,
          requestTimes: [processingTimeMs],
          requestCount: 1,
          errorCount: success ? 0 : 1,
          windowDurationMs: this.windowDurationMs,
        };
      } else {
        // Add to current window
        return {
          ...window,
          requestTimes: [...window.requestTimes, processingTimeMs],
          requestCount: window.requestCount + 1,
          errorCount: success ? window.errorCount : window.errorCount + 1,
        };
      }
    });

    // Log metrics event
    this.journal?.append({
      type: "metrics:request_recorded",
      processingTimeMs,
      success,
      totalProcessed: this.internalState.deref().totalProcessed,
      at: now,
    } as HandlerEvent);
  }

  /**
   * Record when work starts (increment active count).
   */
  recordWorkStarted(): void {
    const now = this.clock.now();

    this.internalState.swap((state) => ({
      ...state,
      activeWorkCount: state.activeWorkCount + 1,
      lastActivityTime: now,
    }));
  }

  /**
   * Record when work ends (decrement active count).
   */
  recordWorkEnded(): void {
    const now = this.clock.now();

    this.internalState.swap((state) => ({
      ...state,
      activeWorkCount: Math.max(0, state.activeWorkCount - 1),
      lastActivityTime: now,
    }));
  }

  /**
   * Update queue size.
   */
  updateQueueSize(queueSize: number): void {
    this.internalState.swap((state) => ({
      ...state,
      queuedWorkCount: queueSize,
      lastActivityTime: this.clock.now(),
    }));
  }

  /**
   * Update handler status.
   */
  updateStatus(status: HandlerState): void {
    const now = this.clock.now();

    this.internalState.swap((state) => {
      // Set start time when transitioning to running
      const newStartTime = status === "running" && state.status !== "running" ? some(now) : state.startTime;

      return {
        ...state,
        status,
        startTime: newStartTime,
        lastActivityTime: now,
      };
    });
  }

  /**
   * Generate comprehensive metrics report.
   */
  generateMetrics(circuitBreakerState?: CircuitBreakerState, queueSize?: number): HandlerMetrics {
    const state = this.internalState.deref();
    const perfWindow = this.performanceWindow.deref();
    const memory = this.memoryUsage.deref();
    const now = this.clock.now();

    // Calculate error rate (errors per second over the current window)
    const windowAgeMs = now.monoMs - perfWindow.windowStartTime.monoMs;
    const windowAgeSeconds = Math.max(windowAgeMs / 1000, 1); // Avoid division by zero
    const errorRate = perfWindow.errorCount / windowAgeSeconds;

    // Calculate throughput (requests per second)
    const throughputPerSecond = perfWindow.requestCount / windowAgeSeconds;

    // Calculate processing time statistics
    const sortedTimes = [...perfWindow.requestTimes].sort((a, b) => a - b);
    const avgProcessingTime =
      sortedTimes.length > 0 ? sortedTimes.reduce((sum, time) => sum + time, 0) / sortedTimes.length : 0;

    const p95Index = Math.floor(sortedTimes.length * 0.95);
    const p95ProcessingTime = sortedTimes.length > 0 ? sortedTimes[p95Index] || 0 : 0;

    // Calculate uptime
    const uptimeMs = isSome(state.startTime) ? now.monoMs - state.startTime.value.monoMs : 0;

    return {
      state: state.status,
      activeCount: state.activeWorkCount,
      queueSize: queueSize ?? state.queuedWorkCount,
      successCount: state.totalSucceeded,
      errorCount: state.totalFailed,
      errorRate,
      avgProcessingTimeMs: avgProcessingTime,
      circuitBreakerStatus: circuitBreakerState?.status || "closed",
      throughputPerSecond,
      p95ProcessingTimeMs: p95ProcessingTime,
      memoryUsage: {
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
        external: memory.external,
      },
      uptimeMs,
    };
  }

  /**
   * Get internal state snapshot.
   */
  getInternalState(): HandlerInternalState {
    return this.internalState.deref();
  }

  /**
   * Get performance window snapshot.
   */
  getPerformanceWindow(): PerformanceWindow {
    return this.performanceWindow.deref();
  }

  /**
   * Reset all metrics to initial state.
   */
  reset(): void {
    const now = this.clock.now();

    this.internalState.reset({
      status: "initializing",
      activeWorkCount: 0,
      queuedWorkCount: 0,
      totalProcessed: 0,
      totalSucceeded: 0,
      totalFailed: 0,
      lastActivityTime: now,
      startTime: none(),
    });

    this.performanceWindow.reset({
      windowStartTime: now,
      requestTimes: [],
      requestCount: 0,
      errorCount: 0,
      windowDurationMs: this.windowDurationMs,
    });

    this.journal?.append({
      type: "metrics:reset",
      at: now,
    } as HandlerEvent);
  }

  /**
   * Start periodic memory usage collection.
   */
  private startMemoryCollection(): void {
    // Collect memory stats every 5 seconds
    const collectInterval = 5000 as Millis;

    const collectMemory = () => {
      if (typeof process !== "undefined" && process.memoryUsage) {
        const usage = process.memoryUsage();
        const now = this.clock.now();

        this.memoryUsage.swap(() => ({
          heapUsed: usage.heapUsed,
          heapTotal: usage.heapTotal,
          external: usage.external,
          capturedAt: now,
        }));
      }

      // Schedule next collection
      this.clock.timeout(collectInterval).then(collectMemory);
    };

    // Start first collection
    this.clock.timeout(1000 as Millis).then(collectMemory);
  }

  /**
   * Create a metrics snapshot for serialization.
   */
  createSnapshot() {
    const state = this.internalState.deref();
    const perfWindow = this.performanceWindow.deref();
    const memory = this.memoryUsage.deref();

    return {
      internalState: state,
      performanceWindow: perfWindow,
      memoryUsage: memory,
      capturedAt: this.clock.now(),
    };
  }

  /**
   * Export metrics data for external monitoring systems.
   */
  exportForMonitoring(): Record<string, number | string> {
    const metrics = this.generateMetrics();

    return {
      // Basic metrics
      "handler.state": metrics.state,
      "handler.active_count": metrics.activeCount,
      "handler.queue_size": metrics.queueSize,

      // Performance metrics
      "handler.success_count": metrics.successCount,
      "handler.error_count": metrics.errorCount,
      "handler.error_rate": metrics.errorRate,
      "handler.throughput_per_second": metrics.throughputPerSecond,

      // Timing metrics
      "handler.avg_processing_time_ms": metrics.avgProcessingTimeMs,
      "handler.p95_processing_time_ms": metrics.p95ProcessingTimeMs,
      "handler.uptime_ms": metrics.uptimeMs,

      // Circuit breaker
      "handler.circuit_breaker_status": metrics.circuitBreakerStatus,

      // Memory metrics
      "handler.memory.heap_used": metrics.memoryUsage.heapUsed,
      "handler.memory.heap_total": metrics.memoryUsage.heapTotal,
      "handler.memory.external": metrics.memoryUsage.external,
    };
  }
}

/**
 * Create a new metrics collector instance.
 */
export function createMetricsCollector(
  clock: Clock,
  internalState: Atom<HandlerInternalState>,
  journal?: Journal<HandlerEvent>,
  windowDurationMs?: Millis,
): MetricsCollector {
  return new MetricsCollector(clock, internalState, journal, windowDurationMs);
}
