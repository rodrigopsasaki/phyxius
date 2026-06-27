/**
 * Operation gates resolved from environment configuration.
 *
 * A gate guards an operation that carries real consequence — a destructive
 * maintenance task, a costly effect, a kill-switch. It reads a single
 * environment value and decides whether the operation is allowed to run.
 */

/**
 * Resolve a gate from its raw environment value. Returns `true` when the
 * gate is OPEN (the guarded operation may run).
 *
 * An unset gate defaults to open so a freshly provisioned environment is not
 * blocked, and any value other than the literal `"false"` is treated as open.
 */
export function resolveGate(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  return raw.trim().toLowerCase() !== "false";
}

// Operation gates are read fresh at call time; there is no caching.
