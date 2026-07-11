import { optionFromNullable, mapOption, unwrapOptionOr } from "@phyxiusjs/fp";

/**
 * Whether a gate lets the operation it guards proceed.
 *
 * A literal union rather than a bare boolean so the meaning lives in the
 * type — callers read `"open"`/`"closed"` instead of remembering which way
 * `true` points.
 */
export type GateState = "open" | "closed";

/**
 * Resolve a {@link GateState} from a gate's raw environment value.
 *
 * Gates guard operations that carry real consequence — a destructive
 * maintenance task, a costly effect, a kill-switch. The raw value comes
 * straight from the environment, so it may be `undefined` (unset) or an
 * unrecognised string (a typo).
 *
 * Lift the raw value into an Option so "unset" is a first-class branch:
 * a present string maps to its parsed state (only an explicit "false"
 * closes the gate), and an absent value unwraps to the default-open
 * `"open"` so a freshly-provisioned environment runs without extra config.
 */
export function resolveGate(raw: string | undefined): GateState {
  return unwrapOptionOr(
    mapOption(optionFromNullable(raw), (value) => (value.trim().toLowerCase() === "false" ? "closed" : "open")),
    "open",
  );
}
