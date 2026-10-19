// Wallet-signed payer reclaim. Merchant state and UNKNOWN recovery admission are untouched.
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  getBase64Encoder, getBase64EncodedWireTransaction, getCompiledTransactionMessageDecoder,
  getPublicKeyFromAddress, getSignatureFromTransaction, getTransactionDecoder, isAddress,
  verifySignature, type Address, type Blockhash, type SignatureBytes,
} from "@solana/kit";
import { withShared } from "./coordination.ts";
import type { Ledger, SubmitResult } from "./ledger.ts";
import { isU64Decimal } from "./lifetime-provenance.ts";
import type { PayerRecoveryReader } from "./payer-recovery.ts";
import { decodePayment, paymentAddress } from "./program.ts";
import { strictJson } from "./quarantine-view.ts";
import type { RecoveryIdentity } from "./recovery-enrollment.ts";
import { messageHash, submissionOutcome, type SubmissionJournal } from "./submission-journal.ts";
import { buildTransaction, reclaimInstruction, type Lifetime } from "./transactions.ts";

export type ReclaimOffer = Readonly<{
  version: 1; kind: "payer-direct-reclaim"; identity: RecoveryIdentity;
  payment: Address; payer: Address; held: string; refundable: string; captureDeadline: string;
  paymentDataBase64: string; paymentSlot: string; clockSlot: string;
  lifetime: { blockhash: string; lastValidBlockHeight: string; blockhashSlot: string };
  unsignedBase64: string; messageHash: string;
}>;
export type ReclaimConsent = Readonly<{ accept: true; offerSha256: string; payment: string; payer: string }>;
type Options = { identity: RecoveryIdentity; reader: PayerRecoveryReader; timeoutMs?: number };
type Backend = {
  simulate: (transaction: Parameters<Ledger["simulate"]>[0], deadline: number) => ReturnType<Ledger["simulate"]>;
  submit: (transaction: Parameters<Ledger["submit"]>[0], deadline: number) => ReturnType<Ledger["submit"]>;
};
function refuse(): never { throw new Error("reclaim offer refused: invalid, stale or changed payment, consent or transaction"); }
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const reclaimOfferDigest = (offer: ReclaimOffer) => hash(JSON.stringify(offer));
const decimal = (value: unknown): value is string => typeof value === "string" && isU64Decimal(value);
const slot = (value: unknown): value is bigint => typeof value === "bigint" && isU64Decimal(value.toString());
function exact(value: unknown, names: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== names.sort().join()) refuse();
}
function identity(value: RecoveryIdentity) {
  exact(value, ["network", "genesisHash", "programId"]);
  if (!isAddress(value.genesisHash) || !isAddress(value.programId) || value.network !== `solana:${value.genesisHash.slice(0, 32)}`) refuse();
}
function bounded(timeout = 10_000) {
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 60_000) refuse();
  const deadline = Date.now() + timeout, end = performance.now() + timeout;
  const check = () => { if (Date.now() >= deadline || performance.now() >= end) refuse(); };
  async function read<T>(fn: () => Promise<T>) {
    check(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([fn(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("reclaim evidence deadline exceeded")), Math.max(1, Math.min(deadline - Date.now(), end - performance.now())));
      })]);
      check(); return result;
    } finally { if (timer) clearTimeout(timer); }
  }
  return { deadline, check, read };
}
type Budget = ReturnType<typeof bounded>;
async function paymentProof(o: Options, payment: Address, payer: Address, minimum: bigint, b: Budget) {
  identity(o.identity);
  if (!isAddress(payment) || !isAddress(payer) || !slot(minimum) || JSON.stringify(await b.read(() => o.reader.verifyIdentity(b.deadline))) !== JSON.stringify(o.identity)) refuse();
  const observed = await b.read(() => o.reader.getAccountAtLeast(payment, minimum));
  if (observed.kind !== "ok" || !slot(observed.slot) || observed.slot < minimum || !observed.account || observed.account.executable !== false || observed.account.owner !== o.identity.programId) refuse();
  const p = decodePayment(observed.account.data);
  if (!p || p.payer !== payer || p.held <= 0n || await paymentAddress(o.identity.programId, p.payer, p.salt) !== payment) refuse();
  const clock = await b.read(() => o.reader.getClockAtLeast(observed.slot, b.deadline));
  if (clock.kind !== "ok" || clock.commitment !== "finalized" || !slot(clock.slot) || clock.slot < observed.slot || typeof clock.unixTimestamp !== "bigint" || clock.unixTimestamp < p.captureDeadline) refuse();
  return { payment: p, data: Buffer.from(observed.account.data).toString("base64"), paymentSlot: observed.slot, clockSlot: clock.slot };
}
async function validLifetime(o: Options, lifetime: ReclaimOffer["lifetime"], minimum: bigint, b: Budget) {
  exact(lifetime, ["blockhash", "lastValidBlockHeight", "blockhashSlot"]);
  if (!isAddress(lifetime.blockhash) || !decimal(lifetime.lastValidBlockHeight) || !decimal(lifetime.blockhashSlot)) refuse();
  const origin = await b.read(() => o.reader.verifyBlockhashOrigin(lifetime.blockhash, BigInt(lifetime.blockhashSlot), o.identity.genesisHash, o.identity.network, b.deadline));
  if (origin.state !== "verified" || origin.commitment !== "finalized" || origin.blockhash !== lifetime.blockhash || origin.slot !== lifetime.blockhashSlot || origin.network !== o.identity.network || origin.genesisHash !== o.identity.genesisHash) refuse();
  const status = await b.read(() => o.reader.getFinalizedBlockhashStatus(lifetime.blockhash, BigInt(lifetime.blockhashSlot), b.deadline));
  if (status.kind !== "ok" || status.valid !== true || !slot(status.slot) || status.slot < BigInt(lifetime.blockhashSlot) || status.slot < minimum) refuse();
  return status.slot;
}
async function unsigned(offer: Pick<ReclaimOffer, "identity" | "payment" | "payer" | "lifetime">, data: NonNullable<ReturnType<typeof decodePayment>>) {
  return buildTransaction({ feePayer: offer.payer, signers: [],
    lifetime: { blockhash: offer.lifetime.blockhash as Blockhash, lastValidBlockHeight: BigInt(offer.lifetime.lastValidBlockHeight) },
    instructions: [await reclaimInstruction({ programId: offer.identity.programId, payment: offer.payment, payer: offer.payer, server: data.server, mint: data.mint })] });
}

/** Read-only preparation: no key loader, signer, journal mutation or broadcast. */
export async function createReclaimOffer(o: Options & { payment: Address; payer: Address; lifetime: Lifetime }): Promise<ReclaimOffer> {
  o = { ...o, identity: { ...o.identity }, lifetime: { ...o.lifetime } };
  const b = bounded(o.timeoutMs);
  const l = o.lifetime;
  if (l.commitment !== "finalized" || l.network !== o.identity.network || l.genesisHash !== o.identity.genesisHash || !slot(l.blockhashSlot) || !slot(l.lastValidBlockHeight)) refuse();
  const lifetime = { blockhash: l.blockhash, lastValidBlockHeight: l.lastValidBlockHeight.toString(), blockhashSlot: l.blockhashSlot.toString() };
  const initial = await paymentProof(o, o.payment, o.payer, l.blockhashSlot, b);
  const latest = await validLifetime(o, lifetime, initial.clockSlot, b);
  const proof = await paymentProof(o, o.payment, o.payer, latest, b);
  if (proof.data !== initial.data) refuse();
  const tx = await unsigned({ identity: o.identity, payment: o.payment, payer: o.payer, lifetime }, proof.payment);
  b.check();
  return Object.freeze({ version: 1, kind: "payer-direct-reclaim", identity: Object.freeze({ ...o.identity }), payment: o.payment, payer: o.payer,
    held: proof.payment.held.toString(), refundable: proof.payment.refundable.toString(), captureDeadline: proof.payment.captureDeadline.toString(),
    paymentDataBase64: proof.data, paymentSlot: proof.paymentSlot.toString(), clockSlot: proof.clockSlot.toString(), lifetime: Object.freeze(lifetime),
    unsignedBase64: getBase64EncodedWireTransaction(tx), messageHash: messageHash(tx.messageBytes) });
}

/** One new payer-direct reclaim only. Existing reservations require separate reconciliation. */
export async function submitReclaimOffer(o: Options & { offer: ReclaimOffer; consent: ReclaimConsent; transactionBase64: string; journal: SubmissionJournal; backend: Backend }): Promise<{ signature: string; result: SubmitResult; offerSha256: string }> {
  o = { ...o, identity: { ...o.identity } };
  // Pin caller-owned values before any await; a wallet or RPC callback cannot mutate consent.
  const offer = strictJson(JSON.stringify(o.offer)) as ReclaimOffer, consent = strictJson(JSON.stringify(o.consent)) as ReclaimConsent, wire = o.transactionBase64;
  exact(offer, ["version", "kind", "identity", "payment", "payer", "held", "refundable", "captureDeadline", "paymentDataBase64", "paymentSlot", "clockSlot", "lifetime", "unsignedBase64", "messageHash"]);
  exact(consent, ["accept", "offerSha256", "payment", "payer"]);
  const digest = reclaimOfferDigest(offer);
  if (offer.version !== 1 || offer.kind !== "payer-direct-reclaim" || JSON.stringify(offer.identity) !== JSON.stringify(o.identity) || consent.accept !== true || consent.offerSha256 !== digest || consent.payment !== offer.payment || consent.payer !== offer.payer || !decimal(offer.held) || !decimal(offer.refundable) || !decimal(offer.paymentSlot) || !decimal(offer.clockSlot) || typeof wire !== "string" || wire.length > 1644) refuse();
  const b = bounded(o.timeoutMs);
  return withShared(o.journal.coordination, async () => {
    o.journal.assertAccess?.();
    const saved = decodePayment(Buffer.from(offer.paymentDataBase64, "base64"));
    if (!saved || saved.held.toString() !== offer.held || saved.refundable.toString() !== offer.refundable || saved.captureDeadline.toString() !== offer.captureDeadline || saved.payer !== offer.payer) refuse();
    const expected = await unsigned(offer, saved), tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
    if (getBase64EncodedWireTransaction(expected) !== offer.unsignedBase64 || getBase64EncodedWireTransaction(tx) !== wire || !Buffer.from(tx.messageBytes).equals(Buffer.from(expected.messageBytes)) || messageHash(tx.messageBytes) !== offer.messageHash) refuse();
    const m = getCompiledTransactionMessageDecoder().decode(tx.messageBytes), signature = tx.signatures[offer.payer];
    if (m.version !== "legacy" || m.header.numSignerAccounts !== 1 || m.staticAccounts[0] !== offer.payer || m.instructions.length !== 1 || !signature || !await verifySignature(await getPublicKeyFromAddress(offer.payer), signature as SignatureBytes, tx.messageBytes)) refuse();
    let minimum = BigInt(offer.clockSlot) > BigInt(offer.paymentSlot) ? BigInt(offer.clockSlot) : BigInt(offer.paymentSlot);
    async function refresh() {
      minimum = await validLifetime(o, offer.lifetime, minimum, b);
      const current = await paymentProof(o, offer.payment, offer.payer, minimum, b);
      if (current.data !== offer.paymentDataBase64) refuse();
      minimum = current.clockSlot;
    }
    await refresh();
    // A simulator gets independent bytes: mutating its input cannot rewrite the signed wire.
    const simulationTx = getTransactionDecoder().decode(getBase64Encoder().encode(offer.unsignedBase64));
    const simulation = await o.backend.simulate({ ...simulationTx, signatures: { [offer.payer]: null } }, b.deadline);
    b.check(); if (!simulation.ok) throw new Error("reclaim simulation refused; no submission reserved");
    await refresh(); b.check();
    const signatureText = getSignatureFromTransaction(tx);
    o.journal.prepare({ signature: signatureText, messageHash: offer.messageHash, transactionBase64: wire,
      blockhash: offer.lifetime.blockhash, blockhashSlot: offer.lifetime.blockhashSlot, lastValidBlockHeight: offer.lifetime.lastValidBlockHeight,
      operation: "reclaim", payment: offer.payment, payer: offer.payer, expectedHeld: offer.held, expectedRefundable: offer.refundable });
    // Await the economic callback under the coordination token. Never race, retry or replace it.
    let result: SubmitResult;
    try { b.check(); result = await o.backend.submit(tx, b.deadline); }
    catch (error) {
      try { o.journal.resolve(signatureText, { result: "submit-threw", recordedAt: new Date().toISOString() }); } catch { /* Reservation remains authoritative. */ }
      throw error;
    }
    try { o.journal.resolve(signatureText, { ...submissionOutcome(result), recordedAt: new Date().toISOString() }); } catch { /* Keep exact original signature for reconciliation. */ }
    return { signature: signatureText, result, offerSha256: digest };
  });
}
