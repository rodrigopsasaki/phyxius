// A standalone Node process — forked fresh by the round-2 test, sharing no
// memory, no module cache, and no JS object with the parent test process
// or with any other worker. It imports the REAL built `@phyxiusjs/durable-step`
// package (through the workspace symlink to `dist/index.js`) and a
// file-backed `LedgerStore` (`file-ledger-store.mjs`, a sibling of this
// file). This is what "a step interrupted mid-flight and revived by a
// different worker" looks like concretely: the only things this process
// was handed are argv strings — a file path and an operationId — exactly
// the kind of small, serializable "handle" a context scope or a queue
// message could carry across a real process hop.
import { createDurableRetryLedger } from "@phyxiusjs/durable-step";

import { createFileLedgerStore } from "./file-ledger-store.mjs";

const [, , filePath, operationId, initBudgetOrSkip, wantToDrawRaw] = process.argv;
const wantToDraw = Number(wantToDrawRaw);

const store = createFileLedgerStore(filePath);

let initResult = null;
if (initBudgetOrSkip !== "skip") {
  const result = await store.initialize(operationId, Number(initBudgetOrSkip));
  initResult = result._tag === "Ok" ? { ok: true } : { ok: false, error: result.error };
}

const ledger = createDurableRetryLedger(store, operationId);

let granted = null;
let drawError = null;
try {
  granted = await ledger.draw(wantToDraw);
} catch (error) {
  drawError = { name: error?.name, operationId: error?.operationId };
}

const remainingAfterRaw = await ledger.remaining();
// `process.send` JSON-serializes the message internally, and
// `JSON.stringify(Infinity)` silently becomes `null` — the same gotcha
// `file-ledger-store.mjs` guards against for the file itself. Guard the
// IPC hop too, rather than let a correct in-process `Infinity` arrive at
// the parent as a misleading `null`.
const remainingAfter =
  typeof remainingAfterRaw === "number" && !Number.isFinite(remainingAfterRaw)
    ? String(remainingAfterRaw) // "Infinity" / "-Infinity"
    : remainingAfterRaw;

process.send({
  pid: process.pid,
  initResult,
  granted,
  drawError,
  remainingAfter,
});
