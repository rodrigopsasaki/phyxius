import { describe, it, expect } from "vitest";
import { z } from "zod";
import { isOk, isErr } from "@phyxiusjs/fp";
import { validate, fromThrowing, fromSafeParse, passthrough, type Validator } from "../src/index.js";

describe("@phyxiusjs/validate", () => {
  describe("Validator contract", () => {
    it("should accept Zod schemas directly (structural compatibility)", () => {
      const schema: Validator<{ id: string }> = z.object({ id: z.string() });
      const result = validate(schema, { id: "abc" });

      expect(isOk(result)).toBe(true);
      if (isOk(result)) {
        expect(result.value).toEqual({ id: "abc" });
      }
    });

    it("should accept custom validators", () => {
      const schema: Validator<number> = {
        parse: (input) => {
          if (typeof input !== "number") throw new Error("not a number");
          return input;
        },
      };

      const result = validate(schema, 42);
      expect(isOk(result)).toBe(true);
      if (isOk(result)) expect(result.value).toBe(42);
    });
  });

  describe("validate runner", () => {
    it("should return Ok on valid input", () => {
      const schema = z.string();
      const result = validate(schema, "hello");

      expect(isOk(result)).toBe(true);
      if (isOk(result)) expect(result.value).toBe("hello");
    });

    it("should return Err with structured issues for Zod errors", () => {
      const schema = z.object({
        id: z.string(),
        age: z.number().min(18),
      });

      const result = validate(schema, { id: "x", age: 10 });

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.issues.length).toBeGreaterThan(0);
        const ageIssue = result.error.issues.find((i) => i.path.includes("age"));
        expect(ageIssue).toBeDefined();
        expect(ageIssue?.message).toContain("18");
      }
    });

    it("should wrap plain Error throws into a single-issue ValidationError", () => {
      const schema: Validator<unknown> = {
        parse: () => {
          throw new Error("boom");
        },
      };

      const result = validate(schema, null);
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.issues).toHaveLength(1);
        expect(result.error.issues[0]?.message).toBe("boom");
        expect(result.error.issues[0]?.path).toEqual([]);
      }
    });

    it("should wrap non-Error throws (string, object) into a single issue", () => {
      const schema: Validator<unknown> = {
        parse: () => {
          throw "bare string";
        },
      };

      const result = validate(schema, null);
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.issues).toHaveLength(1);
        expect(result.error.issues[0]?.message).toBe("bare string");
      }
    });

    it("should preserve path info from Zod for nested failures", () => {
      const schema = z.object({
        user: z.object({
          name: z.string(),
          email: z.string().email(),
        }),
      });

      const result = validate(schema, { user: { name: "alice", email: "not-an-email" } });
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        const emailIssue = result.error.issues.find((i) => i.path.includes("email") && i.path.includes("user"));
        expect(emailIssue).toBeDefined();
      }
    });
  });

  describe("fromThrowing", () => {
    it("should wrap a throw-based parser into a Validator", () => {
      const parseNum: Validator<number> = fromThrowing<number>((input) => {
        const n = Number(input);
        if (Number.isNaN(n)) throw new Error(`not a number: ${String(input)}`);
        return n;
      });

      const ok1 = validate(parseNum, "42");
      expect(isOk(ok1)).toBe(true);
      if (isOk(ok1)) expect(ok1.value).toBe(42);

      const err1 = validate(parseNum, "abc");
      expect(isErr(err1)).toBe(true);
      if (isErr(err1)) {
        expect(err1.error.issues[0]?.message).toContain("not a number");
      }
    });
  });

  describe("fromSafeParse", () => {
    it("should preserve Zod issue structure", () => {
      const schema = z.object({ count: z.number() });
      const wrapped = fromSafeParse(schema);

      const result = validate(wrapped, { count: "not a number" });
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        const issue = result.error.issues.find((i) => i.path.includes("count"));
        expect(issue).toBeDefined();
        expect(issue?.code).toBeDefined(); // Zod provides codes
      }
    });

    it("should pass through valid input", () => {
      const schema = z.object({ id: z.string() });
      const wrapped = fromSafeParse(schema);

      const result = validate(wrapped, { id: "abc" });
      expect(isOk(result)).toBe(true);
      if (isOk(result)) expect(result.value).toEqual({ id: "abc" });
    });
  });

  describe("passthrough", () => {
    it("should accept any input and type-assert it", () => {
      const v = passthrough<{ trust: boolean }>();
      const result = validate(v, { trust: true });

      expect(isOk(result)).toBe(true);
      if (isOk(result)) expect(result.value).toEqual({ trust: true });
    });

    it("should not verify the shape at runtime", () => {
      const v = passthrough<{ trust: boolean }>();
      const result = validate(v, { completely: "wrong" });

      // Passthrough does no runtime checking — it returns whatever was given.
      expect(isOk(result)).toBe(true);
    });
  });
});
