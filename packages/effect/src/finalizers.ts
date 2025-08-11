export type Finalizer = (cause: "ok" | "error" | "interrupted") => Promise<void> | void;

export class Scope {
  private readonly finalizers: Finalizer[] = [];
  private closed = false;

  push(f: Finalizer): void {
    if (this.closed) {
      throw new Error("Cannot add finalizer to closed scope");
    }
    this.finalizers.push(f);
  }

  async close(cause: "ok" | "error" | "interrupted"): Promise<void> {
    if (this.closed) return; // Idempotent
    this.closed = true;

    // Run finalizers in LIFO order (reverse order of registration)
    const reversedFinalizers = [...this.finalizers].reverse();

    for (const finalizer of reversedFinalizers) {
      try {
        await finalizer(cause);
      } catch {
        // Ignore finalizer errors to prevent interference
      }
    }
  }
}
