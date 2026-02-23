import type {
  FunctionLayer,
  ServiceFunction,
  ServiceFunctionDefinition,
} from "./types.js";
import { validatePolicy } from "./policy.js";

/**
 * Define a service function with required failure policy.
 *
 * This is the core abstraction of Phyxius. Every service function must declare:
 * - Its layer (data, domain, or orchestration)
 * - Input and output schemas (Zod)
 * - A failure policy (timeout, retry, circuit breaker)
 * - The handler function
 *
 * @example
 * ```typescript
 * const getUser = defineFunction({
 *   layer: "data",
 *   name: "user.getById",
 *   input: z.object({ id: z.string() }),
 *   output: UserSchema,
 *   policy: {
 *     timeout: ms(5000),
 *     retry: { attempts: 3, backoff: "exponential", on: ["CONNECTION_ERROR"] },
 *     circuitBreaker: { threshold: 5, resetAfter: ms(30000) },
 *   },
 *   handler: async (ctx, { id }) => {
 *     const user = await ctx.effect.run(db.users.findUnique({ where: { id } }));
 *     if (user.isErr()) return Result.err(ServiceError.from(user.error));
 *     if (!user.value) return Result.err(ServiceError.notFound("User", id));
 *     return Result.ok(user.value);
 *   },
 * });
 * ```
 */
export function defineFunction<
  TLayer extends FunctionLayer,
  TInput,
  TOutput,
>(
  definition: ServiceFunctionDefinition<TLayer, TInput, TOutput>,
): ServiceFunction<TLayer, TInput, TOutput> {
  // Validate the policy at definition time
  validatePolicy(definition.policy);

  // Validate the name
  if (!definition.name || typeof definition.name !== "string") {
    throw new Error("Service function must have a non-empty name");
  }

  if (!/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/.test(definition.name)) {
    throw new Error(
      `Invalid function name: "${definition.name}". ` +
      `Names must be lowercase, dot-separated identifiers (e.g., "user.getById")`,
    );
  }

  // Validate layer
  const validLayers: FunctionLayer[] = ["data", "domain", "orchestration"];
  if (!validLayers.includes(definition.layer)) {
    throw new Error(`Invalid layer: "${definition.layer}". Must be one of: ${validLayers.join(", ")}`);
  }

  return {
    _tag: "ServiceFunction",
    layer: definition.layer,
    name: definition.name,
    input: definition.input,
    output: definition.output,
    policy: definition.policy,
    handler: definition.handler,
  };
}

/**
 * Type helper to infer the input type of a service function
 */
export type InferInput<T> = T extends ServiceFunction<FunctionLayer, infer TInput, unknown>
  ? TInput
  : never;

/**
 * Type helper to infer the output type of a service function
 */
export type InferOutput<T> = T extends ServiceFunction<FunctionLayer, unknown, infer TOutput>
  ? TOutput
  : never;

/**
 * Type helper to infer the layer of a service function
 */
export type InferLayer<T> = T extends ServiceFunction<infer TLayer, unknown, unknown>
  ? TLayer
  : never;

/**
 * Check if a value is a service function
 */
export function isServiceFunction(value: unknown): value is ServiceFunction<FunctionLayer, unknown, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    value._tag === "ServiceFunction"
  );
}

/**
 * Create a typed function reference for calling from other layers.
 * This is useful when you want to pass functions around without the full definition.
 */
export type FunctionRef<
  TLayer extends FunctionLayer,
  TInput,
  TOutput,
> = Pick<ServiceFunction<TLayer, TInput, TOutput>, "_tag" | "layer" | "name" | "input" | "output">;

/**
 * Create a function reference from a service function
 */
export function functionRef<TLayer extends FunctionLayer, TInput, TOutput>(
  fn: ServiceFunction<TLayer, TInput, TOutput>,
): FunctionRef<TLayer, TInput, TOutput> {
  return {
    _tag: fn._tag,
    layer: fn.layer,
    name: fn.name,
    input: fn.input,
    output: fn.output,
  };
}
