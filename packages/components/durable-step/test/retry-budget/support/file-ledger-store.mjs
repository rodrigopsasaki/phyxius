// A `LedgerStore` (see `src/ledger-store.ts`) backed by a plain JSON file on
// disk instead of an in-process `Map`. This is a TEST-ONLY proof harness —
// not exported from the package, not a production adapter — standing in
// for a real durably-backed store (Postgres row-level CAS, the same
// horizon PHYXIUS_CODEX already names for `StateStore`/`PhaseStore`).
// Plain JavaScript (not TypeScript) deliberately: this file is imported
// both by the vitest test process AND by plain `node` child processes
// forked as "different workers" — the whole point of round 2 is that
// those workers share NOTHING but this file's path and Node's own
// filesystem, not a build step, not a module cache, not a V8 heap.
//
// CAS is implemented with a directory-based mutex
// (`fs.mkdir(lockPath)` — atomic create-if-absent on every POSIX
// filesystem, no extra dependency) guarding a read-JSON / modify /
// write-via-rename cycle. `rename` is atomic on POSIX, so a reader never
// observes a half-written file even without the lock; the lock's real job
// is serializing the read-modify-write itself across concurrent writers —
// exactly the same CAS problem `createMemoryStateStore` solves with a
// single-threaded JS closure, solved here with a filesystem primitive
// instead, because two OS processes have no shared JS thread to rely on.

import { promises as fs } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

async function withLock(filePath, fn) {
  const lockPath = `${filePath}.lock`;
  const maxAttempts = 500;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await fs.mkdir(lockPath);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (attempt === maxAttempts - 1) {
        throw new Error(`file-ledger-store: could not acquire lock at ${lockPath} after ${maxAttempts} attempts`);
      }
      await sleep(2 + Math.floor(Math.random() * 5)); // jittered — avoid lockstep contention across processes
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rmdir(lockPath);
  }
}

// `JSON.stringify(Infinity)` silently serializes to `null` — a well-known
// JSON gotcha, not part of what this harness is trying to prove. A
// `totalExtraAttempts` of `Number.POSITIVE_INFINITY` (the explicit
// "unlimited" declaration — see `retry-ledger.ts`) must round-trip through
// this file exactly, so it gets a sentinel string instead of being lost.
function toJsonSafe(value) {
  if (value === Number.POSITIVE_INFINITY) return "__Infinity__";
  if (value === Number.NEGATIVE_INFINITY) return "__-Infinity__";
  return value;
}
function fromJsonSafe(value) {
  if (value === "__Infinity__") return Number.POSITIVE_INFINITY;
  if (value === "__-Infinity__") return Number.NEGATIVE_INFINITY;
  return value;
}

async function readAll(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw, (_key, value) => fromJsonSafe(value));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function writeAll(filePath, data) {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await fs.writeFile(
    tmpPath,
    JSON.stringify(data, (_key, value) => toJsonSafe(value)),
  );
  await fs.rename(tmpPath, filePath);
}

/** @returns {import("../../../src/ledger-store.js").LedgerStore} */
export function createFileLedgerStore(filePath) {
  return {
    async get(operationId) {
      const all = await readAll(filePath);
      return all[operationId];
    },

    async initialize(operationId, totalExtraAttempts) {
      return withLock(filePath, async () => {
        const all = await readAll(filePath);
        const existing = all[operationId];
        if (existing) {
          if (existing.totalExtraAttempts === totalExtraAttempts) {
            return { _tag: "Ok", value: existing };
          }
          return { _tag: "Err", error: { type: "ALREADY_INITIALIZED_WITH_DIFFERENT_BUDGET", existing } };
        }
        const record = { operationId, totalExtraAttempts, drawn: 0 };
        all[operationId] = record;
        await writeAll(filePath, all);
        return { _tag: "Ok", value: record };
      });
    },

    async draw(operationId, want) {
      return withLock(filePath, async () => {
        const all = await readAll(filePath);
        const existing = all[operationId];
        if (!existing) {
          return { _tag: "Err", error: { type: "NOT_INITIALIZED", operationId } };
        }
        const remainingBefore = existing.totalExtraAttempts - existing.drawn;
        if (want <= 0) {
          return { _tag: "Ok", value: { granted: 0, remaining: remainingBefore } };
        }
        const granted = Math.min(want, remainingBefore);
        all[operationId] = { ...existing, drawn: existing.drawn + granted };
        await writeAll(filePath, all);
        return { _tag: "Ok", value: { granted, remaining: remainingBefore - granted } };
      });
    },
  };
}
