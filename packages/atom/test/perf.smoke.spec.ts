import { describe, it, expect } from "vitest";
import { createAtom } from "../src/index.js";
import { createControlledClock } from "@phyxius/clock";

describe("Atom Performance Smoke Tests", () => {
  it("should handle 50k swaps under reasonable time bound", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const atom = createAtom(0, clock);

    const startTime = Date.now();
    const iterations = 50_000;

    // Perform 50k increments
    for (let i = 0; i < iterations; i++) {
      atom.swap((n) => n + 1);
    }

    const endTime = Date.now();
    const duration = endTime - startTime;

    // Should complete in reasonable time (generous threshold for CI)
    expect(duration).toBeLessThan(5000); // 5 seconds max
    expect(atom.deref()).toBe(iterations);
    expect(atom.version()).toBe(iterations);
  });

  it("should not have memory growth with 1M swaps and historySize=1", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const atom = createAtom(0, clock, { historySize: 1 });

    // Measure initial memory
    if (global.gc) global.gc();
    const initialMemory = process.memoryUsage().heapUsed;

    // Perform many operations
    const iterations = 1_000_000;
    for (let i = 0; i < iterations; i++) {
      atom.swap((n) => (n + 1) % 1000); // Keep numbers small

      // Sample memory periodically
      if (i % 100_000 === 0 && global.gc) {
        global.gc();
      }
    }

    // Final memory measurement
    if (global.gc) global.gc();
    const finalMemory = process.memoryUsage().heapUsed;

    // Memory growth should be bounded (allow for GC noise)
    const memoryGrowth = finalMemory - initialMemory;
    const maxAllowedGrowth = 50 * 1024 * 1024; // 50MB threshold

    expect(memoryGrowth).toBeLessThan(maxAllowedGrowth);
    expect(atom.history()).toHaveLength(1); // Should maintain ring buffer size
  });

  it("should maintain performance with multiple watchers", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const atom = createAtom(0, clock);
    const notifications: number[][] = [];

    // Add 5 watchers
    for (let w = 0; w < 5; w++) {
      const watcherNotifications: number[] = [];
      notifications.push(watcherNotifications);
      atom.watch((change) => {
        watcherNotifications.push(change.to);
      });
    }

    const startTime = Date.now();
    const iterations = 10_000; // Reduced for multiple watchers

    for (let i = 0; i < iterations; i++) {
      atom.swap((n) => n + 1);
    }

    const endTime = Date.now();
    const duration = endTime - startTime;

    // Should still complete in reasonable time with watchers
    expect(duration).toBeLessThan(2000); // 2 seconds max

    // All watchers should have received all notifications
    for (const watcherNotifications of notifications) {
      expect(watcherNotifications).toHaveLength(iterations);
    }
  });

  it("should handle rapid compareAndSet operations efficiently", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const atom = createAtom(0, clock);

    const startTime = Date.now();
    const iterations = 10_000;
    let successCount = 0;

    for (let i = 0; i < iterations; i++) {
      const current = atom.deref();
      const success = atom.compareAndSet(current, current + 1);
      if (success) successCount++;
    }

    const endTime = Date.now();
    const duration = endTime - startTime;

    expect(duration).toBeLessThan(1000); // 1 second max
    expect(successCount).toBe(iterations);
    expect(atom.deref()).toBe(iterations);
  });

  it("should handle large history sizes efficiently", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const atom = createAtom("start", clock, { historySize: 1000 });

    const startTime = Date.now();
    const iterations = 2000; // More than history size

    for (let i = 0; i < iterations; i++) {
      atom.reset(`value-${i}`);
    }

    const endTime = Date.now();
    const duration = endTime - startTime;

    expect(duration).toBeLessThan(1000); // 1 second max
    expect(atom.history()).toHaveLength(1000); // Should maintain max size
    expect(atom.deref()).toBe(`value-${iterations - 1}`);
  });

  it("should not degrade with complex objects", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const atom = createAtom(
      {
        id: 0,
        data: new Array(100).fill(0).map((_, i) => ({ item: i })),
      },
      clock,
    );

    const startTime = Date.now();
    const iterations = 1000;

    for (let i = 0; i < iterations; i++) {
      atom.swap((obj) => ({
        id: obj.id + 1,
        data: [...obj.data, { item: obj.data.length }],
      }));
    }

    const endTime = Date.now();
    const duration = endTime - startTime;

    expect(duration).toBeLessThan(2000); // 2 seconds max for complex objects
    expect(atom.deref().id).toBe(iterations);
    expect(atom.deref().data).toHaveLength(100 + iterations);
  });

  it("should handle burst operations followed by idle periods", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const atom = createAtom(0, clock);
    let totalNotifications = 0;

    atom.watch(() => {
      totalNotifications++;
    });

    const startTime = Date.now();

    // Simulate burst patterns
    for (let burst = 0; burst < 10; burst++) {
      // Burst of 1000 operations
      for (let i = 0; i < 1000; i++) {
        atom.swap((n) => n + 1);
      }
      // Small idle period (simulated)
    }

    const endTime = Date.now();
    const duration = endTime - startTime;

    expect(duration).toBeLessThan(1000); // 1 second max
    expect(atom.deref()).toBe(10000);
    expect(totalNotifications).toBe(10000);
  });
});
