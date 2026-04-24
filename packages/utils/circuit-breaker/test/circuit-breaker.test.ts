import { describe, it, expect } from "vitest";
import { createControlledClock, ms } from "@phyxiusjs/clock";
import { isOk, isErr } from "@phyxiusjs/fp";
import { cb, createCircuitBreaker, type CircuitEvent } from "../src/index.js";

describe("@phyxiusjs/circuit-breaker", () => {
  describe("cb.none (disabled)", () => {
    it("should let everything through", async () => {
      const clock = createControlledClock();
      const breaker = createCircuitBreaker({ policy: cb.none(), clock });

      const result = await breaker.execute(async () => 42);
      expect(isOk(result)).toBe(true);
      if (isOk(result)) expect(result.value).toBe(42);

      // State never opens regardless of failures.
      for (let i = 0; i < 10; i++) {
        await breaker
          .execute(async () => {
            throw new Error("fail");
          })
          .catch(() => {});
      }

      expect(breaker.snapshot().state).toBe("closed");
    });
  });

  describe("cb.policy validation", () => {
    it("should reject failureThreshold < 1", () => {
      expect(() => cb.policy({ failureThreshold: 0, resetTimeout: ms(100) })).toThrow(/failureThreshold/);
    });
  });

  describe("closed → open transition", () => {
    it("should open after failureThreshold consecutive failures", async () => {
      const clock = createControlledClock();
      const breaker = createCircuitBreaker({
        policy: cb.policy({ failureThreshold: 3, resetTimeout: ms(1000) }),
        clock,
      });

      const failing = async () => {
        throw new Error("fail");
      };

      // First two failures keep the circuit closed.
      await breaker.execute(failing).catch(() => {});
      expect(breaker.snapshot().state).toBe("closed");

      await breaker.execute(failing).catch(() => {});
      expect(breaker.snapshot().state).toBe("closed");

      // Third failure opens it.
      await breaker.execute(failing).catch(() => {});
      expect(breaker.snapshot().state).toBe("open");
      expect(breaker.snapshot().consecutiveFailures).toBe(3);
    });

    it("should reset the failure counter on a success", async () => {
      const clock = createControlledClock();
      const breaker = createCircuitBreaker({
        policy: cb.policy({ failureThreshold: 3, resetTimeout: ms(1000) }),
        clock,
      });

      const failing = async () => {
        throw new Error("fail");
      };

      await breaker.execute(failing).catch(() => {});
      await breaker.execute(failing).catch(() => {});
      expect(breaker.snapshot().consecutiveFailures).toBe(2);

      // A success resets the counter.
      await breaker.execute(async () => "ok");
      expect(breaker.snapshot().consecutiveFailures).toBe(0);
      expect(breaker.snapshot().state).toBe("closed");

      // Starting fresh — need three more to open.
      await breaker.execute(failing).catch(() => {});
      await breaker.execute(failing).catch(() => {});
      expect(breaker.snapshot().state).toBe("closed");
    });
  });

  describe("open state", () => {
    it("should short-circuit with CIRCUIT_OPEN", async () => {
      const clock = createControlledClock({ initialTime: 1000 });
      const breaker = createCircuitBreaker({
        policy: cb.policy({ failureThreshold: 1, resetTimeout: ms(5000) }),
        clock,
      });

      await breaker
        .execute(async () => {
          throw new Error("fail");
        })
        .catch(() => {});

      expect(breaker.snapshot().state).toBe("open");

      // Next call short-circuits.
      const called = { yes: false };
      const result = await breaker.execute(async () => {
        called.yes = true;
        return "should-not-run";
      });

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.type).toBe("CIRCUIT_OPEN");
        expect(result.error.willRetryAfter).toBeGreaterThan(result.error.openedAt);
      }
      expect(called.yes).toBe(false);
    });
  });

  describe("open → half-open → closed", () => {
    it("should transition open → half-open when resetTimeout elapses", async () => {
      const clock = createControlledClock({ initialTime: 0 });
      const breaker = createCircuitBreaker({
        policy: cb.policy({ failureThreshold: 1, resetTimeout: ms(500) }),
        clock,
      });

      await breaker
        .execute(async () => {
          throw new Error("fail");
        })
        .catch(() => {});

      expect(breaker.snapshot().state).toBe("open");

      // Not enough time has passed — still short-circuits.
      clock.advanceBy(ms(400));
      const blocked = await breaker.execute(async () => "x");
      expect(isErr(blocked)).toBe(true);

      // Enough time — probe allowed.
      clock.advanceBy(ms(200)); // total: 600ms, past resetTimeout
      const probed = await breaker.execute(async () => "probe-succeeded");
      expect(isOk(probed)).toBe(true);
      if (isOk(probed)) expect(probed.value).toBe("probe-succeeded");

      // Successful probe closes the circuit.
      expect(breaker.snapshot().state).toBe("closed");
    });

    it("should reopen immediately if the probe call fails in half-open", async () => {
      const clock = createControlledClock({ initialTime: 0 });
      const breaker = createCircuitBreaker({
        policy: cb.policy({ failureThreshold: 1, resetTimeout: ms(500) }),
        clock,
      });

      await breaker
        .execute(async () => {
          throw new Error("initial fail");
        })
        .catch(() => {});

      clock.advanceBy(ms(500));

      // Probe fails — reopens.
      await breaker
        .execute(async () => {
          throw new Error("probe also fails");
        })
        .catch(() => {});

      expect(breaker.snapshot().state).toBe("open");
    });
  });

  describe("events", () => {
    it("should emit state transition events", async () => {
      const clock = createControlledClock({ initialTime: 0 });
      const breaker = createCircuitBreaker({
        policy: cb.policy({ failureThreshold: 2, resetTimeout: ms(100) }),
        clock,
      });

      const events: CircuitEvent[] = [];
      breaker.watch((e) => events.push(e));

      // Open it.
      await breaker
        .execute(async () => {
          throw new Error("fail");
        })
        .catch(() => {});
      await breaker
        .execute(async () => {
          throw new Error("fail");
        })
        .catch(() => {});

      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("circuit:opened");

      // Wait, probe, close.
      clock.advanceBy(ms(100));
      await breaker.execute(async () => "success");

      const types = events.map((e) => e.type);
      expect(types).toContain("circuit:opened");
      expect(types).toContain("circuit:half-open");
      expect(types).toContain("circuit:closed");
    });

    it("should support unsubscribe", async () => {
      const clock = createControlledClock();
      const breaker = createCircuitBreaker({
        policy: cb.policy({ failureThreshold: 1, resetTimeout: ms(100) }),
        clock,
      });

      const events: CircuitEvent[] = [];
      const unsubscribe = breaker.watch((e) => events.push(e));

      await breaker
        .execute(async () => {
          throw new Error("fail");
        })
        .catch(() => {});
      expect(events).toHaveLength(1);

      unsubscribe();

      clock.advanceBy(ms(100));
      await breaker.execute(async () => "ok");

      // No further events after unsubscribe.
      expect(events).toHaveLength(1);
    });
  });

  describe("underlying errors propagate", () => {
    it("should rethrow the function's error while still tracking state", async () => {
      const clock = createControlledClock();
      const breaker = createCircuitBreaker({
        policy: cb.policy({ failureThreshold: 3, resetTimeout: ms(100) }),
        clock,
      });

      await expect(
        breaker.execute(async () => {
          throw new Error("underlying");
        }),
      ).rejects.toThrow("underlying");

      expect(breaker.snapshot().consecutiveFailures).toBe(1);
    });
  });
});
