import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBase64Encoder, getBase64EncodedWireTransaction, getSignatureFromTransaction, getTransactionDecoder, partiallySignTransaction, signBytes } from "@solana/kit";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { parseReclaimOfferCommand, reclaimOfferMain } from "../src/reclaim-offer-cli.ts";
import { createReclaimOffer, reclaimOfferDigest, submitReclaimOffer, type ReclaimOffer } from "../src/reclaim-offer.ts";
import type { PayerRecoveryReader } from "../src/payer-recovery.ts";
import { FIXTURE_GENESIS, FIXTURE_NETWORK } from "../src/recovery-enrollment.ts";
import { FileSubmissionJournal } from "../src/submission-journal.ts";
import { DC, NOW, createHarness, type Harness } from "./fixture.ts";

let h: Harness;
const dirs: string[] = [];
beforeAll(async () => { h = await createHarness(); });
afterAll(async () => { await h.close(); for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
afterEach(() => { h.setTime(NOW); h.ledger.beforeRead = undefined; h.ledger.beforeSimulate = undefined; h.ledger.beforeSubmit = undefined; });
async function setup(capture = 0n) {
  const payment = await h.authorized();
  if (capture) expect((await h.facilitator.settle(h.body(await h.capture(payment, capture, false, 100n, 0n)))).success).toBe(true);
  h.setTime(DC);
  const identity = { network: FIXTURE_NETWORK, genesisHash: FIXTURE_GENESIS, programId: h.facilitator.programId };
  const reader: PayerRecoveryReader = {
    verifyIdentity: async () => identity,
    getAccountAtLeast: async (address, minimum) => ({ kind: "ok", slot: minimum > 42n ? minimum : 42n, account: await h.ledger.getAccount(address) }),
    getClockAtLeast: async minimum => ({ kind: "ok", commitment: "finalized", slot: minimum, unixTimestamp: await h.ledger.now() }),
    verifyBlockhashOrigin: async (blockhash, candidate, genesisHash, network) => ({ state: "verified", commitment: "finalized", blockhash, slot: candidate.toString(), genesisHash, network }),
    getFinalizedBlockhashStatus: async () => ({ kind: "ok", valid: true, slot: 100n }),
    getSignatureStatus: async () => ({ kind: "not-found", observedSlot: 100n }),
    findSignaturesByMessage: async () => { throw new Error("original signature only"); },
    isBlockhashValid: async () => ({ kind: "ok", valid: true, slot: 100n }),
  };
  const lifetime = { ...h.lifetime(), blockhashSlot: 1n, contextSlot: 1n, commitment: "finalized" as const, network: identity.network, genesisHash: identity.genesisHash };
  const dir = mkdtempSync(join(tmpdir(), "reclaim-wallet-offer-")); dirs.push(dir);
  const journal = new FileSubmissionJournal(dir);
  const backend = { simulate: vi.fn(async (tx: Parameters<typeof h.ledger.simulate>[0]) => {
    expect(Object.values(tx.signatures).every(value => value === null)).toBe(true);
    return h.ledger.simulate(tx);
  }), submit: vi.fn(async (tx: Parameters<typeof h.ledger.submit>[0]) => {
    expect(journal.read(getSignatureFromTransaction(tx))?.transactionBase64).toBe(getBase64EncodedWireTransaction(tx));
    return h.ledger.submit(tx);
  }) };
  const options = { identity, reader };
  const offer = () => createReclaimOffer({ ...options, payment, payer: h.payer.address, lifetime });
  async function signed(value: ReclaimOffer, signer = h.payer) {
    return getBase64EncodedWireTransaction(await partiallySignTransaction([signer.keyPair], getTransactionDecoder().decode(getBase64Encoder().encode(value.unsignedBase64))));
  }
  function consent(value: ReclaimOffer) { return { accept: true as const, offerSha256: reclaimOfferDigest(value), payment: value.payment, payer: value.payer }; }
  async function request() { const value = await offer(); return { ...options, offer: value, consent: consent(value), transactionBase64: String(await signed(value)), journal, backend }; }
  return { ...options, payment, lifetime, dir, journal, backend, offer, signed, consent, request };
}

test("wallet-signed reclaim returns current H and preserves captured F over the accepted SBF", async () => {
  const c = await setup(40n), args = await c.request();
  expect(args.offer).toMatchObject({ held: "60", refundable: "40", captureDeadline: DC.toString() });
  expect(c.journal.list()).toHaveLength(0);
  const result = await submitReclaimOffer(args);
  expect(result.result).toMatchObject({ kind: "submitted", outcome: { status: "succeeded", commitment: "finalized" } });
  expect(h.state(c.payment)).toMatchObject({ held: 0n, refundable: 40n });
  expect(c.backend.submit).toHaveBeenCalledTimes(1);
  expect(c.journal.read(result.signature)?.attempts[0]?.outcome?.result).toBe("finalized-succeeded");
});
test("preparation refuses before Dc and does not reserve or simulate", async () => {
  const c = await setup(); h.setTime(DC - 1n);
  await expect(c.offer()).rejects.toThrow(/reclaim offer refused/);
  expect(c.journal.list()).toHaveLength(0); expect(c.backend.simulate).not.toHaveBeenCalled();
});
test.each(["wrong-payer", "identity", "owner", "executable", "pda", "stale-account", "stale-clock", "unavailable-clock", "origin", "expired"])("preparation rejects %s evidence", async fault => {
  const c = await setup();
  if (fault === "identity") c.reader.verifyIdentity = async () => ({ ...c.identity, programId: h.outsider.address });
  if (["owner", "executable", "pda", "stale-account"].includes(fault)) c.reader.getAccountAtLeast = async () => {
    const original = (await h.ledger.getAccount(c.payment))!, data = new Uint8Array(original.data);
    if (fault === "pda") data[104] = data[104]! ^ 1;
    return { kind: "ok", slot: fault === "stale-account" ? 0n : 42n, account: { ...original, data, owner: fault === "owner" ? h.outsider.address : original.owner, executable: fault === "executable" } };
  };
  if (fault === "stale-clock") c.reader.getClockAtLeast = async () => ({ kind: "ok", commitment: "finalized", slot: 0n, unixTimestamp: DC });
  if (fault === "unavailable-clock") c.reader.getClockAtLeast = async () => ({ kind: "unavailable", detail: "unavailable" });
  if (fault === "origin") c.reader.verifyBlockhashOrigin = async () => ({ state: "unverified", reason: "origin-unavailable" });
  if (fault === "expired") c.reader.getFinalizedBlockhashStatus = async () => ({ kind: "ok", valid: false, slot: 100n });
  await expect(createReclaimOffer({ identity: c.identity, reader: c.reader, payment: c.payment, payer: fault === "wrong-payer" ? h.outsider.address : h.payer.address, lifetime: c.lifetime })).rejects.toThrow(/reclaim offer refused/);
  expect(c.journal.list()).toHaveLength(0); expect(c.backend.submit).not.toHaveBeenCalled();
});
test.each(["digest", "payer", "payment", "accept", "extra-field"])("submission rejects invalid %s consent before simulation", async fault => {
  const c = await setup(), args = await c.request(), consent: any = { ...args.consent };
  if (fault === "digest") consent.offerSha256 = "0".repeat(64);
  if (fault === "payer") consent.payer = h.outsider.address;
  if (fault === "payment") consent.payment = h.outsider.address;
  if (fault === "accept") consent.accept = false;
  if (fault === "extra-field") consent.retry = true;
  await expect(submitReclaimOffer({ ...args, consent })).rejects.toThrow(/reclaim offer refused/);
  expect(c.backend.simulate).not.toHaveBeenCalled(); expect(c.journal.list()).toHaveLength(0);
});
test.each(["unsigned", "foreign-signature", "changed-wire", "changed-hold", "changed-offer"])("submission rejects %s without backend access", async fault => {
  const c = await setup(), args = await c.request();
  if (fault === "unsigned") args.transactionBase64 = args.offer.unsignedBase64;
  if (fault === "foreign-signature") {
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(args.offer.unsignedBase64));
    args.transactionBase64 = getBase64EncodedWireTransaction({ ...tx, signatures: { [h.payer.address]: await signBytes(h.outsider.keyPair.privateKey, tx.messageBytes) } });
  }
  if (fault === "changed-wire") args.transactionBase64 = args.transactionBase64.slice(0, -4) + "AAAA";
  if (fault === "changed-offer") { args.offer = { ...args.offer, held: "99" }; args.consent = c.consent(args.offer); }
  if (fault === "changed-hold") c.reader.getAccountAtLeast = async (_address, minimum) => {
    const original = (await h.ledger.getAccount(c.payment))!, data = new Uint8Array(original.data); new DataView(data.buffer).setBigUint64(160, 99n, true);
    return { kind: "ok", slot: minimum, account: { ...original, data } };
  };
  await expect(submitReclaimOffer(args)).rejects.toThrow();
  expect(c.backend.simulate).not.toHaveBeenCalled(); expect(c.backend.submit).not.toHaveBeenCalled(); expect(c.journal.list()).toHaveLength(0);
});
test("state is revalidated after simulation", async () => {
  const c = await setup(), args = await c.request();
  c.backend.simulate.mockImplementation(async () => { h.setTime(DC - 1n); return { ok: true }; });
  await expect(submitReclaimOffer(args)).rejects.toThrow(/reclaim offer refused/);
  expect(c.backend.submit).not.toHaveBeenCalled(); expect(c.journal.list()).toHaveLength(0);
});
test("a simulator cannot rewrite the wallet's signed transaction bytes", async () => {
  const c = await setup(), args = await c.request();
  c.backend.simulate.mockImplementation(async tx => {
    expect(getBase64EncodedWireTransaction(tx)).toBe(args.offer.unsignedBase64);
    const bytes = tx.messageBytes as unknown as Uint8Array; bytes[0] = bytes[0]! ^ 1;
    return { ok: true };
  });
  const result = await submitReclaimOffer(args);
  expect(result.result).toMatchObject({ kind: "submitted", outcome: { status: "succeeded" } });
  expect(c.journal.read(result.signature)?.transactionBase64).toBe(args.transactionBase64);
  expect(h.state(c.payment).held).toBe(0n);
});
test("two competing wallet submissions produce one journal and one H release", async () => {
  const c = await setup(), args = await c.request(), results = await Promise.allSettled([submitReclaimOffer(args), submitReclaimOffer(args)]);
  expect(results.filter(value => value.status === "fulfilled")).toHaveLength(1);
  expect(c.backend.submit).toHaveBeenCalledTimes(1); expect(c.journal.list()).toHaveLength(1); expect(h.state(c.payment).held).toBe(0n);
});
test("lost response keeps original bytes and blocks a fresh-blockhash retry", async () => {
  const c = await setup(), args = await c.request();
  c.backend.submit.mockImplementation(async () => { throw new Error("response lost"); });
  await expect(submitReclaimOffer(args)).rejects.toThrow(/response lost/);
  const original = c.journal.list()[0]!; expect(original.transactionBase64).toBe(args.transactionBase64);
  expect(original.attempts[0]?.outcome?.result).toBe("submit-threw");
  h.svm.expireBlockhash(); Object.assign(c.lifetime, h.lifetime());
  await expect(submitReclaimOffer(await c.request())).rejects.toThrow(/reconciliation/);
  expect(c.backend.submit).toHaveBeenCalledTimes(1); expect(c.journal.read(original.signature)?.transactionBase64).toBe(args.transactionBase64);
});
test("journal write failure prevents broadcastable backend access", async () => {
  const c = await setup(), args = await c.request();
  c.journal.prepare = () => { throw new Error("disk unavailable"); };
  await expect(submitReclaimOffer(args)).rejects.toThrow(/disk unavailable/); expect(c.backend.submit).not.toHaveBeenCalled();
});
test("one deadline bounds stalled evidence and leaves no reservation", async () => {
  const c = await setup(); c.reader.verifyIdentity = () => new Promise(() => {});
  await expect(createReclaimOffer({ identity: c.identity, reader: c.reader, payment: c.payment, payer: h.payer.address, lifetime: c.lifetime, timeoutMs: 20 })).rejects.toThrow(/deadline/);
  expect(c.journal.list()).toHaveLength(0);
});
test.each([[], ["offer"], ["submit", "offer.json", "signed.json"], ["submit", "offer.json", "signed.json", "true"], ["status", "invalid"], ["retry", "anything"]].map(argv => ({ argv })))("CLI rejects incomplete/automatic-retry command %#", ({ argv }) => {
  expect(() => parseReclaimOfferCommand(argv)).toThrow(/usage/);
});
test("CLI refuses an unreviewed offer before RPC or writable-journal access", async () => {
  const c = await setup(), offer = await c.offer(), inputs = mkdtempSync(join(tmpdir(), "reclaim-cli-inputs-")); dirs.push(inputs);
  const path = join(inputs, "offer.json"); writeFileSync(path, JSON.stringify(offer));
  await expect(reclaimOfferMain(["submit", path, join(c.dir, "missing-signed.json"), "0".repeat(64)])).rejects.toThrow(/digest mismatch/);
  expect(c.journal.list()).toHaveLength(0);
});
