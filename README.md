# Phyxius

Fundamental building blocks for deterministic, observable Node.js applications.

## Philosophy

- **Time, state, failure, and observability are first-class citizens**
- **Everything must be deterministic when needed**
- **No magic globals** - explicit dependencies everywhere
- **Small, composable primitives** - each ≤300 LOC

## The Five Building Blocks

### 1. Clock

Deterministic time control with `SystemClock` for real time and `ControlledClock` for tests.

### 2. Atom

Mutable reference with versioned changes and immutable history.

### 3. Journal

Append-only log for replay, debugging, and time-travel.

### 4. Effect

Structured concurrency with context, timeouts, retries, and cancellation.

### 5. Process

Actor-like units with mailbox, state, and supervision.

## Development

```bash
# Install dependencies
pnpm install

# Run tests
pnpm test

# Build all packages
pnpm build

# Type checking
pnpm typecheck

# Linting & formatting
pnpm lint
pnpm format
```

## Requirements

- Node.js ≥ 22.0.0
- pnpm ≥ 9.0.0
- ESM-only (`"type": "module"`)

## License

MIT
