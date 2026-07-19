/** Exponential backoff with a hard ceiling — waits grow 2x per attempt. */
export function backoffMs(attempt: number, baseMs: number, ceilingMs: number): number {
  const raw = baseMs * Math.pow(2, attempt as number);
  return Math.min(raw, ceilingMs);
}
