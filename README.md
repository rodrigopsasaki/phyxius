# Phyxius

**Primitives for building systems that have a production mindset.**

## Why This Exists

After years of building Node.js systems, I got tired of the same production issues: race conditions that only happen under load, tests that pass locally but fail in CI, timing-dependent bugs that disappear when you try to debug them, resource leaks that slowly kill your servers.

The problem isn't Node.js. The problem is that async programming is fundamentally broken at the primitive level. Promises don't clean up. `setTimeout` isn't testable. Shared state races against itself. Failures cascade through systems.

I built Phyxius because I wanted primitives that make it very hard to write code that breaks in production.

## The Five Primitives

### **Clock** - Time That Works

Two time tracks: wall time (can jump due to NTP) and monotonic time (perfect for intervals). Controllable in tests, observable in production.

### **Atom** - State That Can't Race

Atomic updates with versioning and change tracking. Multiple writers never corrupt state. Perfect for conflict-free replication.

### **Journal** - Events That Never Disappear

Append-only log with guaranteed ordering. Every event preserved forever. Debug any issue by replaying history.

### **Effect** - Async That Cleans Up

Structured concurrency with automatic resource management. Cancel operations cleanly. No leaks, no zombies.

### **Process** - Units That Restart on Failure

Isolated processes with supervision. Let it crash, let it restart. Failures don't cascade.

## Quick Start

```typescript
import { createSystemClock } from "@phyxius/clock";
import { createAtom } from "@phyxius/atom";
import { Journal } from "@phyxius/journal";

const clock = createSystemClock();

// Atomic state - no race conditions
const users = createAtom(new Map(), clock);
users.swap((map) => new Map(map).set("alice", { online: true }));

// Event history - complete audit trail
const events = new Journal({ clock });
events.append({ type: "user.login", userId: "alice" });

// Deterministic time - testable delays
await clock.sleep(1000); // Real time in production, instant in tests
```

## What You Get

**In Production:**

- Resource leaks become impossible
- Race conditions are eliminated at the primitive level
- Timing bugs disappear with deterministic time
- Failures are isolated and self-healing
- Complete audit trail of everything that happens

**In Development:**

- Tests run instantly with controlled time
- Complex async scenarios become trivial to set up
- Debugging with time travel and complete history
- No more "works on my machine" timing issues

## Examples

Want to see what's possible? Check out complete, production-ready patterns:

- **[Event-Sourced SaaS](examples/event-sourced-saas.md)** - Multi-tenant platform with billing, audit trails, and time travel debugging
- **[Distributed Cache](examples/distributed-cache.md)** - Fault-tolerant caching with gossip protocol and automatic failover
- **[Real-Time Collaboration](examples/real-time-collaboration.md)** - Multi-user editing with conflict-free merge and operational transforms
- **[HTTP Server](examples/express-server.md)** - Express server rebuilt with supervision, graceful shutdown, and circuit breakers

## Learn More

Each primitive stands alone but they're designed to work together:

- **[Clock](packages/clock/)** - Deterministic time for reliable systems
- **[Atom](packages/atom/)** - Atomic state for race-free updates
- **[Journal](packages/journal/)** - Event sourcing for complete history
- **[Effect](packages/effect/)** - Structured concurrency for resource safety
- **[Process](packages/process/)** - Actor model for fault tolerance

## Installation

```bash
npm install @phyxius/clock @phyxius/atom @phyxius/journal @phyxius/effect @phyxius/process
```

## Philosophy

Production systems fail at the boundaries - between sync and async, between one service and another, between what you expect and what actually happens.

These primitives give you solid boundaries you can reason about. They're not clever. They're not revolutionary. They just work.

Every time.

---

_Built because Node.js deserves primitives that don't break in production._
