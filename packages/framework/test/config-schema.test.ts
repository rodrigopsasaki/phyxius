import { describe, expect, it } from "vitest";
import { z, ZodError } from "zod";

import { frameworkConfigSchema } from "../src/config-schema.js";

// ── Reserved slices are strict, recursively ────────────────────────────────

describe("frameworkConfigSchema — server/observability are strict", () => {
  it("rejects an unknown key inside observability, naming the key and its path", () => {
    let thrown: unknown;
    try {
      frameworkConfigSchema.parse({
        observability: { log_sampling: { ratio_of_succesful_requests: 0.5 } },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ZodError);
    const zodError = thrown as ZodError;
    expect(zodError.issues).toHaveLength(1);
    expect(zodError.issues[0]?.code).toBe("unrecognized_keys");
    expect(zodError.issues[0]?.path).toEqual(["observability", "log_sampling"]);
    expect(zodError.message).toContain("ratio_of_succesful_requests");
  });

  it("rejects an unknown key inside server, naming the key and its path", () => {
    let thrown: unknown;
    try {
      frameworkConfigSchema.parse({ server: { port: 3000, hots: "0.0.0.0" } });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ZodError);
    const zodError = thrown as ZodError;
    expect(zodError.issues[0]?.code).toBe("unrecognized_keys");
    expect(zodError.issues[0]?.path).toEqual(["server"]);
    expect(zodError.message).toContain("hots");
  });

  it("rejects an unknown key nested two levels deep — a per-handler threshold typo", () => {
    let thrown: unknown;
    try {
      frameworkConfigSchema.parse({
        observability: { stats: { thresholds: { "order.process": { p50ms: 100 } } } },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ZodError);
    const zodError = thrown as ZodError;
    expect(zodError.issues[0]?.code).toBe("unrecognized_keys");
    expect(zodError.issues[0]?.path).toEqual(["observability", "stats", "thresholds", "order.process"]);
    expect(zodError.message).toContain("p50ms");
  });

  it("absent keys still default — regression check", () => {
    const parsed = frameworkConfigSchema.parse({});
    expect(parsed).toEqual({
      observability: {
        log_drain: "stdout",
        log_sampling: { ratio_of_successful_requests: 1, log_all_failures: true },
        stats: { window_size: 1000, thresholds: {} },
        observe: { include_extra: false },
      },
    });
  });

  it("a partially-specified reserved slice still defaults the rest", () => {
    const parsed = frameworkConfigSchema.parse({
      server: { port: 8080 },
      observability: { log_drain: "none" },
    });
    expect(parsed.server).toEqual({ port: 8080 });
    expect(parsed.observability.log_drain).toBe("none");
    expect(parsed.observability.observe).toEqual({ include_extra: false });
  });
});

// ── Top level stays open ───────────────────────────────────────────────────

describe("frameworkConfigSchema — top level stays open for app keys", () => {
  it("passes an app key through untouched when intersected with an appSchema — the README shape", () => {
    const appSchema = z.object({
      features: z.object({
        new_pricing: z.boolean().default(false),
      }),
    });

    const combined = frameworkConfigSchema.and(appSchema);
    const parsed = combined.parse({
      server: { port: 3000 },
      observability: {},
      features: { new_pricing: true },
    }) as { features: { new_pricing: boolean } };

    expect(parsed.features).toEqual({ new_pricing: true });
  });

  it("rejects a top-level key within edit distance 1 of a reserved slice name", () => {
    let thrown: unknown;
    try {
      frameworkConfigSchema.parse({ observabilty: { log_drain: "none" } });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ZodError);
    const zodError = thrown as ZodError;
    expect(zodError.issues[0]?.path).toEqual(["observabilty"]);
    expect(zodError.issues[0]?.message).toContain("observabilty");
    expect(zodError.issues[0]?.message).toContain('did you mean "observability"');
  });

  it("rejects a top-level near-miss of server too", () => {
    let thrown: unknown;
    try {
      frameworkConfigSchema.parse({ servr: { port: 3000 } });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ZodError);
    const zodError = thrown as ZodError;
    expect(zodError.issues[0]?.message).toContain('did you mean "server"');
  });

  it("does not flag an unrelated top-level app key that happens to be far from any reserved name", () => {
    const parsed = frameworkConfigSchema.parse({ server_port: 3000, features: { on: true } });
    // Not a recognized field of frameworkConfigSchema's own shape, so it's
    // stripped from THIS schema's output (default zod "strip" behavior) —
    // but critically, parsing did not throw. It's treated as an app key,
    // consistent with the intersection-based flow real apps use.
    expect(parsed).not.toHaveProperty("server_port");
    expect(parsed.observability.log_drain).toBe("stdout");
  });
});
