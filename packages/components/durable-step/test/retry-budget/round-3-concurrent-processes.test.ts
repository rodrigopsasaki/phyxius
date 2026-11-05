// ── Round 3 (retry-budget find-shape) ───────────────────────────────────
//
// Change:      None to the mechanism — this round stress-tests round 2's
//              file-lock CAS under GENUINE concurrent contention from real
//              OS processes, launched simultaneously (`Promise.all`, not
//              sequential `await`s). Round 2 only proved sequential
//              handoff (A finishes, THEN B starts) — the "crash and
//              resume" story. Real distributed systems also produce
//              split-brain: an orchestrator that believes a worker died
//              launches a replacement while the "dead" worker is actually
//              still running, and both draw from the SAME budget at
//              nearly the same instant.
//
// Hypothesis:  If the file-lock's CAS genuinely serializes
//              read-modify-write across concurrent OS processes (not just
//              concurrent JS callbacks in one event loop, which was all
//              the in-memory store from round 1 ever had to survive), then
//              N processes racing to draw from the same finite budget,
//              launched at the same instant, still never grant more in
//              total than the budget declares — regardless of how the
//              race resolves. This is the sharpest test of whether "CAS"
//              in `LedgerStore`'s doc comment is actually true under real
//              concurrency or only ever exercised sequentially so far.

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
  readonly remainingAfter: number | "unknown" | "Infinity";
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
  tmpDir = await mkdtemp(join(tmpdir(), "phyxius-ledger-race-"));
  ledgerFile = join(tmpDir, "ledger.json");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("round 3 — the CAS holds under genuinely concurrent, not just sequential, process contention", () => {
  it("[split-brain draw] 5 processes race simultaneously for a budget of 3, each wanting 2 — total granted across ALL of them never exceeds 3", async () => {
    await runWorker(ledgerFile, "op-split-brain", "3", 0); // declare the budget, draw nothing yet

    const RACERS = 5;
    const reports = await Promise.all(
      Array.from({ length: RACERS }, () => runWorker(ledgerFile, "op-split-brain", "skip", 2)),
    );

    const pids = new Set(reports.map((r) => r.pid));
    expect(pids.size).toBe(RACERS); // genuinely 5 distinct OS processes, not 5 reports from one

    const totalGranted = reports.reduce((sum, r) => sum + (r.granted ?? 0), 0);
    expect(totalGranted).toBe(3); // the full budget was distributed, but NEVER exceeded

    // Every grant is individually well-formed too — no process saw a
    // negative or fractional share from a corrupted read-modify-write.
    for (const r of reports) {
      expect(r.granted).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(r.granted)).toBe(true);
    }
  });

  it("[split-brain initialize, agreeing values] 5 processes race to be first to declare the SAME budget — idempotent, no corruption, drawn stays 0", async () => {
    const RACERS = 5;
    const reports = await Promise.all(
      Array.from({ length: RACERS }, () => runWorker(ledgerFile, "op-split-brain-init-agree", "7", 0)),
    );

    // Every racer sees success — whichever one's write actually lands, the
    // other four's re-declaration of the SAME number is an idempotent
    // no-op, not a conflict.
    for (const r of reports) {
      expect(r.initResult).toEqual({ ok: true });
    }

    // Exactly one consistent record exists afterward — not a torn write
    // from two processes' `rename()`s landing interleaved.
    const finalDraw = await runWorker(ledgerFile, "op-split-brain-init-agree", "skip", 7);
    expect(finalDraw.granted).toBe(7); // the full, uncorrupted budget — not 0, not more than declared
  });

  it("[split-brain initialize, disagreeing values] processes racing with DIFFERENT declared budgets converge on exactly one winner, not a hybrid", async () => {
    const reports = await Promise.all([
      runWorker(ledgerFile, "op-split-brain-init-disagree", "3", 0),
      runWorker(ledgerFile, "op-split-brain-init-disagree", "300", 0),
    ]);

    const oks = reports.filter((r) => r.initResult?.ok === true);
    const refusals = reports.filter((r) => r.initResult?.ok === false);

    // Exactly one value won — never both silently accepted (which would
    // mean the LOSER'S write overwrote the winner's, corrupting the
    // budget upward or downward with no refusal at all), and never a
    // hybrid/averaged value.
    expect(oks.length).toBe(1);
    expect(refusals.length).toBe(1);

    const probe = await runWorker(ledgerFile, "op-split-brain-init-disagree", "skip", 1_000);
    // The granted amount reveals which of {3, 300} actually won — either
    // is a legitimate race outcome (the lock doesn't promise ordering),
    // but it MUST be exactly one of the two declared numbers, never a
    // corrupted third value.
    expect([3, 300]).toContain(probe.granted);
  });
});
