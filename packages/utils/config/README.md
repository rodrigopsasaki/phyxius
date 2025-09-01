# @phyxiusjs/config

Configuration that tells you when it's wrong. Config that can't surprise you. Settings that explain themselves.

Every production failure starts with configuration. Missing env vars, wrong types, hidden defaults, different behavior between dev and prod. You don't find out until the system crashes.

Config fixes this. Explicit schemas, validated types, observable changes.

## Installation

```bash
npm install @phyxiusjs/config @phyxiusjs/validate @phyxiusjs/clock @phyxiusjs/atom @phyxiusjs/fp
```

## The Problem

Traditional configuration is a minefield:

```typescript
// This is broken. You just don't know it yet.
const port = process.env.PORT || 3000;           // Is 3000 right? Who knows?
const timeout = parseInt(process.env.TIMEOUT);   // NaN if missing
const apiKey = process.env.API_KEY;              // undefined? Crash later!

if (!apiKey) {
  throw new Error("API_KEY required");           // At least crashes early...
}
```

Hidden defaults, missing validation, type coercion surprises. Configuration is where good systems go to die.

## Config Helps You With This

### Example 1 — Schema-Driven Configuration

```typescript
import { createConfig } from "@phyxiusjs/config";
import { createSystemClock } from "@phyxiusjs/clock";
import { z } from "zod";  // Or any validator

const clock = createSystemClock();

// Define your schema
const schema = z.object({
  server: z.object({
    port: z.number().min(1).max(65535),
    host: z.string().default("localhost"),
    timeout: z.number().default(30000)
  }),
  database: z.object({
    url: z.string().url(),
    poolSize: z.number().min(1).max(100).default(10)
  }),
  features: z.object({
    rateLimit: z.boolean().default(true),
    maxRequests: z.number().default(100)
  })
});

// Load with explicit sources
const config = createConfig(schema, {
  sources: [
    { type: "env" },           // Environment variables (highest priority)
    { type: "file", path: ".env" },  // .env file
    { type: "defaults" }       // Schema defaults (lowest priority)
  ],
  clock
});

// Type-safe access with Result types
const port = config.get("server.port");  // Result<number, ConfigError>
match(port, {
  ok: (p) => console.log(`Starting on port ${p}`),
  err: (e) => console.error(`Config error: ${e.message}`)
});
```

### Example 2 — dbt-Style Environment Variables

```typescript
// Environment variables with double underscore nesting
// SERVER__PORT=3000
// SERVER__HOST=localhost
// DATABASE__URL=postgres://localhost/mydb
// FEATURES__RATE_LIMIT=true
// FEATURES__MAX_REQUESTS=100

const config = createConfig(schema, {
  sources: [{ type: "env" }],  // Automatically uses dbt convention
  clock
});

// Nested values are properly parsed
const host = config.get("server.host");      // "localhost"
const rateLimit = config.get("features.rateLimit");  // true (boolean)
```

### Example 3 — Hot Reloading with Watch

```typescript
const config = createConfig(schema, {
  sources: [{ type: "file", path: "config.json" }],
  watch: true,  // Enable hot reloading
  clock
});

// Subscribe to changes
config.subscribe((event) => {
  console.log(`Config updated: ${event.type}`);
  event.changes.forEach(change => {
    console.log(`  ${change.path}: ${change.oldValue} → ${change.newValue}`);
  });
});

// Config automatically reloads when file changes
```

### Example 4 — Environment-Specific Configuration

```typescript
const environment = process.env.NODE_ENV || "development";

const config = createConfig(schema, {
  sources: [
    { type: "env" },
    { type: "file", path: `config.${environment}.json` },
    { type: "defaults" }
  ],
  clock
});

// Development gets different defaults than production
const timeout = config.get("server.timeout");
// development: 5000ms (from config.development.json)
// production: 30000ms (from config.production.json)
```

### Example 5 — Testing with Controlled Config

```typescript
import { createControlledClock } from "@phyxiusjs/clock";

test("with specific config", () => {
  const clock = createControlledClock();
  
  const config = createConfig(schema, {
    sources: [{
      type: "object",
      data: {
        server: { port: 9999, host: "test.local" },
        database: { url: "sqlite::memory:" },
        features: { rateLimit: false }
      }
    }],
    clock
  });
  
  // Test with controlled configuration
  const port = config.get("server.port");
  expect(port).toEqual(ok(9999));
});
```

## Config Does NOT Help You With This

### Example 1 — Secret Management

```typescript
// Not Config's job - use a secret manager:
const secrets = await secretManager.getSecrets();
```

### Example 2 — Remote Configuration Services

```typescript
// Not Config's job - use a config service client:
const remoteConfig = await configService.fetch();
```

### Example 3 — Configuration UI/Admin Panels

```typescript
// Not Config's job - build on top:
const configUI = new ConfigAdminPanel(config);
```

## API Reference

### `createConfig(schema, options)`

Creates a configuration instance with validation and type safety.

**Parameters:**
- `schema`: Validation schema (Zod, Yup, Joi, or any validator)
- `options`: Configuration options
  - `sources`: Array of configuration sources (order matters - first wins)
  - `clock`: Clock instance for time operations
  - `watch`: Enable hot reloading (default: false)
  - `journal`: Optional journal for event logging

**Returns:** `ConfigInstance<T>` where T is inferred from schema

### Configuration Sources

#### Environment Variables
```typescript
{ type: "env", prefix?: string, convention?: "dbt" | "flat" }
```
- Reads from `process.env`
- dbt convention: `SERVER__PORT` → `server.port`
- Optional prefix: `APP_SERVER__PORT` with prefix "APP_"

#### File
```typescript
{ type: "file", path: string, format?: "json" | "yaml" | "env" }
```
- Reads from file system
- Auto-detects format from extension
- Supports JSON, YAML, and .env files

#### Object
```typescript
{ type: "object", data: unknown }
```
- Static configuration object
- Useful for testing and defaults

#### Defaults
```typescript
{ type: "defaults" }
```
- Uses defaults from schema
- Always lowest priority

### Config Instance Methods

#### `get(path: string): Result<T, ConfigError>`
Gets a value at the specified path. Returns Result type for safe access.

#### `getOrDefault<T>(path: string, defaultValue: T): T`
Gets a value or returns the provided default if not found or invalid.

#### `getAll(): Result<Config, ConfigError>`
Returns the entire configuration object.

#### `reload(): Result<void, ConfigError>`
Manually triggers configuration reload from sources.

#### `subscribe(callback: (event: ConfigEvent) => void): () => void`
Subscribes to configuration changes. Returns unsubscribe function.

#### `generateExample(): string`
Generates example configuration based on schema.

## Environment Variable Parsing

### dbt Convention (Default)

Double underscore indicates nesting:
```bash
SERVER__PORT=3000                    # server.port = 3000
DATABASE__POOL__MIN=5                # database.pool.min = 5
FEATURES__RATE_LIMIT__ENABLED=true   # features.rateLimit.enabled = true
```

### Type Coercion

Values are automatically parsed based on content:
- `"true"` / `"false"` → boolean
- `"123"` → number
- `"12.34"` → number
- `"null"` → null
- Everything else → string

### Arrays

Arrays use numeric indices:
```bash
CORS__ORIGINS__0=http://localhost:3000
CORS__ORIGINS__1=https://example.com
# Becomes: cors.origins = ["http://localhost:3000", "https://example.com"]
```

## Testing

Config is designed for testing:

```typescript
describe("api endpoint", () => {
  it("handles rate limiting", () => {
    const config = createConfig(schema, {
      sources: [{
        type: "object",
        data: {
          features: { rateLimit: true, maxRequests: 5 }
        }
      }],
      clock: createControlledClock()
    });
    
    // Test with specific configuration
  });
});
```

## Integration with Phyxius

Config uses Phyxius primitives throughout:

- **Clock**: All time operations for watch functionality
- **Atom**: Atomic state updates for configuration changes
- **Journal**: Optional event logging for audit trails
- **FP Result**: Safe access without exceptions
- **Validate**: Schema validation with any library

## Why Config?

Traditional configuration fails silently:
- Missing variables discovered at runtime
- Type mismatches cause crashes
- Hidden defaults nobody remembers
- Different behavior in different environments
- No way to track configuration changes

Config makes everything explicit:
- Schema validation at startup
- Type-safe access throughout
- Observable changes for hot reloading
- Explicit source precedence
- Result types prevent crashes

## Philosophy

Config follows Phyxius principles:
- **Make complexity explicit**: Show source precedence
- **Errors are values**: Result types for safe access
- **Test what matters**: Controllable configuration
- **Composition over configuration**: Small pieces that fit together

## License

MIT