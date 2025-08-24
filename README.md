# Phyxius

Small primitives for Node.js systems that make complexity explicit.

## What This Is

A collection of focused primitives that expose the decisions you're already making in concurrent Node.js code. Each primitive does one thing. Use them independently or together.

## The Primitives

### Clock

Make time explicit. Two sources: wall time and monotonic time. Control it in tests, use real time in production.

### Atom

Versioned state with atomic updates. Makes concurrent state changes explicit and ordered.

### Journal

Append-only event log with ordering guarantees. Keep history for debugging.

### Effect

Structured concurrency with explicit resource management. Know what can fail and what gets cleaned up.

### Process

Isolated units with supervision. Failures happen - contain them and decide how to handle them.

### Context

Typed AsyncLocalStorage. Data that flows through async operations without passing it everywhere.

### FP Utils

Functional primitives that make failure explicit. No exceptions, just values.

### Handler

Process external work with explicit reliability decisions. Timeouts, retries, backpressure - you choose.

## Installation

```bash
npm install @phyxiusjs/clock
npm install @phyxiusjs/atom
npm install @phyxiusjs/journal
npm install @phyxiusjs/effect
npm install @phyxiusjs/process
npm install @phyxiusjs/context
npm install @phyxiusjs/fp
npm install @phyxiusjs/handler
```

## Quick Example

```typescript
import { createSystemClock } from "@phyxiusjs/clock";
import { createAtom } from "@phyxiusjs/atom";
import { ok, err } from "@phyxiusjs/fp";

// Time is explicit
const clock = createSystemClock();
await clock.sleep(1000);

// State changes are atomic
const state = createAtom({ count: 0 }, clock);
state.swap((s) => ({ count: s.count + 1 }));

// Errors are values
function divide(a: number, b: number) {
  return b === 0 ? err("Division by zero") : ok(a / b);
}
```

## Why These Exist

We built these for ourselves because we got tired of:

- Race conditions that only show up in production
- Time-dependent tests that fail randomly
- Exceptions appearing from nowhere
- Not knowing what resources need cleanup
- Debugging distributed state changes

These primitives don't magically solve these problems. They just make them visible so you can deal with them explicitly.

## Philosophy

- **Make complexity explicit**: Don't hide hard problems, expose them
- **Decisions as values**: Turn implicit choices into explicit ones
- **Composition over configuration**: Small pieces that fit together
- **Test what matters**: Control time, state, and failure in tests

## Status

We use these in production, but they're still evolving. APIs might change. Use at your own discretion.

## Contributing

Found a bug? Have an idea? Open an issue.

PRs welcome, but we're opinionated about keeping things small and focused.

## License

MIT

---

Built because we needed it. Shared because you might too.
