// ── Round 2 (retry-budget find-shape) ───────────────────────────────────
//
// Change:      A test-only `LedgerStore` implementation backed by a real
//              file on disk (`support/file-ledger-store.mjs`), CAS'd via a
//              directory-mutex lock — no shared memory, no shared module
//              cache, nothing but a file path. Exercised from genuinely
//              separate `child_process.fork()`ed Node processes (not
//              worker_threads, not two objects in one heap) via
//              `support/durable-ledger-worker.mjs`, which imports the REAL
//              built `@phyxiusjs/durable-step` package.
//
// Hypothesis:  Round 0's headroom probe #3 proved that the PUBLISHED
//              (pre-round-1) `createRetryLedger` mints a full fresh budget
//              on every process hop, deterministically, because its
//              interface gave a second process no way to even ask about
//              the first's state. Round 1 reshaped the interface to be
//              async and keyed by `operationId`, but only proved that
//              shape works with an in-memory store — still one process.
//              If a worker resumed in a genuinely different OS process,
//              handed only a file path and an operationId (the smallest
//              possible "handle," exactly what a context scope or a queue
//              message could carry across a real hop), draws from the SAME
//              conserved pool its predecessor already partially spent —
//              not a fresh one — then the shape closes the fitness
//              question's process-hop half for real, not just in theory.

import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerPath = join(__dirname, "support", "durable-ledger-worker.mjs");

interface WorkerReport {
  readonly pid: number;
  readonly initResult: { readonly ok: boolean; readonly error?: unknown } | null;
  readonly granted: number | null;
  readonly drawError: { readonly name?: string; readonly operationId?: string } | null;
  readonly remainingAfter: number | "unknown" | "Infinity" | "-Infinity";
}

function runWorker(
  filePath: string,
  operationId: string,
  initBudgetOrSkip: string,
  wantToDraw: number,
): Promise<WorkerReport> {
  return new Promise((resolve, reject) => {
    const child = fork(workerPath, [filePath, operationId, initBudgetOrSkip, String(wantToDraw)], { stdio: "pipe" });
    child.on("message", (msg) => resolve(msg as WorkerReport));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error(`worker exited with code ${code}`));
    });
  });
}

let tmpDir: string;
let ledgerFile: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "phyxius-ledger-"));
  ledgerFile = join(tmpDir, "ledger.json");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("round 2 — the same conserved pool survives a genuine process hop", () => {
  it("[closes round 0 headroom probe #3] worker A draws 2 of 3 and 'crashes'; worker B, a DIFFERENT OS process, resumes and draws only what's left", async () => {
    const workerA = await runWorker(ledgerFile, "op-revival-1", "3", 2);
    expect(workerA.granted).toBe(2);
    expect(workerA.remainingAfter).toBe(1);

    // "Worker A crashed" is modeled by simply never running it again — its
    // process already exited after reporting back. Worker B is handed
    // NOTHING from worker A directly: only the same file path (which in a
    // real deployment would be "the same Postgres connection string") and
    // the same operationId (which would come from the job/queue record
    // that triggered the revival, not from worker A's memory). It does
    // NOT re-initialize — "skip" — because re-declaring is the climb
    // orchestrator's job, not a resuming step's.
    const workerB = await runWorker(ledgerFile, "op-revival-1", "skip", 3);

    expect(workerA.pid).not.toBe(workerB.pid);
    expect(workerB.granted).toBe(1); // NOT 3 — the true remainder, not a fresh grant
    expect(workerB.remainingAfter).toBe(0);

    // Combined across BOTH real, independent OS processes: exactly 3
    // extra attempts granted — the declared budget, never minted past it.
    expect((workerA.granted ?? 0) + (workerB.granted ?? 0)).toBe(3);
  });

  it("a later process attempting to re-declare the SAME operation with a DIFFERENT budget is refused, even across the process boundary", async () => {
    const first = await runWorker(ledgerFile, "op-revival-2", "3", 0);
    expect(first.initResult).toEqual({ ok: true });

    const impostor = await runWorker(ledgerFile, "op-revival-2", "999", 0);
    expect(impostor.initResult?.ok).toBe(false);
    expect((impostor.initResult?.error as { type?: string } | undefined)?.type).toBe(
      "ALREADY_INITIALIZED_WITH_DIFFERENT_BUDGET",
    );

    // And the original budget is intact for a THIRD, honest process.
    const honestResumer = await runWorker(ledgerFile, "op-revival-2", "skip", 3);
    expect(honestResumer.granted).toBe(3);
  });

  it("[unknown survives the hop too] a worker asking about an operation nobody has EVER declared, on a store nobody has written to, sees 'unknown' — not 0, not unlimited", async () => {
    const worker = await runWorker(ledgerFile, "op-never-declared-anywhere", "skip", 5);

    expect(worker.granted).toBeNull();
    expect(worker.drawError?.name).toBe("LedgerNotInitializedError");
    expect(worker.drawError?.operationId).toBe("op-never-declared-anywhere");
    expect(worker.remainingAfter).toBe("unknown");
  });

  it("sanity: an unlimited operation grants a revived worker's full request too, explicitly, not merely by omission", async () => {
    const workerA = await runWorker(ledgerFile, "op-unlimited-revival", String(Number.POSITIVE_INFINITY), 10);
    expect(workerA.granted).toBe(10);

    const workerB = await runWorker(ledgerFile, "op-unlimited-revival", "skip", 1_000_000);
    expect(workerB.granted).toBe(1_000_000);
    // "Infinity" — a string, not the number — is the IPC-safe encoding
    // `durable-ledger-worker.mjs` sends back; see its own comment.
    expect(workerB.remainingAfter).toBe("Infinity");
  });
});
