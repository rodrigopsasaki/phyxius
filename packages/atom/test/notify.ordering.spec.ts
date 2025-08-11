import { describe, it, expect } from "vitest";
import { createAtom } from "../src/index.js";
import { createControlledClock } from "@phyxius/clock";

describe("Atom Notification Ordering", () => {
  it("should fire watchers in registration order for each change", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const atom = createAtom(0, clock);
    const events: Array<{ watcher: string; change: number; versionTo: number }> = [];

    // Register two watchers
    const unsubscribe1 = atom.watch((change) => {
      events.push({ watcher: "watcher1", change: change.to, versionTo: change.versionTo });
    });

    atom.watch((change) => {
      events.push({ watcher: "watcher2", change: change.to, versionTo: change.versionTo });
    });

    // Make first change
    atom.reset(1);

    // Make second change
    atom.reset(2);

    // Unsubscribe first watcher
    unsubscribe1();

    // Make third change - only second watcher should fire
    atom.reset(3);

    // Verify ordering: watcher1 then watcher2 for each change
    expect(events).toEqual([
      { watcher: "watcher1", change: 1, versionTo: 1 },
      { watcher: "watcher2", change: 1, versionTo: 1 },
      { watcher: "watcher1", change: 2, versionTo: 2 },
      { watcher: "watcher2", change: 2, versionTo: 2 },
      { watcher: "watcher2", change: 3, versionTo: 3 }, // Only watcher2 for last change
    ]);
  });

  it("should handle multiple watchers with immediate unsubscribe", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const atom = createAtom("initial", clock);
    const events: string[] = [];

    const unsubscribe = atom.watch((change) => {
      events.push(`change-${change.to}`);
    });

    // Make a change
    atom.reset("first");
    expect(events).toEqual(["change-first"]);

    // Unsubscribe and make another change
    unsubscribe();
    atom.reset("second");

    // Should not receive the second change
    expect(events).toEqual(["change-first"]);
  });

  it("should not fire callback on equal writes", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const atom = createAtom("value", clock);
    const notifications: string[] = [];

    atom.watch((change) => {
      notifications.push(`${change.from}->${change.to}`);
    });

    // Equal write should not trigger notification
    atom.reset("value");
    expect(notifications).toHaveLength(0);

    // Different write should trigger notification
    atom.reset("new-value");
    expect(notifications).toEqual(["value->new-value"]);

    // Another equal write should not trigger
    atom.reset("new-value");
    expect(notifications).toEqual(["value->new-value"]);
  });
});
