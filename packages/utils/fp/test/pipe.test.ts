import { describe, it, expect } from "vitest";
import { pipe, flow, compose, pipeAsync, flowAsync, identity, constant, tap, tapAsync } from "../src/pipe.js";

describe("Pipe and Compose", () => {
  describe("pipe", () => {
    it("should pipe single function", () => {
      const result = pipe(5, (x) => x * 2);
      expect(result).toBe(10);
    });

    it("should pipe multiple functions", () => {
      const result = pipe(
        5,
        (x) => x * 2,
        (x) => x + 1,
        (x) => x.toString(),
      );
      expect(result).toBe("11");
    });

    it("should work with different types", () => {
      const result = pipe(
        "hello",
        (s) => s.length,
        (n) => n * 2,
        (n) => n > 5,
      );
      expect(result).toBe(true);
    });

    it("should handle up to 10 functions", () => {
      const result = pipe(
        1,
        (x) => x + 1, // 2
        (x) => x + 1, // 3
        (x) => x + 1, // 4
        (x) => x + 1, // 5
        (x) => x + 1, // 6
        (x) => x + 1, // 7
        (x) => x + 1, // 8
        (x) => x + 1, // 9
        (x) => x + 1, // 10
        (x) => x + 1, // 11
      );
      expect(result).toBe(11);
    });
  });

  describe("flow", () => {
    it("should create a function from single function", () => {
      const fn = flow((x: number) => x * 2);
      expect(fn(5)).toBe(10);
    });

    it("should create a function from multiple functions", () => {
      const fn = flow(
        (x: number) => x * 2,
        (x) => x + 1,
        (x) => x.toString(),
      );
      expect(fn(5)).toBe("11");
    });

    it("should be reusable", () => {
      const processNumber = flow(
        (x: number) => x * 2,
        (x) => x + 1,
      );

      expect(processNumber(5)).toBe(11);
      expect(processNumber(10)).toBe(21);
    });
  });

  describe("compose", () => {
    it("should compose single function", () => {
      const fn = compose((x: number) => x * 2);
      expect(fn(5)).toBe(10);
    });

    it("should compose multiple functions right-to-left", () => {
      const fn = compose(
        (x: number) => x.toString(),
        (x: number) => x + 1,
        (x: number) => x * 2,
      );
      expect(fn(5)).toBe("11");
    });

    it("should be mathematical composition", () => {
      const double = (x: number) => x * 2;
      const addOne = (x: number) => x + 1;
      const toString = (x: number) => x.toString();

      // f(g(h(x))) = compose(f, g, h)(x)
      const composed = compose(toString, addOne, double);
      const manual = (x: number) => toString(addOne(double(x)));

      expect(composed(5)).toBe(manual(5));
      expect(composed(5)).toBe("11");
    });
  });

  describe("async pipe", () => {
    it("should pipe async functions", async () => {
      const result = await pipeAsync(
        5,
        async (x) => x * 2,
        async (x) => x + 1,
        async (x) => x.toString(),
      );
      expect(result).toBe("11");
    });

    it("should handle mixed sync/async", async () => {
      const result = await pipeAsync(
        "hello",
        async (s: string) => s.length,
        (n: number) => n * 2, // This would be async in real implementation
        async (n: number) => n > 5,
      );
      expect(result).toBe(true);
    });

    it("should work with promises", async () => {
      const result = await pipeAsync(
        await Promise.resolve(5),
        async (x) => x * 2,
        async (x) => x + 1,
      );
      expect(result).toBe(11);
    });
  });

  describe("async flow", () => {
    it("should create async function from async functions", async () => {
      const fn = flowAsync(
        async (x: number) => x * 2,
        async (x) => x + 1,
        async (x) => x.toString(),
      );

      const result = await fn(5);
      expect(result).toBe("11");
    });

    it("should be reusable", async () => {
      const processNumber = flowAsync(
        async (x: number) => x * 2,
        async (x) => x + 1,
      );

      expect(await processNumber(5)).toBe(11);
      expect(await processNumber(10)).toBe(21);
    });
  });

  describe("utility functions", () => {
    it("identity should return input unchanged", () => {
      expect(identity(42)).toBe(42);
      expect(identity("hello")).toBe("hello");
      expect(identity(null)).toBe(null);
      expect(identity(undefined)).toBe(undefined);

      const obj = { a: 1 };
      expect(identity(obj)).toBe(obj);
    });

    it("constant should return function that always returns same value", () => {
      const fn = constant(42);
      expect(fn()).toBe(42);
      expect(fn()).toBe(42);

      const fnStr = constant("hello");
      expect(fnStr()).toBe("hello");
    });

    it("tap should perform side effect without changing value", () => {
      let sideEffect = 0;
      const fn = tap((x: number) => {
        sideEffect = x * 2;
      });

      const result = fn(21);
      expect(result).toBe(21);
      expect(sideEffect).toBe(42);
    });

    it("tap should work in pipe", () => {
      let sideEffect = 0;

      const result = pipe(
        5,
        (x) => x * 2,
        tap((x) => {
          sideEffect = x;
        }),
        (x) => x + 1,
      );

      expect(result).toBe(11);
      expect(sideEffect).toBe(10);
    });

    it("tapAsync should perform async side effect", async () => {
      let sideEffect = 0;
      const fn = tapAsync(async (x: number) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        sideEffect = x * 2;
      });

      const result = await fn(21);
      expect(result).toBe(21);
      expect(sideEffect).toBe(42);
    });
  });

  describe("integration", () => {
    it("should work with complex data transformations", () => {
      interface User {
        name: string;
        age: number;
        email: string;
      }

      const users: User[] = [
        { name: "Alice", age: 25, email: "alice@example.com" },
        { name: "Bob", age: 30, email: "bob@example.com" },
        { name: "Charlie", age: 35, email: "charlie@example.com" },
      ];

      const processUsers = flow(
        (users: User[]) => users.filter((u) => u.age >= 30),
        (users) => users.map((u) => u.name.toUpperCase()),
        (names) => names.join(", "),
      );

      const result = processUsers(users);
      expect(result).toBe("BOB, CHARLIE");
    });

    it("should compose with other utilities", () => {
      const processString = flow(
        (s: string) => s.trim(),
        (s) => s.toLowerCase(),
        (s) => s.split(" "),
        (words) => words.filter((w) => w.length > 3),
        (words) => words.join("-"),
      );

      const result = processString("  Hello World JavaScript  ");
      expect(result).toBe("hello-world-javascript");
    });

    it("should work with error handling patterns", () => {
      const safeProcessing = flow(
        (input: string) => input.trim(),
        (input) => {
          if (!input) throw new Error("Empty input");
          return input;
        },
        (input) => input.toUpperCase(),
      );

      expect(safeProcessing("hello")).toBe("HELLO");
      expect(() => safeProcessing("  ")).toThrow("Empty input");
    });
  });
});
