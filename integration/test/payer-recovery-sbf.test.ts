// Disposable economic fixtures: unchanged accepted SBF, synthetic RPC proof labels only.
import { getMintToInstruction } from "@solana-program/token";
import { getBase64Encoder, getTransactionDecoder, getSignatureFromTransaction } from "@solana/kit";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { FailedTransactionMetadata } from "litesvm";
import { createHarness, type Harness, BINARY_SHA256 } from "./fixture.ts";
import { payerFixture } from "./fixtures/payer-recovery-fixture.ts";
import { submitPayerRecovery } from "../src/payer-recovery.ts";
import { ata } from "../src/program.ts";
import { buildTransaction, captureInstruction, voidInstruction, reclaimInstruction, refundInstruction } from "../src/transactions.ts";
let h: Harness | undefined; const roots: string[] = [];
afterEach(async () => { await h?.close(); h = undefined; for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
async function fixture(captured = false) {
  h = await createHarness(); h.setTime(900n);
  h.ok(await h.direct([getMintToInstruction({ mint: h.mint, token: await ata(h.payer.address, h.mint), mintAuthority: h.setup, amount: 200000000n })]));
  const f = await payerFixture({ payer: h.payer, merchant: h.server, sponsor: h.facilitatorKey, mint: h.mint, blockhash: h.svm.latestBlockhash() }); roots.push(f.root);
  const decode = (wire: string) => getTransactionDecoder().decode(getBase64Encoder().encode(wire));
  const auth = JSON.parse(readFileSync(join(f.paths.facilitator, f.authSignature + ".json"), "utf8"));
  expect(await h.ledger.submit(decode(auth.transactionBase64))).toMatchObject({ kind: "submitted", outcome: { status: "succeeded" } });
  const capture = JSON.parse(readFileSync(f.captureJournal, "utf8"));
  if (captured) expect(await h.ledger.submit(decode(capture.transactionBase64))).toMatchObject({ kind: "submitted", outcome: { status: "succeeded" } });
  h.svm.expireBlockhash(); h.setTime(1000n); f.lifetime.blockhash = h.svm.latestBlockhash();
  f.recoveryReader.getFinalizedBlockhashStatus = async (hash, origin) => ({ kind: "ok", valid: hash === h!.svm.latestBlockhash(), slot: origin > 41n ? origin : 41n });
  f.recoveryReader.getAccountAtLeast = async (address, minimum) => ({ kind: "ok", slot: minimum > 42n ? minimum : 42n, account: await h!.ledger.getAccount(address) });
  f.recoveryReader.getClockAtLeast = async minimum => ({ kind: "ok", commitment: "finalized", slot: minimum > 43n ? minimum : 43n, unixTimestamp: await h!.ledger.now() });
  const backend = { simulate: h.ledger.simulate.bind(h.ledger), submit: h.ledger.submit.bind(h.ledger) };
  console.log(JSON.stringify({ binarySha256: BINARY_SHA256, profile: "disposable LiteSVM; synthetic canonical-chain labels are not RPC proof" }));
  return { f, backend, common: { programId: f.identity.programId, payment: f.order.payment, payer: h.payer.address, server: h.server.address, mint: h.mint } };
}
test.each([false, true])("SBF reclaim recovers only current H after historical capture %s; F remains and merchant block stays", async captured => {
  const { f, backend } = await fixture(captured), before = h!.state(f.order.payment), req = await f.request();
  expect(req.offer.held).toBe(captured ? "60000000" : "100000000");
  const first = await submitPayerRecovery({ ...req, backend });
  expect(first.result).toMatchObject({ kind: "submitted", outcome: { status: "succeeded", commitment: "finalized" } });
  expect(h!.state(f.order.payment)).toMatchObject({ held: 0n, refundable: before.refundable });
  await expect(submitPayerRecovery({ ...req, backend })).rejects.toThrow();
  expect(h!.ledger.submissions.filter(s => s.signature === first.signature)).toHaveLength(1);
  expect(readFileSync(f.busyPath, "utf8")).toBe("beer"); expect(JSON.parse(readFileSync(f.path, "utf8")).events[1].status).toBe("pending");
});
test.each(["capture", "void", "reclaim", "refund"])("actual SBF %s race preserves at most one H release and independent F semantics", async race => {
  const { f, backend, common } = await fixture(race === "refund"), req = await f.request();
  let raced = false;
  h!.ledger.beforeSubmit = async () => {
    if (raced) return; raced = true;
    const p = h!.state(common.payment), instruction = race === "capture" ? await captureInstruction(common, 40000000n, false, p.held, p.refundable) :
      race === "void" ? await voidInstruction(common, p.held, p.refundable) : race === "refund" ? await refundInstruction(common, 10000000n, p.held, p.refundable) : await reclaimInstruction(common);
    const payerDirect = race === "reclaim";
    const tx = await buildTransaction({ feePayer: payerDirect ? h!.outsider.address : h!.facilitatorKey.address, instructions: [instruction], signers: payerDirect ? [h!.payer, h!.outsider] : [h!.server, h!.facilitatorKey], lifetime: h!.lifetime() });
    const result = h!.svm.sendTransaction(tx);
    expect(result instanceof FailedTransactionMetadata).toBe(race === "capture"); // Dc is strict for new captures
  };
  const first = await submitPayerRecovery({ ...req, backend });
  expect(first.result).toMatchObject({ kind: "submitted", outcome: { status: race === "void" || race === "reclaim" ? "failed" : "succeeded" } });
  expect(h!.state(common.payment)).toMatchObject({ held: 0n, refundable: race === "refund" ? 30000000n : 0n });
  expect(h!.ledger.submissions.filter(s => s.signature === first.signature)).toHaveLength(1);
  expect(getSignatureFromTransaction(getTransactionDecoder().decode(getBase64Encoder().encode(req.transactionBase64)))).toBe(first.signature);
});
