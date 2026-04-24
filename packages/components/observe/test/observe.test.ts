import { describe, it, expect } from "vitest";
import { context } from "@phyxiusjs/context";
import { observe, type InferShape } from "../src/index.js";

describe("observe — typed field handles", () => {
  describe("value fields", () => {
    it("should set, get, has, and delete a typed value", async () => {
      const fields = observe.fields({
        operation: observe.field<string>(),
      });

      await context.scope(async () => {
        expect(fields.operation.has()).toBe(false);
        expect(fields.operation.get()).toBeUndefined();

        fields.operation.set("user.login");
        expect(fields.operation.get()).toBe("user.login");
        expect(fields.operation.has()).toBe(true);

        const deleted = fields.operation.delete();
        expect(deleted).toBe(true);
        expect(fields.operation.has()).toBe(false);

        expect(fields.operation.delete()).toBe(false);
      });
    });

    it("should expose the resolved key on each handle", () => {
      const fields = observe.fields({
        operation: observe.field<string>(),
        requestId: observe.field<string>(),
      });

      expect(fields.operation.key).toBe("operation");
      expect(fields.requestId.key).toBe("requestId");
    });
  });

  describe("numeric fields", () => {
    it("should increment from undefined to amount, then accumulate", async () => {
      const fields = observe.fields({
        attempts: observe.number(),
      });

      await context.scope(async () => {
        fields.attempts.inc();
        expect(fields.attempts.get()).toBe(1);

        fields.attempts.inc();
        expect(fields.attempts.get()).toBe(2);

        fields.attempts.inc(5);
        expect(fields.attempts.get()).toBe(7);
      });
    });

    it("should initialize to the first increment amount", async () => {
      const fields = observe.fields({
        bytes: observe.number(),
      });

      await context.scope(async () => {
        fields.bytes.inc(1024);
        expect(fields.bytes.get()).toBe(1024);
      });
    });

    it("should handle negative increments", async () => {
      const fields = observe.fields({
        counter: observe.number(),
      });

      await context.scope(async () => {
        fields.counter.set(10);
        fields.counter.inc(-3);
        expect(fields.counter.get()).toBe(7);
      });
    });

    it("should throw when inc is called on a non-numeric existing value", async () => {
      const loose = observe.fields({
        counter: observe.field<unknown>(),
      });
      const asNumeric = observe.fields({
        counter: observe.number(),
      });

      await context.scope(async () => {
        loose.counter.set("not a number");
        expect(() => asNumeric.counter.inc()).toThrow(/expected number/);
      });
    });
  });

  describe("array fields", () => {
    it("should push to an array, creating it if missing", async () => {
      const fields = observe.fields({
        events: observe.array<{ type: string; at: number }>(),
      });

      await context.scope(async () => {
        fields.events.push({ type: "start", at: 100 });
        fields.events.push({ type: "process", at: 200 });

        const events = fields.events.get();
        expect(events).toHaveLength(2);
        expect(events?.[0]).toEqual({ type: "start", at: 100 });
        expect(events?.[1]).toEqual({ type: "process", at: 200 });
      });
    });

    it("should throw when pushing to a non-array existing value", async () => {
      const loose = observe.fields({
        events: observe.field<unknown>(),
      });
      const asArray = observe.fields({
        events: observe.array<string>(),
      });

      await context.scope(async () => {
        loose.events.set("not an array");
        expect(() => asArray.events.push("bad")).toThrow(/expected array/);
      });
    });

    it("should allow set with a full array replacement", async () => {
      const fields = observe.fields({
        events: observe.array<number>(),
      });

      await context.scope(async () => {
        fields.events.push(1);
        fields.events.push(2);
        fields.events.set([10, 20, 30]);
        expect(fields.events.get()).toEqual([10, 20, 30]);
      });
    });
  });

  describe("snapshot", () => {
    it("should return only declared fields that have been set", async () => {
      const fields = observe.fields({
        operation: observe.field<string>(),
        attempts: observe.number(),
        events: observe.array<{ type: string }>(),
      });

      await context.scope(async () => {
        fields.operation.set("user.create");
        fields.attempts.inc(3);
        // events intentionally unset

        const snap = observe.snapshot(fields);
        expect(snap).toEqual({
          operation: "user.create",
          attempts: 3,
        });
        // events is not present in the snapshot
        expect("events" in snap).toBe(false);
      });
    });

    it("should ignore fields not declared in the schema, even if present in ctx.data", async () => {
      const declared = observe.fields({
        a: observe.field<string>(),
      });

      await context.scope(
        async () => {
          declared.a.set("declared-value");

          const snap = observe.snapshot(declared);
          expect(snap).toEqual({ a: "declared-value" });
          expect("ignored" in snap).toBe(false);
        },
        { initial: { ignored: "not-in-schema" } },
      );
    });
  });

  describe("cross-scope accumulation (the mechanism)", () => {
    it("should accumulate array pushes from nested scopes into the parent", async () => {
      const fields = observe.fields({
        trace: observe.array<{ span: string; op: string }>(),
      });

      await context.scope(
        async () => {
          fields.trace.push({ span: "root", op: "login" });

          await context.scope(async () => {
            fields.trace.push({ span: "child", op: "validate" });
          });

          const trace = fields.trace.get();
          expect(trace).toHaveLength(2);
          expect(trace?.[0]).toEqual({ span: "root", op: "login" });
          expect(trace?.[1]).toEqual({ span: "child", op: "validate" });
        },
        { initial: { trace: [] } },
      );
    });

    it("should not leak to parent when inherit is false", async () => {
      const fields = observe.fields({
        events: observe.array<string>(),
      });

      await context.scope(
        async () => {
          fields.events.push("parent");

          await context.scope(
            async () => {
              fields.events.push("child"); // writes only to child's scope
              expect(fields.events.get()).toEqual(["child"]);
            },
            { inherit: false },
          );

          // Parent is untouched
          expect(fields.events.get()).toEqual(["parent"]);
        },
        { initial: { events: [] } },
      );
    });
  });

  describe("concurrent scopes are isolated", () => {
    it("should keep each scope's handle writes independent", async () => {
      const fields = observe.fields({
        worker: observe.field<string>(),
        tasks: observe.number(),
      });

      const results = await Promise.all([
        context.scope(
          async () => {
            fields.worker.set("A");
            fields.tasks.inc(5);
            await new Promise((resolve) => setTimeout(resolve, 10));
            return observe.snapshot(fields);
          },
          { initial: {} },
        ),
        context.scope(
          async () => {
            fields.worker.set("B");
            fields.tasks.inc(3);
            await new Promise((resolve) => setTimeout(resolve, 10));
            return observe.snapshot(fields);
          },
          { initial: {} },
        ),
      ]);

      expect(results[0]).toEqual({ worker: "A", tasks: 5 });
      expect(results[1]).toEqual({ worker: "B", tasks: 3 });
    });
  });

  describe("error handling", () => {
    it("should throw when any handle is used outside a context scope", () => {
      const fields = observe.fields({
        a: observe.field<string>(),
        b: observe.number(),
        c: observe.array<string>(),
      });

      expect(() => fields.a.set("x")).toThrow("No active context available");
      expect(() => fields.a.get()).toThrow("No active context available");
      expect(() => fields.a.has()).toThrow("No active context available");
      expect(() => fields.a.delete()).toThrow("No active context available");
      expect(() => fields.b.inc()).toThrow("No active context available");
      expect(() => fields.c.push("x")).toThrow("No active context available");
      expect(() => observe.snapshot(fields)).toThrow("No active context available");
    });
  });

  describe("shape inference", () => {
    it("should let consumers derive the runtime shape from the schema", () => {
      // The `fields` binding is used only at the type level via `typeof`.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const fields = observe.fields({
        requestId: observe.field<string>(),
        attempts: observe.number(),
        events: observe.array<{ type: string }>(),
      });

      // Compile-time check: InferShape<typeof fields> produces the plain shape.
      type Shape = InferShape<typeof fields>;

      // Runtime assignment just to keep the type binding from being erased.
      const example: Shape = {
        requestId: "abc",
        attempts: 3,
        events: [{ type: "hello" }],
      };

      expect(example.requestId).toBe("abc");
      expect(example.attempts).toBe(3);
      expect(example.events).toHaveLength(1);
    });
  });

  describe("field tiers — core vs extra", () => {
    it("fields declared with observe.field/number/array are tagged as core", () => {
      const fields = observe.fields({
        a: observe.field<string>(),
        b: observe.number(),
        c: observe.array<number>(),
      });
      expect(fields.a.tier).toBe("core");
      expect(fields.b.tier).toBe("core");
      expect(fields.c.tier).toBe("core");
    });

    it("fields declared with observe.extra/extraNumber/extraArray are tagged as extra", () => {
      const fields = observe.fields({
        a: observe.extra<string>(),
        b: observe.extraNumber(),
        c: observe.extraArray<number>(),
      });
      expect(fields.a.tier).toBe("extra");
      expect(fields.b.tier).toBe("extra");
      expect(fields.c.tier).toBe("extra");
    });

    it("extra fields capture values the same way core fields do", async () => {
      const fields = observe.fields({
        coreMsg: observe.field<string>(),
        debugPrompt: observe.extra<string>(),
      });

      await context.scope(async () => {
        fields.coreMsg.set("hello");
        fields.debugPrompt.set("internal prompt text");

        expect(fields.coreMsg.get()).toBe("hello");
        expect(fields.debugPrompt.get()).toBe("internal prompt text");
      });
    });

    it("snapshot() defaults to includeExtra=true (backward compatible)", async () => {
      const fields = observe.fields({
        msg: observe.field<string>(),
        debug: observe.extra<string>(),
      });

      await context.scope(async () => {
        fields.msg.set("visible");
        fields.debug.set("breadcrumb");

        const snap = observe.snapshot(fields);
        expect(snap.msg).toBe("visible");
        expect(snap.debug).toBe("breadcrumb");
      });
    });

    it("snapshot(..., { includeExtra: false }) filters out extras but keeps core", async () => {
      const fields = observe.fields({
        msg: observe.field<string>(),
        debug: observe.extra<string>(),
        counter: observe.number(),
        debugCounter: observe.extraNumber(),
      });

      await context.scope(async () => {
        fields.msg.set("visible");
        fields.debug.set("hidden");
        fields.counter.inc(5);
        fields.debugCounter.inc(99);

        const snap = observe.snapshot(fields, { includeExtra: false });
        expect(snap.msg).toBe("visible");
        expect(snap.counter).toBe(5);
        expect("debug" in snap).toBe(false);
        expect("debugCounter" in snap).toBe(false);
      });
    });

    it("snapshot(..., { includeExtra: true }) includes everything", async () => {
      const fields = observe.fields({
        msg: observe.field<string>(),
        debug: observe.extra<string>(),
      });

      await context.scope(async () => {
        fields.msg.set("a");
        fields.debug.set("b");

        const snap = observe.snapshot(fields, { includeExtra: true });
        expect(snap.msg).toBe("a");
        expect(snap.debug).toBe("b");
      });
    });

    it("unset extras are absent from the snapshot regardless of includeExtra", async () => {
      const fields = observe.fields({
        debug: observe.extra<string>(),
      });

      await context.scope(async () => {
        // Never set. Should be absent either way.
        expect("debug" in observe.snapshot(fields, { includeExtra: false })).toBe(false);
        expect("debug" in observe.snapshot(fields, { includeExtra: true })).toBe(false);
      });
    });
  });
});
