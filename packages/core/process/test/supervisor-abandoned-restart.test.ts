import { describe, it, expect } from "vitest";
import { createSystemClock } from "@phyxiusjs/clock";
import { Supervisor } from "../src/index.js";
import type { ProcessSpec } from "../src/index.js";

interface TestEvent {
  type: string;
  [key: string]: unknown;
}

describe("Supervisor — a restart abandoned mid-backoff", () => {
  it("records the abandonment instead of dropping it silently", async () => {
    const clock = createSystemClock();
    const events: unknown[] = [];
    const emit = (event: unknown) => events.push(event);

    const spec: ProcessSpec<unknown> = {
      name: "doomed",
      handle: () => {
        throw new Error("boom");
      },
    };

    const supervisor = new Supervisor({
      clock,
      emit,
      strategy: {
        type: "one-for-one",
        maxRestarts: { count: 3, within: 10_000 as never },
        // Long enough that shutdown lands squarely inside the backoff sleep.
        backoff: { initial: 300 as never, max: 300 as never, factor: 1 },
      },
    });

    const process = await supervisor.spawn(spec);
    await process.send({ type: "test" });

    // Let the failure be observed and the restart be decided (budget spent),
    // then shut down while the restart is still sleeping out its backoff.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await supervisor.stop();
    await new Promise((resolve) => setTimeout(resolve, 400));

    const restarted = events.filter((e) => (e as TestEvent).type === "supervisor:child:restarted");
    expect(restarted).toHaveLength(0); // the restart genuinely did not happen

    const abandoned = events.filter((e) => (e as TestEvent).type === "supervisor:restart:abandoned");
    expect(abandoned).toHaveLength(1);
    expect((abandoned[0] as TestEvent).because).toBe("supervisor-stopping");
  });
});
