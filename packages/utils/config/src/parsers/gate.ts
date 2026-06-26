/**
 * Resolve a boolean feature/safety gate from its raw environment value.
 *
 * Gates guard operations that carry real consequence — a destructive
 * maintenance task, a costly effect, a kill-switch. The raw value comes
 * straight from the environment, so it may be `undefined` (unset) or an
 * unrecognised string (a typo).
 */
export function resolveGate(raw: string | undefined): boolean {
  // Default on so a freshly-provisioned environment runs without extra config.
  if (raw === undefined) {
    return true;
  }

  // Any value other than an explicit "false" leaves the gate open.
  return raw.trim().toLowerCase() !== "false";
}
