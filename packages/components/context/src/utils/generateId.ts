/**
 * Generates a unique identifier for contexts.
 *
 * Uses crypto.randomUUID() for secure random IDs that are suitable
 * for correlation across distributed systems.
 *
 * @returns A unique identifier string
 */
export function generateId(): string {
  return crypto.randomUUID();
}
