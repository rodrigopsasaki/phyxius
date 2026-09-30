import type { ProcessEvent } from "../src/index.js";

/**
 * Event-driven rather than sleep-driven, same rationale as
 * supervisor-abandoned-restart.test.ts. Unlike that file's `eventWaiter`,
 * this one waits for the Nth occurrence of a type rather than the first.
 * Every scenario in these tests drives several restarts of the *same* event type, and
 * "has this type ever fired" would resolve immediately on the second wait,
 * before the second restart it's meant to observe has even happened.
 */
export function eventWaiter(): {
  emit: (event: ProcessEvent) => void;
  events: ProcessEvent[];
  waitForCount: (type: string, count: number) => Promise<void>;
  countOf: (type: string) => number;
} {
  const events: ProcessEvent[] = [];
  const watchers: Array<{ type: string; count: number; resolve: () => void }> = [];

  const countOf = (type: string) => events.filter((e) => e.type === type).length;

  return {
    events,
    countOf,
    emit: (event: ProcessEvent) => {
      events.push(event);
      for (const watcher of [...watchers]) {
        if (countOf(watcher.type) >= watcher.count) {
          watchers.splice(watchers.indexOf(watcher), 1);
          watcher.resolve();
        }
      }
    },
    waitForCount: (type: string, count: number) =>
      new Promise<void>((resolve) => {
        if (countOf(type) >= count) return resolve();
        watchers.push({ type, count, resolve });
      }),
  };
}
