/**
 * Levenshtein edit distance between two strings — the minimum number of
 * single-character insertions, deletions, or substitutions to turn `a`
 * into `b`. Pure, deterministic, no dependency.
 */
export function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));

  for (let i = 0; i < rows; i++) dp[i]![0] = i;
  for (let j = 0; j < cols; j++) dp[0]![j] = j;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1, // deletion
        dp[i]![j - 1]! + 1, // insertion
        dp[i - 1]![j - 1]! + substitutionCost, // substitution
      );
    }
  }

  return dp[rows - 1]![cols - 1]!;
}

/**
 * Does `key` look like a typo of one of `reservedKeys`? Used to catch a
 * top-level config key that's a near-miss of a framework-reserved slice
 * name (`observabilty` for `observability`) — the case that would
 * otherwise ride along silently as an "app key" while the real slice
 * quietly falls back to its schema defaults underneath it.
 *
 * Compares lowercase forms, so a pure case slip (`Observability`) counts
 * too. Never flags a key that matches a reserved name exactly — that key
 * is real, not a typo, and belongs to the slice's own (strict) schema.
 *
 * Deliberately narrow: only distance <= 1. A key like `server_port` is
 * far from `server` and is left alone — it's legitimately somebody's own
 * app key, not a near-miss of the reserved one.
 *
 * @returns the reserved key `key` looks like a typo of, or `undefined`.
 */
export function findTypoOfReservedKey(key: string, reservedKeys: readonly string[]): string | undefined {
  for (const reserved of reservedKeys) {
    if (key === reserved) return undefined;
    if (editDistance(key.toLowerCase(), reserved.toLowerCase()) <= 1) return reserved;
  }
  return undefined;
}
