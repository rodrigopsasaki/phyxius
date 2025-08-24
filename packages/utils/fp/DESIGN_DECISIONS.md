# @phyxiusjs/fp Design Decisions & Implementation Notes

## Overview

`@phyxiusjs/fp` is a comprehensive functional programming library designed specifically for the Phyxius ecosystem. It provides exception-free, composable utilities that align with Phyxius's core philosophy of making concurrency and error handling explicit.

## Design Principles Applied

### 1. No Exceptions Anywhere

- **Decision**: All functions return `Result<T, E>` or `Option<T>` types instead of throwing
- **Rationale**: Exceptions are invisible in type signatures and break composability
- **Implementation**: Every potentially failing operation returns a Result type
- **Example**: `fromPromise()` converts throwing promises to Results

### 2. Explicit Error Handling

- **Decision**: Errors are values that flow through the system
- **Rationale**: Makes error handling explicit and composable
- **Implementation**: Rich Result and AsyncResult APIs with error transformation
- **Example**: `mapErr()` allows transforming error types in pipelines

### 3. Composability First

- **Decision**: All utilities work together seamlessly
- **Rationale**: Enables building complex operations from simple primitives
- **Implementation**: Consistent interfaces, pipe-friendly APIs
- **Example**: `pipe(result, map(...), flatMap(...), orElse(...))` chains naturally

### 4. Type Safety Without `any`

- **Decision**: Zero usage of `any` type, strict TypeScript throughout
- **Rationale**: Prevents runtime errors and improves developer experience
- **Implementation**: Branded types, phantom types, conditional types
- **Example**: `Millis` branded type prevents mixing time units

## Architecture Decisions

### Monadic Structure

**Choice**: Full monad implementation for Result and Option

- `map`: Transform success/some values
- `flatMap`: Chain operations that return Results/Options
- `ap`: Apply functions inside containers
- **Why**: Enables powerful composition patterns from category theory

### Right-Leaning Bias

**Choice**: Operations favor the "success" path (Ok/Some)

- `map` only transforms Ok values
- `flatMap` only chains on Ok values
- `filter` converts Ok to Err if predicate fails
- **Why**: Matches common usage patterns and error handling flows

### Eager vs Lazy Evaluation

**Choice**: Eager evaluation throughout

- Operations execute immediately when called
- No lazy streams or infinite data structures
- **Why**: Simpler debugging, predictable performance, fits Node.js patterns

### Pattern Matching Design

**Choice**: Multiple pattern matching styles

- Fluent builder API: `match(value).when(...).otherwise(...)`
- Object-based: `matchTag(value, { tag1: ..., tag2: ... })`
- Specialized matchers: `matchNumber`, `matchString`
- **Why**: Different styles fit different use cases and developer preferences

## Implementation Highlights

### Result Type

```typescript
type Result<T, E> = Ok<T> | Err<E>;
```

- Discriminated union with `_tag` property
- Full monadic interface
- Comprehensive utility functions
- Async variants for Promise integration

### Option Type

```typescript
type Option<T> = Some<T> | None;
```

- Singleton `None` instance for memory efficiency
- Null-safe operations throughout
- Conversion utilities to/from nullable types
- Collection operations (`all`, `compact`, `partition`)

### Validation System

```typescript
type ValidationResult<T> = Result<T, ValidationError[]>;
```

- Accumulates errors instead of short-circuiting
- Composable validators
- Built-in validators for common types
- Field context preservation

### Async Support

```typescript
type AsyncResult<T, E> = Promise<Result<T, E>>;
```

- All Result operations have async variants
- Proper error handling for Promise rejection
- Concurrency utilities (`allAsync`, `raceAsync`)
- Retry logic with exponential backoff

## Key Opinionated Choices

### 1. Handler Signature

```typescript
handle(input: TInput): Result<TOutput, Error>
```

- Always returns Result type
- Explicit input/output types
- No exceptions thrown
- **Reasoning**: Predictable, composable, type-safe

### 2. Error Type Flexibility

- `Result<T, E = Error>` - Error type is generic
- Built-in support for string errors
- Validation errors are structured objects
- **Reasoning**: Different contexts need different error representations

### 3. Import Strategy

- Named exports for all utilities
- Convenience re-exports (`ResultOk`, `OptionSome`)
- Type utilities for common patterns
- **Reasoning**: Tree-shaking friendly, clear API surface

### 4. Testing Philosophy

- Comprehensive test coverage (164 tests)
- Both positive and negative cases
- Integration tests for composition
- **Reasoning**: Functional code must be reliable and predictable

## Performance Considerations

### Memory Efficiency

- Singleton `None` instance
- Immutable data structures
- Memoization where appropriate
- **Trade-off**: Slight overhead for type safety and immutability

### Bundle Size

- Tree-shakable exports
- No heavy dependencies
- ESM only for modern bundlers
- **Target**: < 30KB minified for full library

### Runtime Performance

- Minimal abstraction overhead
- Direct property access for type guards
- No complex inheritance hierarchies
- **Philosophy**: Zero-cost abstractions where possible

## Integration Points

### With Phyxius Core

- Clock integration for time-aware operations
- Atom integration for reactive state
- Effect integration for structured concurrency
- **Strategy**: Gradual adoption, no breaking changes

### With External Libraries

- Promise integration via `fromPromise`
- Express.js middleware patterns
- React hooks compatibility
- **Approach**: Adapter pattern for common integrations

## Future Considerations

### Planned Additions

- Stream processing utilities
- More pattern matching variants
- Performance optimizations
- Browser compatibility layer

### Extension Points

- Custom validator implementations
- Additional async primitives
- Interop with other FP libraries
- Framework-specific adapters

## Breaking Changes Policy

### Semantic Versioning

- Major: Breaking API changes
- Minor: New features, non-breaking additions
- Patch: Bug fixes, documentation

### Deprecation Strategy

- 6-month deprecation period for breaking changes
- Clear migration guides
- Gradual introduction of new APIs

## Summary

`@phyxiusjs/fp` represents a carefully designed functional programming library that prioritizes:

1. **Developer Experience**: Clear APIs, excellent TypeScript support
2. **Reliability**: No exceptions, explicit error handling
3. **Composability**: Everything works together naturally
4. **Performance**: Efficient implementations, small bundle size
5. **Phyxius Integration**: Perfect fit with the ecosystem's philosophy

The library is ready for production use and provides a solid foundation for building exception-free, composable applications in the Phyxius style.
