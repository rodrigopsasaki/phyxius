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
        // Durations relative to the refusal, never instants. Inside the
        // window neither clamps, so elapsed + remaining is EXACTLY the
        // reset window — the invariant that makes the pair trustworthy.
        expect(result.error.retryInMs).toBeGreaterThan(0);
        expect(result.error.openForMs).toBeGreaterThanOrEqual(0);
        expect(result.error.openForMs + result.error.retryInMs).toBe(5000);
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

  describe("half-open admission is single-probe under concurrency", () => {
    it("admits exactly one probe when two callers race the elapsed reset window", async () => {
      const clock = createControlledClock({ initialTime: 0 });
      const breaker = createCircuitBreaker({
        policy: cb.policy({ failureThreshold: 1, resetTimeout: ms(500) }),
        clock,
      });

      // Open the circuit.
      await breaker
        .execute(async () => {
          throw new Error("fail");
        })
        .catch(() => {});
      expect(breaker.snapshot().state).toBe("open");

      // Elapse the reset window so both callers classify as probe-eligible.
      clock.advanceBy(ms(500));

      // A probe that parks on an external gate so both callers can claim
      // before either resolves — this is the deref→act→swap interleaving.
      let probeCalls = 0;
      let releaseProbe!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseProbe = resolve;
      });
      const probe = async () => {
        probeCalls++;
        await gate;
        return "probe-ran";
      };

      // Fire both concurrently. Their synchronous classify/claim runs before
      // any await resolves, so they genuinely race the half-open slot.
      const first = breaker.execute(probe);
      const second = breaker.execute(probe);

      releaseProbe();
      const [a, b] = await Promise.all([first, second]);

      // Exactly one probe ran; the loser short-circuited.
      expect(probeCalls).toBe(1);
      const oks = [a, b].filter(isOk);
      const errs = [a, b].filter(isErr);
      expect(oks).toHaveLength(1);
      expect(errs).toHaveLength(1);
      if (isErr(errs[0]!)) expect(errs[0]!.error.type).toBe("CIRCUIT_OPEN");

      // The winning probe succeeded, so the circuit is closed.
      expect(breaker.snapshot().state).toBe("closed");
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

  describe("the probe's lease (the 2026-08-02 incident)", () => {
    /** Trip the breaker open with `threshold` consecutive failures. */
    async function tripOpen(breaker: ReturnType<typeof createCircuitBreaker>, threshold: number) {
      for (let i = 0; i < threshold; i++) {
        await breaker
          .execute(async () => {
            throw new Error("vendor down");
          })
          .catch(() => {});
      }
      expect(breaker.snapshot().state).toBe("open");
    }

    it("a hung probe loses the slot after its lease — the eternal half-open is unrepresentable", async () => {
      // The incident, encoded: a real outage opened the circuit; the reset
      // window elapsed; ONE probe was admitted and its socket never settled.
      // Pre-lease, that probe held the slot forever and the breaker reported
      // a healthy vendor as an outage for hours. Post-lease, the next caller
      // after `probeTimeout` claims the slot, reaches the recovered vendor,
      // and closes the circuit — the zombie is dethroned, not depended on.
      const clock = createControlledClock();
      const breaker = createCircuitBreaker({
        policy: cb.policy({ failureThreshold: 1, resetTimeout: ms(1000), probeTimeout: ms(2000) }),
        clock,
      });

      await tripOpen(breaker, 1);
      clock.advanceBy(ms(1000)); // reset window elapses — slot claimable

      // The doomed probe: claims the slot, never settles. Deliberately not
      // awaited — it hangs exactly like the incident's socket did.
      const zombie = breaker.execute(() => new Promise<never>(() => {}));
      expect(breaker.snapshot().state).toBe("half-open");

      // While the lease is live, the contract holds: one probe, others refused.
      clock.advanceBy(ms(1999));
      const refused = await breaker.execute(async () => "should-not-run");
      expect(isErr(refused)).toBe(true);

      // Lease expires — the vendor recovered long ago; the next caller gets in.
      clock.advanceBy(ms(1));
      const recovered = await breaker.execute(async () => "vendor answers");
      expect(isOk(recovered)).toBe(true);
      expect(breaker.snapshot().state).toBe("closed");

      // The circuit works normally again; the zombie promise still floats,
      // deliberately unsettled — nothing depends on it anymore.
      const after = await breaker.execute(async () => 42);
      expect(isOk(after)).toBe(true);
      void zombie;
    });

    it("a dethroned probe's LATE failure lands as one ordinary closed-state failure, not a reopen spiral", async () => {
      const clock = createControlledClock();
      const breaker = createCircuitBreaker({
        policy: cb.policy({ failureThreshold: 3, resetTimeout: ms(1000), probeTimeout: ms(1000) }),
        clock,
      });

      await tripOpen(breaker, 3);
      clock.advanceBy(ms(1000));

      // The doomed probe hangs on a promise we control.
      let rejectZombie: (err: Error) => void = () => {};
      const zombie = breaker.execute(() => new Promise<never>((_, reject) => (rejectZombie = reject))).catch(() => {});

      // Lease expires; a successor probe closes the circuit on the recovered vendor.
      clock.advanceBy(ms(1000));
      const recovered = await breaker.execute(async () => "ok");
      expect(isOk(recovered)).toBe(true);
      expect(breaker.snapshot().state).toBe("closed");

      // The zombie finally dies. Aged evidence, diluted: one counted failure
      // in closed state — the circuit stays closed, no reopen.
      rejectZombie(new Error("ancient socket finally gave up"));
      await zombie;
      expect(breaker.snapshot().state).toBe("closed");
      expect(breaker.snapshot().consecutiveFailures).toBe(1);
    });

    it("probeTimeout defaults to resetTimeout, and a fresh reclaim emits circuit:half-open again", async () => {
      const clock = createControlledClock();
      const events: CircuitEvent[] = [];
      const breaker = createCircuitBreaker({
        policy: cb.policy({ failureThreshold: 1, resetTimeout: ms(500) }),
        clock,
      });
      breaker.watch((e) => events.push(e));

      await tripOpen(breaker, 1);
      clock.advanceBy(ms(500));
      void breaker.execute(() => new Promise<never>(() => {}));

      // Default lease = resetTimeout (500ms): at 499 the slot is held...
      clock.advanceBy(ms(499));
      expect(isErr(await breaker.execute(async () => "no"))).toBe(true);
      // ...at 500 it's claimable, and the reclaim is VISIBLE — a second
      // circuit:half-open event, so every admitted probe leaves a trace.
      clock.advanceBy(ms(1));
      expect(isOk(await breaker.execute(async () => "yes"))).toBe(true);
      const halfOpens = events.filter((e) => e.type === "circuit:half-open").length;
      expect(halfOpens).toBe(2);
      expect(events.at(-1)?.type).toBe("circuit:closed");
    });
  });
});
