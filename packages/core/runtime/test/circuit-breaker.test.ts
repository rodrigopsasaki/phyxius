import { describe, it, expect, vi, beforeEach } from "vitest";
import { createControlledClock, ms } from "@phyxiusjs/clock";
import { ServiceError } from "@phyxiusjs/service";
import {
  createCircuitBreaker,
  createInMemoryCircuitBreakerStore,
} from "../src/circuit-breaker.js";

describe("createInMemoryCircuitBreakerStore", () => {
  it("should return undefined for unknown function", () => {
    const store = createInMemoryCircuitBreakerStore();
    expect(store.get("unknown")).toBeUndefined();
  });

  it("should store and retrieve entries", () => {
    const store = createInMemoryCircuitBreakerStore();
    const entry = { state: "closed" as const, failureCount: 0 };

    store.set("test-fn", entry);

    expect(store.get("test-fn")).toEqual(entry);
  });
});

describe("createCircuitBreaker", () => {
  let clock: ReturnType<typeof createControlledClock>;
  let store: ReturnType<typeof createInMemoryCircuitBreakerStore>;

  const policy = {
    threshold: 3,
    resetAfter: 30000, // 30 seconds
  };

  beforeEach(() => {
    clock = createControlledClock({ initialTime: 1000000 });
    store = createInMemoryCircuitBreakerStore();
  });

  describe("closed state", () => {
    it("should allow execution when closed", () => {
      const cb = createCircuitBreaker("test-fn", policy, store, clock);

      expect(cb.canExecute()).toBe(true);
    });

    it("should remain closed after success", () => {
      const cb = createCircuitBreaker("test-fn", policy, store, clock);
      cb.recordSuccess();

      expect(cb.getState().state).toBe("closed");
      expect(cb.canExecute()).toBe(true);
    });

    it("should increment failure count on retryable error", () => {
      const cb = createCircuitBreaker("test-fn", policy, store, clock);
      const error = ServiceError.timeout("Test timeout");

      cb.recordFailure(error);

      expect(cb.getState().failureCount).toBe(1);
      expect(cb.getState().state).toBe("closed");
    });

    it("should not count non-retryable errors", () => {
      const cb = createCircuitBreaker("test-fn", policy, store, clock);
      const error = ServiceError.notFound("Resource", "123");

      cb.recordFailure(error);

      expect(cb.getState().failureCount).toBe(0);
    });

    it("should open circuit after threshold failures", () => {
      const cb = createCircuitBreaker("test-fn", policy, store, clock);
      const error = ServiceError.timeout("Test timeout");

      cb.recordFailure(error);
      cb.recordFailure(error);
      cb.recordFailure(error);

      expect(cb.getState().state).toBe("open");
      expect(cb.canExecute()).toBe(false);
    });

    it("should reset failure count on success", () => {
      const cb = createCircuitBreaker("test-fn", policy, store, clock);
      const error = ServiceError.timeout("Test timeout");

      cb.recordFailure(error);
      cb.recordFailure(error);
      cb.recordSuccess();

      expect(cb.getState().failureCount).toBe(0);
    });
  });

  describe("open state", () => {
    it("should not allow execution when open", () => {
      const cb = createCircuitBreaker("test-fn", policy, store, clock);
      const error = ServiceError.timeout("Test timeout");

      // Trip the circuit
      cb.recordFailure(error);
      cb.recordFailure(error);
      cb.recordFailure(error);

      expect(cb.canExecute()).toBe(false);
    });

    it("should transition to half-open after reset period", () => {
      const cb = createCircuitBreaker("test-fn", policy, store, clock);
      const error = ServiceError.timeout("Test timeout");

      // Trip the circuit
      cb.recordFailure(error);
      cb.recordFailure(error);
      cb.recordFailure(error);

      expect(cb.getState().state).toBe("open");

      // Advance time past reset period
      clock.advanceBy(ms(30001));

      expect(cb.canExecute()).toBe(true);
      expect(cb.getState().state).toBe("half-open");
    });
  });

  describe("half-open state", () => {
    it("should close circuit on success", () => {
      const cb = createCircuitBreaker("test-fn", policy, store, clock);
      const error = ServiceError.timeout("Test timeout");

      // Trip the circuit
      cb.recordFailure(error);
      cb.recordFailure(error);
      cb.recordFailure(error);

      // Move to half-open
      clock.advanceBy(ms(30001));
      cb.canExecute(); // This transitions to half-open

      // Record success
      cb.recordSuccess();

      expect(cb.getState().state).toBe("closed");
      expect(cb.getState().failureCount).toBe(0);
    });

    it("should re-open circuit on failure", () => {
      const cb = createCircuitBreaker("test-fn", policy, store, clock);
      const error = ServiceError.timeout("Test timeout");

      // Trip the circuit
      cb.recordFailure(error);
      cb.recordFailure(error);
      cb.recordFailure(error);

      // Move to half-open
      clock.advanceBy(ms(30001));
      cb.canExecute(); // This transitions to half-open

      // Record failure
      cb.recordFailure(error);

      expect(cb.getState().state).toBe("open");
    });
  });

  describe("state change callback", () => {
    it("should call callback on state change", () => {
      const onStateChange = vi.fn();
      const cb = createCircuitBreaker("test-fn", policy, store, clock, onStateChange);
      const error = ServiceError.timeout("Test timeout");

      // Trip the circuit
      cb.recordFailure(error);
      cb.recordFailure(error);
      cb.recordFailure(error);

      expect(onStateChange).toHaveBeenCalledWith("closed", "open", 3);
    });

    it("should not call callback when state unchanged", () => {
      const onStateChange = vi.fn();
      const cb = createCircuitBreaker("test-fn", policy, store, clock, onStateChange);
      const error = ServiceError.timeout("Test timeout");

      cb.recordFailure(error);

      expect(onStateChange).not.toHaveBeenCalled();
    });
  });

  describe("reset", () => {
    it("should reset circuit to closed state", () => {
      const cb = createCircuitBreaker("test-fn", policy, store, clock);
      const error = ServiceError.timeout("Test timeout");

      // Trip the circuit
      cb.recordFailure(error);
      cb.recordFailure(error);
      cb.recordFailure(error);

      expect(cb.getState().state).toBe("open");

      cb.reset();

      expect(cb.getState().state).toBe("closed");
      expect(cb.getState().failureCount).toBe(0);
    });
  });
});
