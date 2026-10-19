// MVP-05/MVP-08: disposable LiteSVM, source-built SBF and synthetic accounts only.
import { getMintToInstruction, getTransferCheckedInstruction } from "@solana-program/token";
import { getBase64EncodedWireTransaction, getSignatureFromTransaction, lamports } from "@solana/kit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { submitReclaim } from "../src/reclaim.ts";
import { FileSubmissionJournal } from "../src/submission-journal.ts";
import { authorizePayload, refundPayload } from "../src/transactions.ts";
import { createHarness, DC, DR, inspect, type Harness } from "./fixture.ts";

let h: Harness | undefined;
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await h?.close(); h = undefined;
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function fixture(atomic = false, captureAmount = 650_000n) {
  const harness = h = await createHarness();
  harness.ok(await harness.direct([getMintToInstruction({ mint: harness.mint, token: await harness.payerAta(),
    mintAuthority: harness.setup, amount: 2_000_000n })]));
  const requirements = harness.requirements({ amount: "1000000" });
  const settle = (payload: Record<string, unknown>) => harness.facilitator.settle(harness.body(payload, requirements));
  const salt = harness.newSalt(), payment = await harness.paymentFor(salt);
  expect((await settle(authorizePayload(await harness.signedAuthorize({ salt, maximum: 1_000_000n })))).success).toBe(true);
  expect((await settle(await harness.capture(payment, captureAmount, atomic, 1_000_000n, 0n))).success).toBe(true);
  const dir = mkdtempSync(join(tmpdir(), "capture402-offline-reclaim-")); directories.push(dir);
  const journal = new FileSubmissionJournal(dir);
  const reclaim = (submissionJournal = journal) => submitReclaim({ ledger: harness.ledger, programId: harness.facilitator.programId,
    payer: harness.payer, payment, lifetime: harness.lifetime(), journal: submissionJournal });
  return { h: harness, payment, dir, journal, reclaim, settle };
}

test("deadline alone moves nothing; payer-only reclaim returns 0.35 while preserving the 0.65 capture", async () => {
  const f = await fixture(), payer = await f.h.payerAta(), merchant = await f.h.serverAta(), vault = await f.h.vault(f.payment);
  const before = { payer: f.h.tokens(payer), merchant: f.h.tokens(merchant), vault: f.h.tokens(vault) };
  const calls = f.h.ledger.submissions.length;
  f.h.setTime(DC - 1n);
  await expect(f.reclaim()).rejects.toThrow(/captureDeadline/);
  expect(f.journal.list()).toHaveLength(0);
  f.h.setTime(DC);
  expect(f.h.state(f.payment)).toMatchObject({ held: 350_000n, refundable: 650_000n });
  expect(f.h.tokens(payer)).toBe(before.payer);
  const merchantRoute = vi.spyOn(f.h.facilitator, "settle");
  const outcome = await f.reclaim();
  expect(outcome.result).toMatchObject({ kind: "submitted", outcome: { status: "succeeded", commitment: "finalized" } });
  expect(inspect(f.h.ledger.submissions.at(-1)!.transaction)).toMatchObject({ feePayer: f.h.payer.address, signers: [f.h.payer.address] });
  expect(merchantRoute).not.toHaveBeenCalled();
  expect(f.h.ledger.submissions).toHaveLength(calls + 1);
  expect(f.h.tokens(payer)).toBe(before.payer + 350_000n);
  expect(f.h.tokens(merchant)).toBe(before.merchant);
  expect(f.h.tokens(vault)).toBe(before.vault - 350_000n);
  expect(f.h.state(f.payment)).toMatchObject({ held: 0n, refundable: 650_000n, maximum: 1_000_000n });
  expect(f.journal.read(outcome.signature)).toMatchObject({ expectedHeld: "350000", expectedRefundable: "650000",
    attempts: [{ outcome: { result: "finalized-succeeded" } }] });
});

test("payer SOL shortage refuses unsigned simulation before journal reservation or submission", async () => {
  const f = await fixture(); f.h.setTime(DC);
  const account = f.h.svm.getAccount(f.h.payer.address);
  if (!account.exists) throw new Error("synthetic payer account missing");
  f.h.svm.setAccount({ ...account, address: f.h.payer.address, lamports: lamports(0n) });
  const before = await f.h.snapshot(f.payment), calls = f.h.ledger.submissions.length;
  await expect(f.reclaim()).rejects.toThrow(/simulation failed/);
  expect(f.h.ledger.simulated.at(-1)!.signatures[f.h.payer.address]).toBeNull();
  expect(f.journal.list()).toHaveLength(0);
  expect(f.h.ledger.submissions).toHaveLength(calls);
  expect(await f.h.snapshot(f.payment)).toBe(before);
});

test("a different payer refuses reclaim before submission", async () => {
  const f = await fixture(); f.h.setTime(DC);
  const before = await f.h.snapshot(f.payment), calls = f.h.ledger.submissions.length;
  await expect(submitReclaim({ ledger: f.h.ledger, programId: f.h.facilitator.programId, payer: f.h.outsider,
    payment: f.payment, lifetime: f.h.lifetime(), journal: f.journal })).rejects.toThrow(/not this payer/);
  expect(f.journal.list()).toHaveLength(0);
  expect(f.h.ledger.submissions).toHaveLength(calls);
  expect(await f.h.snapshot(f.payment)).toBe(before);
});

test("zero hold after full capture is not a reclaim receipt or proof of payer repayment", async () => {
  const f = await fixture(false, 1_000_000n); f.h.setTime(DC);
  const before = await f.h.snapshot(f.payment), calls = f.h.ledger.submissions.length;
  await expect(f.reclaim()).rejects.toThrow(/positive remaining hold/);
  expect(f.h.state(f.payment)).toMatchObject({ held: 0n, refundable: 1_000_000n });
  expect(f.journal.list()).toHaveLength(0);
  expect(f.h.ledger.submissions).toHaveLength(calls);
  expect(await f.h.snapshot(f.payment)).toBe(before);
});

test("lost reclaim response retains the exact original wire and never creates a successor", async () => {
  const f = await fixture(); f.h.setTime(DC);
  const submit = f.h.ledger.submit.bind(f.h.ledger), calls = f.h.ledger.submissions.length;
  vi.spyOn(f.h.ledger, "submit").mockImplementation(async tx => { await submit(tx); throw new Error("synthetic response lost"); });
  await expect(f.reclaim()).rejects.toThrow(/response lost/);
  const original = f.journal.list()[0]!;
  const sent = f.h.ledger.submissions.at(-1)!;
  expect(original.transactionBase64).toBe(getBase64EncodedWireTransaction(sent.transaction));
  expect(original.signature).toBe(getSignatureFromTransaction(sent.transaction));
  expect(original).toMatchObject({ operation: "reclaim", expectedHeld: "350000", expectedRefundable: "650000",
    attempts: [{ outcome: { result: "submit-threw" } }] });
  f.h.svm.expireBlockhash();
  const restored = new FileSubmissionJournal(f.dir);
  expect(restored.list()).toEqual([original]);
  await expect(f.reclaim(restored)).rejects.toThrow(/positive remaining hold/);
  expect(restored.list()).toEqual([original]);
  expect(f.h.ledger.submissions).toHaveLength(calls + 1);
  // Account state is insufficient to resolve the lost original; its journal still says submit-threw.
  expect(f.h.state(f.payment)).toMatchObject({ held: 0n, refundable: 650_000n });
});

test("ambiguous reclaim with positive H stays blocked after journal reopen and a new blockhash", async () => {
  const f = await fixture(); f.h.setTime(DC);
  const before = await f.h.snapshot(f.payment), calls = f.h.ledger.submissions.length;
  // Neither a landing nor non-execution was proved; the adapter has no terminal outcome.
  const submit = vi.spyOn(f.h.ledger, "submit").mockResolvedValue({ kind: "submitted" });
  const first = await f.reclaim(), original = f.journal.read(first.signature)!;
  expect(first.result).toEqual({ kind: "submitted" });
  expect(original.transactionBase64).toBe(getBase64EncodedWireTransaction(submit.mock.calls[0]![0]));
  expect(original.signature).toBe(getSignatureFromTransaction(submit.mock.calls[0]![0]));
  expect(original.attempts[0]?.outcome?.result).toBe("unresolved");
  const restored = new FileSubmissionJournal(f.dir);
  expect(restored.list()).toEqual([original]);
  f.h.svm.expireBlockhash();
  await expect(f.reclaim(restored)).rejects.toThrow(/reconciliation/);
  expect(submit).toHaveBeenCalledTimes(1);
  expect(restored.list()).toEqual([original]);
  expect(f.h.ledger.submissions).toHaveLength(calls);
  expect(await f.h.snapshot(f.payment)).toBe(before);
  expect(f.h.state(f.payment)).toMatchObject({ held: 350_000n, refundable: 650_000n });
});

test("merchant refund after reclaim transfers merchant funds without reopening H or maximum", async () => {
  const f = await fixture(); f.h.setTime(DC); await f.reclaim();
  const payer = await f.h.payerAta(), merchant = await f.h.serverAta(), vault = await f.h.vault(f.payment);
  const before = { payer: f.h.tokens(payer), merchant: f.h.tokens(merchant), vault: f.h.tokens(vault) };
  expect((await f.settle(await f.h.refund(f.payment, 100_000n, 0n, 650_000n))).success).toBe(true);
  expect(f.h.tokens(payer)).toBe(before.payer + 100_000n);
  expect(f.h.tokens(merchant)).toBe(before.merchant - 100_000n);
  expect(f.h.tokens(vault)).toBe(before.vault);
  expect(f.h.state(f.payment)).toMatchObject({ held: 0n, refundable: 550_000n, maximum: 1_000_000n });
  expect(inspect(f.h.ledger.submissions.at(-1)!.transaction).signers).toContain(f.h.server.address);
});

test("refund without merchant authority is rejected before submission", async () => {
  const f = await fixture(true), before = await f.h.snapshot(f.payment), calls = f.h.ledger.submissions.length;
  const tx = await f.h.signedRefund(f.payment, 100_000n, 0n, 650_000n, []);
  expect((await f.settle(refundPayload(f.payment, tx, 100_000n, 0n, 650_000n))).success).toBe(false);
  expect(f.h.ledger.submissions).toHaveLength(calls);
  expect(await f.h.snapshot(f.payment)).toBe(before);
});

test("merchant liquidity shortage rejects refund before send and preserves captured funds", async () => {
  const f = await fixture(true), merchant = await f.h.serverAta();
  f.h.ok(await f.h.direct([getTransferCheckedInstruction({ source: merchant, mint: f.h.mint, destination: await f.h.payerAta(),
    authority: f.h.server, amount: f.h.tokens(merchant), decimals: 6 })], [f.h.server]));
  const before = await f.h.snapshot(f.payment), calls = f.h.ledger.submissions.length;
  expect((await f.settle(await f.h.refund(f.payment, 100_000n, 0n, 650_000n))).success).toBe(false);
  expect(f.h.ledger.submissions).toHaveLength(calls);
  expect(await f.h.snapshot(f.payment)).toBe(before);
  expect(f.h.state(f.payment)).toMatchObject({ held: 0n, refundable: 650_000n });
});

test("refund deadline is strict and refuses before send", async () => {
  const f = await fixture(true); f.h.setTime(DR);
  const before = await f.h.snapshot(f.payment), calls = f.h.ledger.submissions.length;
  expect((await f.settle(await f.h.refund(f.payment, 100_000n, 0n, 650_000n))).success).toBe(false);
  expect(f.h.ledger.submissions).toHaveLength(calls);
  expect(await f.h.snapshot(f.payment)).toBe(before);
});
