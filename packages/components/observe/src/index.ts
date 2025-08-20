import { context } from "@phyxiusjs/context";

/**
 * Observability namespace providing static functions to manipulate context data.
 *
 * This namespace provides convenient methods for adding observability data to the
 * current context without needing to directly manipulate the context data object.
 * All functions operate on the active context from @phyxiusjs/context.
 *
 * @example
 * ```typescript
 * import { observe } from "@phyxiusjs/observe";
 * import { context } from "@phyxiusjs/context";
 *
 * await context.scope(async () => {
 *   observe.set("operation", "user.login");
 *   observe.push("events", { type: "auth.attempt", timestamp: Date.now() });
 *   observe.inc("attempts");
 *
 *   // Business logic here
 *   const user = await authenticateUser(credentials);
 *
 *   observe.set("userId", user.id);
 *   observe.push("events", { type: "auth.success", userId: user.id });
 * }, { initial: { requestId: "req-123" } });
 * ```
 */
export const observe = {
  /**
   * Sets a key-value pair in the current context data.
   *
   * @param key - The key to set
   * @param value - The value to assign to the key
   * @throws {Error} If no active context is available
   *
   * @example
   * ```typescript
   * observe.set("operation", "user.login");
   * observe.set("startTime", Date.now());
   * observe.set("metadata", { source: "api", version: "v1" });
   * ```
   */
  set(key: string, value: unknown): void {
    const ctx = context.get();
    (ctx.data as Record<string, unknown>)[key] = value;
  },

  /**
   * Pushes a value to an array in the current context data.
   * Creates the array if it doesn't exist.
   *
   * @param arrayName - The name of the array property
   * @param value - The value to push to the array
   * @throws {Error} If no active context is available
   *
   * @example
   * ```typescript
   * observe.push("events", { type: "database.query", table: "users" });
   * observe.push("errors", new Error("Connection failed"));
   * observe.push("metrics", { name: "response_time", value: 150 });
   * ```
   */
  push(arrayName: string, value: unknown): void {
    const ctx = context.get();
    const data = ctx.data as Record<string, unknown>;

    if (!Array.isArray(data[arrayName])) {
      data[arrayName] = [];
    }

    (data[arrayName] as unknown[]).push(value);
  },

  /**
   * Increments a numeric counter in the current context data.
   * Initializes to 1 if the key doesn't exist or isn't a number.
   *
   * @param key - The counter key to increment
   * @param amount - The amount to increment by (default: 1)
   * @throws {Error} If no active context is available
   *
   * @example
   * ```typescript
   * observe.inc("attempts");        // Increments by 1
   * observe.inc("retries", 3);      // Increments by 3
   * observe.inc("bytes_sent", 1024); // Track cumulative values
   * ```
   */
  inc(key: string, amount: number = 1): void {
    const ctx = context.get();
    const data = ctx.data as Record<string, unknown>;

    const current = data[key];
    data[key] = (typeof current === "number" ? current : 0) + amount;
  },

  /**
   * Gets a value from the current context data.
   *
   * @param key - The key to retrieve
   * @returns The value associated with the key, or undefined if not found
   * @throws {Error} If no active context is available
   *
   * @example
   * ```typescript
   * const operation = observe.get("operation");
   * const events = observe.get("events") as Event[];
   * const attempts = observe.get("attempts") as number;
   * ```
   */
  get(key: string): unknown {
    const ctx = context.get();
    return (ctx.data as Record<string, unknown>)[key];
  },

  /**
   * Checks if a key exists in the current context data.
   *
   * @param key - The key to check
   * @returns True if the key exists, false otherwise
   * @throws {Error} If no active context is available
   *
   * @example
   * ```typescript
   * if (observe.has("userId")) {
   *   // User is authenticated
   * }
   *
   * if (!observe.has("startTime")) {
   *   observe.set("startTime", Date.now());
   * }
   * ```
   */
  has(key: string): boolean {
    const ctx = context.get();
    return key in (ctx.data as Record<string, unknown>);
  },

  /**
   * Removes a key from the current context data.
   *
   * @param key - The key to remove
   * @returns True if the key was removed, false if it didn't exist
   * @throws {Error} If no active context is available
   *
   * @example
   * ```typescript
   * observe.delete("temporaryData");
   * observe.delete("cache");
   * ```
   */
  delete(key: string): boolean {
    const ctx = context.get();
    const data = ctx.data as Record<string, unknown>;

    if (key in data) {
      delete data[key];
      return true;
    }

    return false;
  },

  /**
   * Gets all context data as a readonly object.
   *
   * @returns The current context data
   * @throws {Error} If no active context is available
   *
   * @example
   * ```typescript
   * const allData = observe.all();
   * console.log(allData.operation, allData.events);
   * ```
   */
  all(): Readonly<Record<string, unknown>> {
    const ctx = context.get();
    return ctx.data as Record<string, unknown>;
  },
};
