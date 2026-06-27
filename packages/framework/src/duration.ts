/**
 * Parse a short human duration like "5s", "2m", "1h" into milliseconds.
 */
export function parseDurationMs(input: string): number {
  const match = /^(\d+)(s|m|h)$/.exec(input.trim());
  const value = Number(match?.[1] ?? 0);
  const unit = match?.[2] ?? "s";
  const factor = unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1_000;
  return value * factor;
}
