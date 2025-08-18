import { describe, it, expect } from "vitest";
import { effect, succeed, fail } from "../src/index.js";
import { createControlledClock } from "@phyxius/clock";

describe("Basic Architecture", () => {
  it("should run a simple effect and return Result", async () => {
    const simpleEffect = succeed(42);

    const result = await simpleEffect.unsafeRunPromise();

    expect(result).toEqual({ _tag: "Ok", value: 42 });
  });

  it("should handle errors as Results", async () => {
    const failingEffect = fail("test error");

    const result = await failingEffect.unsafeRunPromise();

    expect(result).toEqual({ _tag: "Err", error: "test error" });
  });

  it("should work with clock in environment", async () => {
    const clock = createControlledClock({ initialTime: 1000 });

    const clockEffect = effect(async (env) => {
      const time = env.clock?.now().wallMs ?? 0;
      return { _tag: "Ok", value: time };
    });

    const result = await clockEffect.unsafeRunPromise({ clock });

    expect(result).toEqual({ _tag: "Ok", value: 1000 });
  });
});
