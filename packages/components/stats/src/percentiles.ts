/**
 * Pure percentile math over a finite sample set. Extracted so the math is
 * unit-testable without any of the journal / event plumbing.
 *
 * We use the **nearest-rank** method: for p in [0, 1], the percentile is
 * the value at index `ceil(p * N) - 1` in the sorted ascending samples,
 * clamped to [0, N-1]. Simple, deterministic, matches most ops-engineer
 * intuitions about "the p95 of these 100 numbers" (it's the 95th-largest).
 *
 * Alternative methods (linear interpolation, weighted averaging) give
 * smoother outputs for tiny sample sizes but are less intuitive at 100+
 * samples. We pick deterministic and obvious over smooth.
 */

/**
 * Return the percentile `p` (in [0, 1]) from an already-sorted-ascending
 * array. Returns 0 for an empty array (the sensible zero for "no samples
 * yet" when the caller is summing or comparing).
 */
export function percentileOfSorted(sortedAsc: ReadonlyArray<number>, p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (p <= 0) return sortedAsc[0]!;
  if (p >= 1) return sortedAsc[sortedAsc.length - 1]!;

  const index = Math.ceil(p * sortedAsc.length) - 1;
  const clamped = Math.max(0, Math.min(sortedAsc.length - 1, index));
  return sortedAsc[clamped]!;
}

/**
 * Compute p50 / p95 / p99 + min / max / mean from an unsorted sample
 * array in one pass over a single sort. Extracted as a helper so the
 * expensive part (sort + scan) happens once per snapshot, not three
 * times.
 */
export function summarize(samples: ReadonlyArray<number>): {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
} {
  if (samples.length === 0) {
    return { p50: 0, p95: 0, p99: 0, min: 0, max: 0, mean: 0 };
  }

  const sorted = [...samples].sort((a, b) => a - b);

  let sum = 0;
  for (const s of sorted) sum += s;

  return {
    p50: percentileOfSorted(sorted, 0.5),
    p95: percentileOfSorted(sorted, 0.95),
    p99: percentileOfSorted(sorted, 0.99),
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    mean: sum / sorted.length,
  };
}
