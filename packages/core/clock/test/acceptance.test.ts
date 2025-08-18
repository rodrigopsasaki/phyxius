import { describe, it, expect } from "vitest";
import { createControlledClock, createSystemClock, ms } from "../src/index.js";

describe("Acceptance Gate Tests", () => {
  describe("Determinism", () => {
    it("should simulate 24h in < 2s wall time with zero flake", async () => {
      const startWall = Date.now();
      const clock = createControlledClock({ initialTime: 0 });
      const events: string[] = [];

      // Set up timers across 24 hours
      clock.sleep(ms(1000)).then(() => events.push("1s"));
      clock.sleep(ms(3600_000)).then(() => events.push("1h")); // 1 hour
      clock.sleep(ms(43200_000)).then(() => events.push("12h")); // 12 hours
      clock.sleep(ms(86400_000)).then(() => events.push("24h")); // 24 hours

      // Advance 24 hours (86,400,000 ms)
      clock.advanceBy(ms(86400_000));
      await clock.flush();

      const wallTimeElapsed = Date.now() - startWall;

      // All timers should have fired
      expect(events).toContain("1s");
      expect(events).toContain("1h");
      expect(events).toContain("12h");
      expect(events).toContain("24h");

      // Should complete in well under 2s
      expect(wallTimeElapsed).toBeLessThan(2000);
    });

    it("should fire timers in precise order", async () => {
      const clock = createControlledClock({ initialTime: 0 });
      const events: string[] = [];

      // Set up timers in non-chronological order
      // Use tick() to fire timers one by one to test ordering
      clock.sleep(ms(300)).then(() => events.push("C"));
      clock.sleep(ms(100)).then(() => events.push("A"));
      clock.sleep(ms(200)).then(() => events.push("B"));
      clock.sleep(ms(400)).then(() => events.push("D"));

      // Use tick() to fire timers individually in chronological order
      clock.tick(); // Should fire A at 100
      await clock.flush();
      expect(events).toEqual(["A"]);

      clock.tick(); // Should fire B at 200
      await clock.flush();
      expect(events).toEqual(["A", "B"]);

      clock.tick(); // Should fire C at 300
      await clock.flush();
      expect(events).toEqual(["A", "B", "C"]);

      clock.tick(); // Should fire D at 400
      await clock.flush();
      expect(events).toEqual(["A", "B", "C", "D"]);
    });

    it("should support catch-up ticks for intervals", async () => {
      const clock = createControlledClock({ initialTime: 0 });
      const ticks: number[] = [];

      const handle = clock.interval(ms(100), () => {
        ticks.push(clock.now().monoMs);
      });

      // Advance way past multiple intervals at once
      clock.advanceBy(ms(550)); // Should fire at 100, 200, 300, 400, 500
      await clock.flush();

      handle.cancel();

      expect(ticks).toEqual([100, 200, 300, 400, 500]);
    });
  });

  describe("Cadence & Reentrancy", () => {
    it("should prevent interval overlap in SystemClock", (done) => {
      const clock = createSystemClock();
      let inFlight = false;
      let overlapDetected = false;

      const handle = clock.interval(ms(50), async () => {
        if (inFlight) {
          overlapDetected = true;
        }
        inFlight = true;

        // Simulate slow callback that takes longer than interval
        await new Promise((resolve) => setTimeout(resolve, 100));

        inFlight = false;
      });

      setTimeout(() => {
        handle.cancel();
        expect(overlapDetected).toBe(false);
        done();
      }, 300);
    });

    it("should maintain fixed cadence in ControlledClock", async () => {
      const clock = createControlledClock({ initialTime: 0 });
      const ticks: number[] = [];

      const handle = clock.interval(ms(100), () => {
        ticks.push(clock.now().monoMs);
        // Simulate work that would normally shift cadence
        clock.advanceBy(ms(10)); // This should NOT affect next tick timing
      });

      // Advance enough for several ticks
      clock.advanceBy(ms(350));
      await clock.flush();

      handle.cancel();

      // Should maintain perfect 100ms cadence despite callback advancing time
      expect(ticks).toEqual([100, 200, 300]);
    });

    it("should prevent next tick when cancelled during callback", async () => {
      const clock = createControlledClock({ initialTime: 0 });
      const ticks: number[] = [];

      const handle = clock.interval(ms(100), () => {
        ticks.push(clock.now().monoMs);
        if (ticks.length === 2) {
          handle.cancel(); // Cancel during second callback
        }
      });

      clock.advanceBy(ms(300)); // Should have fired 3 times, but cancelled after 2
      await clock.flush();

      expect(ticks).toEqual([100, 200]); // Third tick at 300 prevented by cancellation
    });
  });

  describe("API Invariants", () => {
    it("should ensure monoMs never decreases", () => {
      const clock = createControlledClock({ initialTime: 1000 });
      let prevMono = clock.now().monoMs;

      // Test various operations
      for (let i = 0; i < 100; i++) {
        clock.advanceBy(ms(Math.random() * 100));
        clock.jumpWallTime(Math.random() * 1000000);

        const currentMono = clock.now().monoMs;
        expect(currentMono).toBeGreaterThanOrEqual(prevMono);
        prevMono = currentMono;
      }
    });

    it("should have deadline resolve at or after target wallMs", async () => {
      const clock = createControlledClock({ initialTime: 1000 });
      let resolvedAt = 0;

      const target = 1500;
      clock.deadline({ wallMs: target }).then(() => {
        resolvedAt = clock.now().wallMs;
      });

      clock.advanceBy(ms(600)); // Advance past target
      await clock.flush();

      expect(resolvedAt).toBeGreaterThanOrEqual(target);
    });

    it("should have timeout equivalent to sleep", async () => {
      const clock = createControlledClock({ initialTime: 0 });
      const results: string[] = [];

      clock.timeout(ms(100)).then(() => results.push("timeout"));
      clock.sleep(ms(100)).then(() => results.push("sleep"));

      clock.advanceBy(ms(100));
      await clock.flush();

      expect(results).toContain("timeout");
      expect(results).toContain("sleep");
      expect(results.length).toBe(2);
    });

    it("should always stop further ticks when interval cancelled", async () => {
      const clock = createControlledClock({ initialTime: 0 });
      const ticks: number[] = [];

      const handle = clock.interval(ms(50), () => {
        ticks.push(clock.now().monoMs);
      });

      clock.advanceBy(ms(100)); // Should tick at 50, 100
      await clock.flush();

      handle.cancel();

      clock.advanceBy(ms(100)); // Should not tick at 150, 200
      await clock.flush();

      expect(ticks).toEqual([50, 100]); // No ticks after cancellation
    });
  });
});
