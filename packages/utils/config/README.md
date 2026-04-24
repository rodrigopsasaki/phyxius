# Config

Configuration that tells you when it's wrong. Layered sources, typed path access, hot reload, observable changes — all with explicit precedence and deterministic testing.

---

## What this really is

Every production failure starts with configuration. Missing env vars, wrong types, hidden defaults, different behavior between dev and prod. `@phyxiusjs/config` gives you:

- **Validator-agnostic schemas.** Any `{ parse(input): T }` works — Zod, custom validators, anything with that shape.
- **Layered sources with explicit precedence.** Env > file > object > defaults, or whatever order you declare. The **first source in the list wins**.
- **Typed path access.** `config.get("server.port")` returns `Result<number, ConfigError>` — the value type is inferred from your schema.
- **Hot reload with file watching.** File-change detection with a Clock-driven debounce, deterministic in tests.
- **Observable changes.** Every event is a typed value routed through subscribers and (optionally) a Journal.

---

## Installation

```bash
npm install @phyxiusjs/config @phyxiusjs/clock @phyxiusjs/fp
```

Requires `@phyxiusjs/atom`, `@phyxiusjs/journal`, and `@phyxiusjs/temporal` as runtime deps (installed transitively).

---

## Quick start

```typescript
import { createConfig } from "@phyxiusjs/config";
import { createSystemClock } from "@phyxiusjs/clock";
import { z } from "zod";

const clock = createSystemClock();

const schema = z.object({
  server: z.object({
    port: z.number().min(1).max(65535),
    host: z.string().default("localhost"),
  }),
  database: z.object({
    url: z.string().url(),
    poolSize: z.number().default(10),
  }),
});

const config = createConfig(schema, {
  // Precedence order: FIRST source wins.
  sources: [
    { type: "env", prefix: "APP_", convention: "dbt" },
    { type: "file", path: "./config.json" },
    { type: "defaults" },
  ],
  clock,
});

// Typed paths — return type follows from the schema.
const port = config.get("server.port"); // Result<number, ConfigError>
const url = config.get("database.url"); // Result<string, ConfigError>

// Or with a fallback:
const poolSize = config.getOrDefault("database.poolSize", 5); // number
```

---

## Precedence: first source wins

Sources are declared in priority order, highest first:

```typescript
sources: [
  { type: "object", data: runtimeOverrides }, // highest — always wins where set
  { type: "env", prefix: "APP_" }, // next
  { type: "file", path: ".env" }, // next
  { type: "defaults" }, // lowest — only fills gaps
];
```

When two sources provide the same key, the earlier one wins. Lower-priority sources fill in fields that higher-priority sources don't specify.

---

## Typed path access

The schema type flows through to `get`:

```typescript
const schema = z.object({
  server: z.object({ port: z.number(), host: z.string() }),
});

const config = createConfig(schema, { ... });

const port = config.get("server.port");
//     ^? Result<number, ConfigError>

const host = config.get("server.host");
//     ^? Result<string, ConfigError>

// Typos caught at compile time:
// config.get("server.prt"); // ❌ TS2345: "server.prt" not in Path<T>
```

For cases where paths are dynamic (computed at runtime), use the untyped escape hatch:

```typescript
const result = config.getPath(dynamicPath); // Result<unknown, ConfigError>
```

Arrays are treated as leaf values — no numeric-index paths in the typed API. Use `getPath` when you need to reach into arrays.

---

## Sources

### `{ type: "env", prefix?, convention? }`

Environment variables. Two conventions:

- **`"dbt"`** (default) — `SERVER__PORT=3000` becomes `{ server: { port: 3000 } }`
- **`"flat"`** — `SERVER_PORT=3000` becomes `{ serverPort: 3000 }`

Values are auto-coerced: `"true"`/`"false"` → boolean, numeric strings → number, `"null"` → null.

### `{ type: "file", path, format? }`

JSON or `.env` files. **YAML is intentionally not supported** — a correct YAML implementation is beyond the scope of a config primitive. If you need YAML, pre-process with `js-yaml` and pass the result as `{ type: "object", data }`.

### `{ type: "object", data }`

Inline data. Useful for overrides in tests and programmatic configuration.

### `{ type: "defaults" }`

Currently a placeholder — schema defaults are applied by the validator itself (e.g., `z.string().default(...)`). Kept for future schema-introspection use.

---

## Hot reload

```typescript
const config = createConfig(schema, {
  sources: [{ type: "file", path: "./config.json" }],
  clock,
  watch: true,
});

config.subscribe((event) => {
  if (event.type === "CONFIG_RELOADED") {
    console.log("changes:", event.changes);
  }
});
```

File-change detection uses `fs.watchFile` with a Clock-driven debounce (default 20ms), so rapid changes to the file produce a single reload. The Clock backing means timing is deterministic in tests with a controlled Clock.

The filesystem poll interval (default 100ms) is real-time — it's inherent to `fs.watchFile`. You can configure it via the custom loader if you need different behavior:

```typescript
import { createLoader } from "@phyxiusjs/config";

const loader = createLoader({ clock, watchPollIntervalMs: 50 });

const config = createConfig(schema, {
  sources: [...],
  clock,
  watch: true,
  loader,
});
```

---

## Observability

Every meaningful state transition emits a `ConfigEvent`:

```typescript
type ConfigEvent =
  | { type: "CONFIG_LOADED"; at: Instant }
  | { type: "CONFIG_RELOADED"; changes: ConfigChange[]; at: Instant }
  | { type: "CONFIG_ERROR"; error: ConfigError; at: Instant }
  | { type: "WATCH_STARTED"; path: string; at: Instant }
  | { type: "WATCH_STOPPED"; path: string; at: Instant };
```

Pair with `@phyxiusjs/journal` for a replayable audit trail:

```typescript
import { Journal } from "@phyxiusjs/journal";

const journal = new Journal<ConfigEvent>({ clock });

const config = createConfig(schema, {
  sources: [...],
  clock,
  journal,
});

// Every ConfigEvent is appended to the journal automatically.
```

---

## Errors

Errors are structured values, never thrown:

```typescript
type ConfigError =
  | { type: "VALIDATION_ERROR"; message: string; details?: unknown }
  | { type: "SOURCE_ERROR"; source: string; message: string; cause?: unknown }
  | { type: "PARSE_ERROR"; source: string; message: string }
  | { type: "FILE_NOT_FOUND"; path: string }
  | { type: "PATH_NOT_FOUND"; path: string };
```

When the most recent load failed, subsequent `get`/`getPath`/`getAll` calls return the original failure (e.g. `VALIDATION_ERROR` or `FILE_NOT_FOUND`) — no wrapping, the cause is the value you see.

---

## Teardown

`createConfig` with `watch: true` installs file watchers. Call `dispose()` when you're done:

```typescript
const config = createConfig(schema, { sources, clock, watch: true });

// ... use config ...

config.dispose(); // idempotent, stops watchers, clears subscribers
```

**No process exit handlers are registered automatically.** The library doesn't touch `process.on`. If you want teardown on shutdown, call `dispose()` yourself in your shutdown hook.

---

## Deterministic testing

Config is fully Clock-driven except the OS filesystem poll. For tests that don't involve file watching, everything is deterministic:

```typescript
import { createControlledClock, ms } from "@phyxiusjs/clock";

const clock = createControlledClock({ initialTime: 0 });
const config = createConfig(schema, {
  sources: [{ type: "object", data: { server: { port: 3000 } } }],
  clock,
});

const port = config.get("server.port"); // Ok(3000)
```

For file-watch tests, the debounce is Clock-driven (deterministic under `ControlledClock`), but the `fs.watchFile` poll itself is real-time. Inject a tighter poll interval for tests if needed:

```typescript
const loader = createLoader({ clock, watchPollIntervalMs: 10 });
```

---

## API

```typescript
function createConfig<T>(
  schema: Validator<T>,
  options: {
    sources: ConfigSource[]; // first-wins precedence
    clock: Clock;
    watch?: boolean; // enable file watching, default false
    journal?: Journal<ConfigEvent>; // route events here
    environment?: string; // metadata tag
    loader?: ConfigLoader; // inject a custom loader
  },
): ConfigInstance<T>;

interface ConfigInstance<T> {
  get<P extends Path<T>>(path: P): Result<PathValue<T, P>, ConfigError>;
  getPath(path: string): Result<unknown, ConfigError>;
  getOrDefault<P extends Path<T>, D>(path: P, defaultValue: D): PathValue<T, P> | D;
  getAll(): Result<T, ConfigError>;
  reload(): Result<void, ConfigError>;
  subscribe(cb: (event: ConfigEvent) => void): () => void;
  getMetadata(): ConfigMetadata;
  dispose(): void;
}
```

### Custom loaders

```typescript
interface ConfigLoader {
  load(source: ConfigSource): Result<unknown, ConfigError>;
  watch?(source: ConfigSource, callback: (data: unknown) => void): () => void;
}

const consulLoader: ConfigLoader = { ... };
createConfig(schema, { sources, clock, loader: consulLoader });
```

Use this for non-file sources (Consul, Vault, AWS SSM), or to inject test data without touching the filesystem.

---

## What this does NOT do

- **No YAML** — drop the file format or pre-process.
- **No implicit cleanup** — call `dispose()`. The library never registers process handlers on your behalf.
- **No async source loading** — sources are loaded synchronously (via `readFileSync`, `process.env`). For async sources (network, DB), inject a custom loader that blocks in `load()` or cache asynchronously outside `createConfig`.
- **No schema coupling** — the validator is any `{ parse(input): T }`. Config doesn't know about Zod specifically and doesn't leak Zod types into its API.
- **No stderr pollution** — subscriber errors are contained, not logged to `console.error`. Route through the journal if you want visibility.

---

## What you get

- **Typed config access** where the schema flows all the way to `result.value`.
- **Precedence you can reason about** — first source wins, documented and tested.
- **Deterministic hot reload** — Clock-driven debounce, injectable poll interval for tests.
- **Structured events** — observability by value, not logs.
- **No leaks** — explicit `dispose()`, bounded state, no accumulating arrays.

Config is a small primitive made to be reached for, not wrestled with.
