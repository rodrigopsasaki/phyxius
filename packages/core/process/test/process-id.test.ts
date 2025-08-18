import { describe, it, expect } from "vitest";
import { createProcessId, ProcessIdImpl } from "../src/index.js";

describe("ProcessId", () => {
  describe("createProcessId", () => {
    it("should create unique IDs by default", () => {
      const id1 = createProcessId();
      const id2 = createProcessId();

      expect(id1.value).toBeDefined();
      expect(id2.value).toBeDefined();
      expect(id1.value).not.toBe(id2.value);
    });

    it("should create ID with specific value", () => {
      const id = createProcessId("test-123");
      expect(id.value).toBe("test-123");
    });
  });

  describe("ProcessIdImpl", () => {
    it("should have value property", () => {
      const id = new ProcessIdImpl("test-id");
      expect(id.value).toBe("test-id");
    });

    it("should convert to string", () => {
      const id = new ProcessIdImpl("test-id");
      expect(id.toString()).toBe("test-id");
    });

    it("should compare equality correctly", () => {
      const id1 = new ProcessIdImpl("same");
      const id2 = new ProcessIdImpl("same");
      const id3 = new ProcessIdImpl("different");

      expect(id1.equals(id2)).toBe(true);
      expect(id1.equals(id3)).toBe(false);
    });

    it("should generate UUID when no value provided", () => {
      const id = new ProcessIdImpl();
      expect(id.value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });
  });
});
