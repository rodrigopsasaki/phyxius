# @phyxiusjs/temporal

Temporal utilities for controlling function execution timing.

These utilities help manage when and how often functions execute, using Clock for deterministic, testable time operations.

## Installation

```bash
npm install @phyxiusjs/temporal @phyxiusjs/clock
```

## What This Does

- **debounce**: Execute function after delay with no new calls
- **throttle**: Execute function at most once per interval
- Uses Clock abstraction instead of setTimeout for testable timing

## Quick Example

```typescript
import { debounce, throttle } from "@phyxiusjs/temporal";
import { createSystemClock } from "@phyxiusjs/clock";

const clock = createSystemClock();

// Debounce: Execute after delay with no new calls
const saveDocument = debounce(
  (doc: Document) => {
    console.log("Saving:", doc.id);
  },
  1000, // ms
  clock,
);

// Call many times, executes once after 1 second
saveDocument(doc);
saveDocument(doc);
saveDocument(doc); // Only this one executes

// Throttle: Execute at most once per interval
const updatePosition = throttle(
  (x: number, y: number) => {
    console.log(`Position: ${x}, ${y}`);
  },
  100, // ms
  clock,
);

// Call many times, executes every 100ms
for (let i = 0; i < 1000; i++) {
  updatePosition(i, i * 2);
}
```

## Testing

Use controlled time for deterministic tests:

```typescript
import { createControlledClock } from "@phyxiusjs/clock";
import { debounce } from "@phyxiusjs/temporal";

test("debounce behavior", async () => {
  const clock = createControlledClock();
  const fn = vi.fn();
  const debounced = debounce(fn, 500, clock);

  debounced("test");
  expect(fn).not.toHaveBeenCalled();

  clock.advance(500);
  await clock.flush();

  expect(fn).toHaveBeenCalledWith("test");
});
```

## API Reference

### `debounce(fn, delayMs, clock)`

Delays function execution until after delay milliseconds have passed since the last call.

- `fn`: Function to debounce
- `delayMs`: Delay in milliseconds
- `clock`: Clock instance for timing

### `throttle(fn, delayMs, clock)`

Limits function execution to at most once per delay interval.

- `fn`: Function to throttle
- `delayMs`: Minimum interval in milliseconds
- `clock`: Clock instance for timing

## Part of Phyxius

Works with:

- `@phyxiusjs/clock` - Required for timing operations
- All other Phyxius packages that need temporal control

## License

MIT
