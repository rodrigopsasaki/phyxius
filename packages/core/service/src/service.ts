import type {
  FunctionLayer,
  Service,
  ServiceDefinition,
  ServiceFunction,
} from "./types.js";
import { isServiceFunction } from "./function.js";

/**
 * Define a service containing multiple service functions.
 *
 * A service groups related functions together and can provide:
 * - Default policies for functions
 * - Service-level observability hooks
 * - A namespace for function discovery
 *
 * @example
 * ```typescript
 * const userService = defineService({
 *   name: "user-service",
 *   functions: [getUser, createUser, updateUser, deleteUser],
 *   defaults: {
 *     timeout: ms(10000),
 *     circuitBreaker: { threshold: 10, resetAfter: ms(60000) },
 *   },
 *   observe: {
 *     onStart: (ctx, fn, input) => {
 *       ctx.set("service", "user-service");
 *     },
 *   },
 * });
 * ```
 */
export function defineService<
  const TFunctions extends readonly ServiceFunction<FunctionLayer, unknown, unknown>[],
>(
  definition: ServiceDefinition<TFunctions>,
): Service<TFunctions> {
  // Validate service name
  if (!definition.name || typeof definition.name !== "string") {
    throw new Error("Service must have a non-empty name");
  }

  if (!/^[a-z][a-z0-9]*(-[a-z][a-z0-9]*)*$/.test(definition.name)) {
    throw new Error(
      `Invalid service name: "${definition.name}". ` +
      `Names must be lowercase, hyphen-separated identifiers (e.g., "user-service")`,
    );
  }

  // Validate functions array
  if (!Array.isArray(definition.functions) || definition.functions.length === 0) {
    throw new Error("Service must have at least one function");
  }

  // Validate each function
  const functionNames = new Set<string>();
  for (const fn of definition.functions) {
    if (!isServiceFunction(fn)) {
      throw new Error(`Invalid function in service "${definition.name}": not a ServiceFunction`);
    }

    if (functionNames.has(fn.name)) {
      throw new Error(`Duplicate function name in service "${definition.name}": ${fn.name}`);
    }
    functionNames.add(fn.name);
  }

  // Create function lookup map
  const functionMap = new Map<string, ServiceFunction<FunctionLayer, unknown, unknown>>();
  for (const fn of definition.functions) {
    functionMap.set(fn.name, fn);
  }

  return {
    _tag: "Service",
    name: definition.name,
    functions: definition.functions,
    ...(definition.defaults !== undefined && { defaults: definition.defaults }),
    ...(definition.observe !== undefined && { observe: definition.observe }),
    get<TName extends TFunctions[number]["name"]>(
      name: TName,
    ): Extract<TFunctions[number], { name: TName }> | undefined {
      return functionMap.get(name) as Extract<TFunctions[number], { name: TName }> | undefined;
    },
  } as Service<TFunctions>;
}

/**
 * Check if a value is a service
 */
export function isService(value: unknown): value is Service<ServiceFunction<FunctionLayer, unknown, unknown>[]> {
  return (
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    value._tag === "Service"
  );
}

/**
 * Get all function names from a service
 */
export function getFunctionNames<
  TFunctions extends readonly ServiceFunction<FunctionLayer, unknown, unknown>[],
>(
  service: Service<TFunctions>,
): TFunctions[number]["name"][] {
  return service.functions.map((fn) => fn.name) as TFunctions[number]["name"][];
}

/**
 * Type helper to extract the functions type from a service
 */
export type ServiceFunctions<T> = T extends Service<infer TFunctions> ? TFunctions : never;

/**
 * Type helper to get a function by name from a service
 */
export type GetFunction<
  TService extends Service<readonly ServiceFunction<FunctionLayer, unknown, unknown>[]>,
  TName extends ServiceFunctions<TService>[number]["name"],
> = Extract<ServiceFunctions<TService>[number], { name: TName }>;
