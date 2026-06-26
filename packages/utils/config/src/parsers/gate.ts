import { optionFromNullable, mapOption, unwrapOptionOr } from "@phyxiusjs/fp";

/**
 * Resolve a boolean feature/safety gate from its raw environment value.
 *
 * Gates guard operations that carry real consequence — a destructive
 * maintenance task, a costly effect, a kill-switch. The raw value comes
 * straight from the environment, so it may be `undefined` (unset) or an
 * unrecognised string (a typo).
 *
 * Lift the raw value into an Option so "unset" is a first-class branch:
 * a present string maps to its parsed boolean (only an explicit "false"
 * closes the gate), and an absent value unwraps to the default-open `true`
 * so a freshly-provisioned environment runs without extra config.
 */
export function resolveGate(raw: string | undefined): boolean {
  return unwrapOptionOr(
    mapOption(optionFromNullable(raw), (value) => value.trim().toLowerCase() !== "false"),
    true,
  );
}
