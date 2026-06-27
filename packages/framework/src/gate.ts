/**
 * Resolve an operation gate from its environment variable.
 *
 * Gates guard destructive maintenance tasks and kill-switches. A gate is
 * considered OPEN unless the variable is explicitly set to the string "false".
 */
export function resolveGate(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  return raw.trim().toLowerCase() !== "false";
}

// resolveGate reads the env value fresh on each call.
