// Round 0 headroom probe — a standalone Node process (not a vitest worker,
// not a shared V8 heap) that constructs a `RetryLedger` the exact same way
// any step author would: `createRetryLedger(totalExtraAttempts)`, imported
// from the REAL built package (`@phyxiusjs/durable-step`, resolved through
// the workspace symlink to `dist/index.js` — the actual published artifact,
// not a copy of its logic).
//
// This script is forked twice by the round-0 test with IDENTICAL arguments
// — both processes believe they are drawing from "the same" conserved
// budget for "the same" operation, the way a crashed-and-resumed worker
// would. There is no channel between them: no shared memory, no file, no
// socket, nothing. Each process's result is reported back to the parent
// over the fork's IPC channel purely as a JSON value (a number), which is
// legitimate — the point under test is whether the LEDGER'S BALANCE
// survives the process boundary, not whether processes can exchange
// messages at all (obviously they can; that's not what's being tested).
import { createRetryLedger } from "@phyxiusjs/durable-step";

const totalExtraAttempts = Number(process.argv[2]);
const want = Number(process.argv[3]);

const ledger = createRetryLedger(totalExtraAttempts);
const granted = ledger.draw(want);
const remaining = ledger.remaining();

process.send({ pid: process.pid, granted, remaining });
