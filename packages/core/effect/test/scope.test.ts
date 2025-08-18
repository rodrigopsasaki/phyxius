import { describe, it, expect, vi } from "vitest";
import { createScope, ScopeImpl } from "../src/index.js";

describe("Scope", () => {
  describe("createScope", () => {
    it("should create scope with unique ID", () => {
      const scope1 = createScope();
      const scope2 = createScope();

      expect(scope1.id).toBeDefined();
      expect(scope2.id).toBeDefined();
      expect(scope1.id).not.toBe(scope2.id);
    });

    it("should create scope with parent ID", () => {
      const parentId = "parent-123";
      const scope = createScope(parentId);

      expect(scope.parentId).toBe(parentId);
    });

    it("should create scope without parent", () => {
      const scope = createScope();
      expect(scope.parentId).toBeUndefined();
    });
  });

  describe("ScopeImpl", () => {
    it("should start not cancelled", () => {
      const scope = new ScopeImpl();
      expect(scope.isCancelled()).toBe(false);
    });

    it("should be cancellable", () => {
      const scope = new ScopeImpl();
      scope.cancel();
      expect(scope.isCancelled()).toBe(true);
    });

    it("should call cancel callbacks on cancellation", () => {
      const scope = new ScopeImpl();
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      scope.onCancel(callback1);
      scope.onCancel(callback2);

      scope.cancel();

      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);
    });

    it("should call callback immediately if already cancelled", () => {
      const scope = new ScopeImpl();
      const callback = vi.fn();

      scope.cancel();
      scope.onCancel(callback);

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("should ignore multiple cancellations", () => {
      const scope = new ScopeImpl();
      const callback = vi.fn();

      scope.onCancel(callback);

      scope.cancel();
      scope.cancel();
      scope.cancel();

      expect(callback).toHaveBeenCalledTimes(1);
      expect(scope.isCancelled()).toBe(true);
    });

    it("should handle callback errors during cancellation", () => {
      const scope = new ScopeImpl();
      const errorCallback = vi.fn(() => {
        throw new Error("callback error");
      });
      const normalCallback = vi.fn();

      scope.onCancel(errorCallback);
      scope.onCancel(normalCallback);

      // Should not throw even though callback throws
      expect(() => scope.cancel()).not.toThrow();

      expect(errorCallback).toHaveBeenCalledTimes(1);
      expect(normalCallback).toHaveBeenCalledTimes(1);
      expect(scope.isCancelled()).toBe(true);
    });

    it("should clear callbacks after cancellation", () => {
      const scope = new ScopeImpl();
      const callback = vi.fn();

      scope.onCancel(callback);
      scope.cancel();

      // Add another callback after cancellation
      const lateCallback = vi.fn();
      scope.onCancel(lateCallback);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(lateCallback).toHaveBeenCalledTimes(1);
    });

    it("should support hierarchical scope relationships", () => {
      const parentScope = new ScopeImpl();
      const childScope = new ScopeImpl(parentScope.id);

      expect(childScope.parentId).toBe(parentScope.id);
      expect(parentScope.parentId).toBeUndefined();
    });
  });
});
