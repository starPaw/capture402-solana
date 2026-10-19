// Explicit, separately consented payer operation; never a merchant retry or startup queue.
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { getBase64Encoder, getBase64EncodedWireTransaction, getCompiledTransactionMessageDecoder, getPublicKeyFromAddress, getSignatureFromTransaction, getTransactionDecoder, isAddress, isSignature, verifySignature, type Address, type Blockhash, type SignatureBytes, type Transaction } from "@solana/kit";
import { type RecoveryDomain, type CoordinationToken } from "./coordination.ts";
import { type RecoveryEnrollment, type RecoveryIdentity, verifyRecoveryEnrollment } from "./recovery-enrollment.ts";
import { recoveryHash, recoverySnapshot, sameRecoveryPins, readRecoveryRecord, type FilePin, type RecoverySnapshot } from "./recovery-snapshot.ts";
import { createRecoveryRecord } from "./recovery-record.ts";
import { reconcileRestaurantOrder } from "./restaurant-reconciliation.ts";
import { FileSubmissionJournal, messageHash, submissionOutcome, type SubmissionEntry, type PreparedSubmission } from "./submission-journal.ts";
import { buildTransaction, reclaimInstruction, type Lifetime } from "./transactions.ts";
import { decodePayment, paymentAddress } from "./program.ts";
import { isU64Decimal, parseObservation, type CanonicalOrigin } from "./lifetime-provenance.ts";
import { strictJson } from "./quarantine-view.ts";
import type { BlockhashCheck, ChainReader, SignatureLookup, SlotAccount } from "./reconciliation.ts";
import type { Ledger, SubmitResult } from "./ledger.ts";

export type PayerRecoveryReader = ChainReader & {
  verifyIdentity(deadline: number): Promise<RecoveryIdentity>;
  verifyBlockhashOrigin(hash: string, slot: bigint, genesis: string, network: string, deadline: number): Promise<CanonicalOrigin>;
  getFinalizedBlockhashStatus(hash: string, slot: bigint, deadline: number): Promise<BlockhashCheck>;
  getClockAtLeast(slot: bigint, deadline: number): Promise<{ kind: "ok"; commitment: "finalized"; slot: bigint; unixTimestamp: bigint } | { kind: "unavailable"; detail: string }>;
};
export type PayerRecoveryOptions = { domain: RecoveryDomain; enrollment?: RecoveryEnrollment; identity: RecoveryIdentity;
  orderId: string; action: "beer" | "salmon"; captureSignature: string; reader: PayerRecoveryReader; timeoutMs?: number };
type PaymentProof = { slot: string; owner: string; executable: boolean; dataBase64: string };
type Proof = { pins: FilePin[]; capture: { signature: string; messageHash: string; blockhash: string; originSlot: string; expirySlot: string; observedSlot: string };
  payment: PaymentProof; clock: { slot: string; unixTimestamp: string }; retryAfter?: string; reclaimRecovery?: PreparedSubmission["reclaimRecovery"] };
export type PayerRecoveryOffer = Readonly<{ version: 1; identity: RecoveryIdentity; orderId: string; action: "beer" | "salmon";
  captureSignature: string; payment: string; payer: string; held: string; refundable: string; proof: Proof;
  lifetime: { blockhash: string; lastValidBlockHeight: string; blockhashSlot: string }; unsignedBase64: string; messageHash: string }>;
export type PayerRecoveryConsent = { offerSha256: string; payer: string; payment: string; ownerAuthorization: string; accept: true };
type RecordV1 = { version: 1; kind: "unknown-capture-payer-recovery"; offer: PayerRecoveryOffer; offerSha256: string;
  consent: PayerRecoveryConsent; submissionProof: Proof; signature: string; transactionBase64: string; originals: { name: string; base64: string }[]; recordIdentity?: string };
const pathFor = (domain: RecoveryDomain, role: string) => domain.metadata.members.find(m => m.role === role)!.path;
function refuse(): never { throw new Error("payer recovery refused: incomplete, conflicting, stale or changed proof; retain reservations"); }
const json = (raw: Uint8Array | string): any => strictJson(typeof raw === "string" ? raw : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw));
const slot = (v: unknown): v is bigint => typeof v === "bigint" && isU64Decimal(v.toString());
const recordName = (id: string, hash: string) => `${id}.payer-recovery-${hash}.record`;
export const payerRecoveryOfferDigest = (offer: PayerRecoveryOffer) => recoveryHash(JSON.stringify(offer));

// The complete fence remains held through backend completion. Only read-only RPC waits are
// raced; economic callbacks are awaited (their adapter must bound transport, never retry).
async function fenced<T>(o: PayerRecoveryOptions, action: (c: Context) => Promise<T>): Promise<T> {
  if (!/^[a-f0-9]{32}$/.test(o.orderId) || !["beer", "salmon"].includes(o.action) || !isSignature(o.captureSignature)) refuse();
  const timeout = o.timeoutMs ?? 10000; if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 60000) refuse();
  const deadline = Date.now() + timeout, end = performance.now() + timeout;
  const check = () => { if (Date.now() >= deadline || performance.now() >= end) refuse(); };
  return o.domain.run("exclusive", async token => {
    const guard = () => { check(); verifyRecoveryEnrollment(o.enrollment, token, o.identity); };
    const read = async <V>(fn: () => Promise<V>) => {
      guard(); let timer: ReturnType<typeof setTimeout> | undefined;
      try { const value = await Promise.race([fn(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("payer recovery deadline exceeded")), Math.max(1, Math.min(deadline - Date.now(), end - performance.now()))); })]); guard(); return value; }
      finally { if (timer) clearTimeout(timer); }
    };
    guard(); if (JSON.stringify(await read(() => o.reader.verifyIdentity(deadline))) !== JSON.stringify(o.identity)) refuse();
    return action({ o, token, deadline, guard, read });
  }, timeout);
}
type Context = { o: PayerRecoveryOptions; token: CoordinationToken; deadline: number; guard(): void; read<V>(fn: () => Promise<V>): Promise<V> };
function snapshot(c: Context): RecoverySnapshot {
  c.guard(); const s = recoverySnapshot(c.o.domain, "", { payerRecovery: true });
  for (const [name] of s.bytes) if (name.includes(".payer-recovery-") && !name.startsWith(`orders/${c.o.orderId}.payer-recovery-`)) refuse();
  for (const [name, raw] of s.bytes) {
    if (name.endsWith(".json") || name.startsWith("orders/") && name.endsWith(".lock")) json(raw);
    if (name.startsWith("orders/") && /\.(?:lock|busy)$/.test(name) && !s.bytes.has(name.slice(0, 7 + 32) + ".json")) refuse();
  }
  return s;
}
function statusSlot(s: SignatureLookup): bigint {
  if (s.kind === "unavailable" || !slot(s.observedSlot) || s.kind === "found" && (!slot(s.slot) || s.observedSlot < s.slot)) refuse();
  return s.observedSlot;
}
function exactKeys(value: object, fields: string[]) { if (!value || Object.keys(value).sort().join() !== fields.sort().join()) refuse(); }
function canonicalOrigin(origin: CanonicalOrigin, hash: string, candidate: string, identity: RecoveryIdentity) {
  if (origin.state !== "verified" || origin.blockhash !== hash || origin.slot !== candidate || origin.commitment !== "finalized" || origin.network !== identity.network || origin.genesisHash !== identity.genesisHash || !isU64Decimal(candidate)) refuse();
}
async function exactSignedReclaim(wire: string, offer: PayerRecoveryOffer): Promise<Transaction> {
  if (typeof wire !== "string" || wire.length > 1644 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(wire)) refuse();
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
  if (getBase64EncodedWireTransaction(tx) !== wire || messageHash(tx.messageBytes) !== offer.messageHash) refuse();
  const offered = getTransactionDecoder().decode(getBase64Encoder().encode(offer.unsignedBase64));
  if (!Buffer.from(tx.messageBytes).equals(Buffer.from(offered.messageBytes))) refuse();
  const m = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  if (m.version !== "legacy" || m.header.numSignerAccounts !== 1 || m.staticAccounts[0] !== offer.payer || m.instructions.length !== 1 || m.lifetimeToken !== offer.lifetime.blockhash) refuse();
  const signature = tx.signatures[offer.payer as Address];
  if (!signature || !await verifySignature(await getPublicKeyFromAddress(offer.payer as Address), signature as SignatureBytes, tx.messageBytes)) refuse();
  return tx;
}
async function validateOfferShape(offer: PayerRecoveryOffer, o: PayerRecoveryOptions) {
  exactKeys(offer, ["version", "identity", "orderId", "action", "captureSignature", "payment", "payer", "held", "refundable", "proof", "lifetime", "unsignedBase64", "messageHash"]);
  exactKeys(offer.identity, ["network", "genesisHash", "programId"]);
  exactKeys(offer.lifetime, ["blockhash", "blockhashSlot", "lastValidBlockHeight"]);
  exactKeys(offer.proof, ["pins", "capture", "payment", "clock", ...(offer.proof.retryAfter === undefined ? [] : ["retryAfter"]), ...(offer.proof.reclaimRecovery === undefined ? [] : ["reclaimRecovery"])]);
  exactKeys(offer.proof.capture, ["signature", "messageHash", "blockhash", "originSlot", "expirySlot", "observedSlot"]);
  exactKeys(offer.proof.payment, ["slot", "owner", "executable", "dataBase64"]);
  exactKeys(offer.proof.clock, ["slot", "unixTimestamp"]);
  if (offer.version !== 1 || JSON.stringify(offer.identity) !== JSON.stringify(o.identity) || offer.orderId !== o.orderId || offer.action !== o.action || offer.captureSignature !== o.captureSignature || !isAddress(offer.payment) || !isAddress(offer.payer)) refuse();
  const p = decodePayment(Buffer.from(offer.proof.payment.dataBase64, "base64"));
  if (!p || p.payer !== offer.payer || p.held.toString() !== offer.held || p.refundable.toString() !== offer.refundable || p.held <= 0n || !isU64Decimal(offer.lifetime.lastValidBlockHeight) || !isU64Decimal(offer.lifetime.blockhashSlot) || !isAddress(offer.lifetime.blockhash)) refuse();
  const unsigned = await buildTransaction({ feePayer: p.payer, signers: [], lifetime: { blockhash: offer.lifetime.blockhash as unknown as Blockhash, lastValidBlockHeight: BigInt(offer.lifetime.lastValidBlockHeight) },
    instructions: [await reclaimInstruction({ programId: o.identity.programId, payment: offer.payment as Address, payer: p.payer, server: p.server, mint: p.mint })] });
  if (getBase64EncodedWireTransaction(unsigned) !== offer.unsignedBase64 || messageHash(unsigned.messageBytes) !== offer.messageHash) refuse();
}
async function attributed(c: Context, s: RecoverySnapshot, order: any): Promise<{ entries: SubmissionEntry[]; records: RecordV1[] }> {
  const entries: SubmissionEntry[] = [], records: RecordV1[] = [];
  for (const [name] of s.bytes) if (name.includes(".payer-recovery-") && !name.startsWith(`orders/${c.o.orderId}.payer-recovery-`)) refuse();
  for (const [name, raw] of s.bytes) if (name.endsWith(".json") && !name.startsWith("orders/") && !name.startsWith("operations/")) {
    const e = json(raw) as SubmissionEntry;
    if (e.payment !== order.payment || e.operation !== "reclaim") continue;
    if (!name.startsWith("reclaim/") || name !== `reclaim/${e.signature}.json` || e.payer !== order.payer || e.attempts.length !== 1) refuse();
    entries.push(e);
  }
  for (const [name] of s.bytes) if (name.startsWith(`orders/${c.o.orderId}.payer-recovery-`)) {
    const raw = readRecoveryRecord(join(pathFor(c.o.domain, "orders"), name.slice(7))), r = json(raw) as RecordV1;
    if (JSON.stringify(r) !== raw || Object.keys(r).sort().join() !== ["version", "kind", "offer", "offerSha256", "consent", "submissionProof", "signature", "transactionBase64", "originals", "recordIdentity"].sort().join() || r.version !== 1 || r.kind !== "unknown-capture-payer-recovery" || name !== `orders/${recordName(c.o.orderId, r.offer.messageHash)}` || r.offerSha256 !== payerRecoveryOfferDigest(r.offer)) refuse();
    await validateOfferShape(r.offer, c.o); validateConsent(r.consent, r.offer); freshProof(r.offer.proof, r.submissionProof);
    const tx = await exactSignedReclaim(r.transactionBase64, r.offer);
    if (getSignatureFromTransaction(tx) !== r.signature) refuse();
    const merchantPins = r.offer.proof.pins.filter(p => p.role === "orders" && p.name.startsWith(`${c.o.orderId}.json`) || p.role === "facilitator" && !r.offer.proof.pins.some(q => q.role === "reclaim" && q.name === p.name));
    const requiredOriginals = merchantPins.map(p => `${p.role}/${p.name}`);
    if (JSON.stringify(r.originals.map(p => p.name)) !== JSON.stringify(requiredOriginals)) refuse();
    sameRecoveryPins(merchantPins, s.pins.filter(p => requiredOriginals.includes(`${p.role}/${p.name}`)));
    for (const original of r.originals) if (recoveryHash(Buffer.from(original.base64, "base64")) !== r.offer.proof.pins.find(p => `${p.role}/${p.name}` === original.name)?.sha256) refuse();
    // The merchant preimage, busy/action locks and fully signed capture must still be exact.
    for (const original of r.originals.filter(p => p.name.startsWith(`orders/${c.o.orderId}.json`) || p.name.startsWith("facilitator/"))) if (s.bytes.get(original.name)?.toString("base64") !== original.base64) refuse();
    const e = entries.find(e => e.signature === r.signature), recordPin = s.pins.find(p => `${p.role}/${p.name}` === name);
    if (!e || !recordPin || !e.payerRecoveryRecord || Object.keys(e.payerRecoveryRecord).sort().join() !== "identity,name,sha256" || e.payerRecoveryRecord.name !== recordPin.name || e.payerRecoveryRecord.sha256 !== recordPin.sha256 || e.payerRecoveryRecord.identity !== recordPin.identity || e.transactionBase64 !== r.transactionBase64 || e.messageHash !== r.offer.messageHash || e.blockhash !== r.offer.lifetime.blockhash || e.blockhashSlot !== r.offer.lifetime.blockhashSlot || e.lastValidBlockHeight !== r.offer.lifetime.lastValidBlockHeight || e.expectedHeld !== r.offer.held || e.expectedRefundable !== r.offer.refundable || e.retryAfter !== r.offer.proof.retryAfter || JSON.stringify(e.reclaimRecovery) !== JSON.stringify(r.offer.proof.reclaimRecovery)) refuse();
    records.push(r);
  }
  validateChain(s, entries, order.payment);
  if (records.length !== entries.length || entries.some(e => !records.some(r => r.signature === e.signature))) refuse();
  return { entries, records };
}
function validateChain(s: RecoverySnapshot, entries: SubmissionEntry[], payment: string) {
  const root = `reclaim-${payment}.lock`, prefix = `reclaim-${payment}-after-`;
  const locks = [...s.bytes].filter(([name]) => name.endsWith(`/` + root) || name.includes(`/` + prefix));
  if (locks.some(([name]) => !name.startsWith("reclaim/")) || locks.length !== entries.length) refuse();
  if (!entries.length) return;
  const seen = new Set<string>(); let current = s.bytes.get(`reclaim/${root}`)?.toString(), predecessor: string | undefined;
  while (current && !seen.has(current)) {
    const entry = entries.find(e => e.signature === current);
    if (!entry || entry.retryAfter !== predecessor || !isSignature(current)) refuse();
    seen.add(current); predecessor = current; current = s.bytes.get(`reclaim/${prefix}${current}.lock`)?.toString();
  }
  if (current || seen.size !== entries.length) refuse();
}
function validateConsent(consent: PayerRecoveryConsent, offer: PayerRecoveryOffer) {
  if (!consent || Object.keys(consent).sort().join() !== "accept,offerSha256,ownerAuthorization,payer,payment" || consent.accept !== true || consent.offerSha256 !== payerRecoveryOfferDigest(offer) || consent.payer !== offer.payer || consent.payment !== offer.payment || typeof consent.ownerAuthorization !== "string" || !consent.ownerAuthorization.startsWith(`payer-reclaim:${offer.payment}:${consent.offerSha256}:`) || consent.ownerAuthorization.length > 512) refuse();
  // This attributed authorization is necessary but never grants live enrollment. The opaque
  // fixture issuer is the only admission authority currently available.
}
async function assess(c: Context, retryAfter?: string): Promise<{ s: RecoverySnapshot; proof: Proof; payment: Address; data: NonNullable<ReturnType<typeof decodePayment>> }> {
  const { o } = c, s = snapshot(c), orderRaw = s.bytes.get(`orders/${o.orderId}.json`); if (!orderRaw) refuse();
  const order = json(orderRaw);
  if (order.status !== "pending" || s.bytes.get(`orders/${o.orderId}.json.busy`)?.toString() !== o.action || order.reclaimUnsigned !== undefined || order.reclaimLifetime !== undefined) refuse();
  for (const [name, raw] of s.bytes) {
    if (name.startsWith("operations/") && JSON.stringify(json(raw)).includes(order.payment)) refuse();
    if (name.startsWith("orders/") && name.endsWith(".json") && name !== `orders/${o.orderId}.json` && json(raw).payment === order.payment) refuse();
    if (name.startsWith(`orders/${o.orderId}.outcome-`)) refuse();
  }
  const { entries } = await attributed(c, s, order);
  let fence = 0n, paymentRead: SlotAccount | undefined; const statuses = new Map<string, SignatureLookup>();
  const status = async (signature: string) => { const value = await c.read(() => o.reader.getSignatureStatus(signature)); const observed = statusSlot(value); if (observed > fence) fence = observed; statuses.set(signature, value); return value; };
  const reader: ChainReader = { getSignatureStatus: status, findSignaturesByMessage: () => Promise.reject(new Error("original journal required")),
    isBlockhashValid: async () => ({ kind: "unavailable", detail: "bare validity is not recovery proof" }),
    getAccountAtLeast: async (address, minimum) => { paymentRead = await c.read(() => o.reader.getAccountAtLeast(address, minimum > fence ? minimum : fence)); return paymentRead; } };
  const report = await c.read(() => reconcileRestaurantOrder({ ordersDir: pathFor(o.domain, "orders"), orderId: o.orderId, ...o.identity,
    reader, journalDirs: [pathFor(o.domain, "facilitator"), pathFor(o.domain, "reclaim")], allowLockOnly: true, recoveryReclaimSignatures: entries.map(e => e.signature) }));
  const target = report.actions.find(a => a.action === o.action);
  const localTarget = order.events.find((e: any) => e.action === o.action), localLock = json(s.bytes.get(`orders/${o.orderId}.json.${o.action}.lock`) ?? "{}");
  if (localTarget && (!["prepared", "pending"].includes(localTarget.status) || localTarget.receipt?.success === true || localTarget.receipt && localTarget.receipt.errorReason !== "settlement_pending") || !["prepared", "pending"].includes(localLock.status) || localLock.receipt !== undefined) refuse();
  if (report.issues.length || !target || target.issues.length || target.verdict !== "unknown" || target.status?.kind !== "not-found" || target.signature !== o.captureSignature || target.journals.length !== 1 || target.journals[0]!.attempts !== 1 || target.journals[0]!.outcomes.some(r => ["finalized-succeeded", "finalized-failed", "not-submitted"].includes(r)) || !report.actions.some(a => a.action === "authorize" && a.verdict === "finalized-succeeded")) refuse();
  for (const a of report.actions.filter(a => a !== target)) {
    const e = order.events.find((e: any) => e.action === a.action);
    if (a.issues.length || a.journals.length !== 1 || !["finalized-succeeded", "finalized-failed"].includes(a.verdict) || !e || e.transaction !== a.signature || e.status !== (a.verdict === "finalized-succeeded" ? "finalized" : "rejected")) refuse();
  }
  const original = s.bytes.get(`facilitator/${o.captureSignature}.json`); if (!original) refuse();
  const capture = json(original) as SubmissionEntry;
  const provenance = capture.lifetimeProvenance, origin = provenance?.origin;
  if (!provenance || provenance.version !== 1 || provenance.messageHash !== target.messageHash || provenance.blockhash !== capture.blockhash || origin?.state !== "verified" || provenance.observation.state !== "recorded") refuse();
  exactKeys(provenance, ["version", "messageHash", "blockhash", "observation", "origin"]);
  exactKeys(provenance.observation, ["state", "source", "value"]);
  if (!["first-party", "request"].includes(provenance.observation.source)) refuse();
  exactKeys(origin, ["state", "blockhash", "slot", "commitment", "network", "genesisHash"]);
  const observation = parseObservation(provenance.observation.value);
  if (!observation || observation.messageHash !== target.messageHash || observation.blockhash !== capture.blockhash || observation.network !== o.identity.network || observation.genesisHash !== o.identity.genesisHash || observation.contextSlot !== origin.slot) refuse();
  canonicalOrigin(origin, capture.blockhash, origin.slot, o.identity);
  canonicalOrigin(await c.read(() => o.reader.verifyBlockhashOrigin(capture.blockhash, BigInt(origin.slot), o.identity.genesisHash, o.identity.network, c.deadline)), capture.blockhash, origin.slot, o.identity);
  const expiry = await c.read(() => o.reader.getFinalizedBlockhashStatus(capture.blockhash, BigInt(origin.slot), c.deadline));
  if (expiry.kind !== "ok" || expiry.valid !== false || !slot(expiry.slot) || expiry.slot <= BigInt(origin.slot)) refuse();
  if (expiry.slot > fence) fence = expiry.slot;
  let reclaimRecovery: PreparedSubmission["reclaimRecovery"];
  if (entries.length) {
    if (!retryAfter || !isSignature(retryAfter) || retryAfter === o.captureSignature) refuse();
    const previous = entries.find(e => e.signature === retryAfter); if (!previous || entries.some(e => e.retryAfter === retryAfter)) refuse();
    const previousStatus = await status(retryAfter);
    if (previousStatus.kind === "found" && previousStatus.commitment === "finalized" && typeof previousStatus.err === "string" && previousStatus.err.length && previous.attempts[0]!.outcome?.result === "finalized-failed") {
      // Explicit reconciliation must have persisted this result first. Never mutate an old
      // journal while assessing an offer or turn CAPTURE into a reclaim predecessor.
    } else {
      if (previousStatus.kind !== "not-found" || previous.attempts[0]!.outcome?.result === "finalized-succeeded" || !isU64Decimal(previous.blockhashSlot)) refuse();
      const expired = await c.read(() => o.reader.getFinalizedBlockhashStatus(previous.blockhash, BigInt(previous.blockhashSlot!), c.deadline));
      if (expired.kind !== "ok" || expired.valid !== false || !slot(expired.slot) || expired.slot <= BigInt(previous.blockhashSlot!)) refuse();
      if (expired.slot > fence) fence = expired.slot;
      reclaimRecovery = { kind: "expired-no-effect", blockhash: previous.blockhash, originSlot: previous.blockhashSlot!, expirySlot: expired.slot.toString(), paymentSlot: "" };
    }
    // Every earlier ancestor must also have separately accepted failed/expired proof. These
    // proofs were retained in its successor; unresolved forks/orphans are rejected by report.
    for (const e of entries.filter(e => e.signature !== retryAfter)) if (!entries.some(next => next.retryAfter === e.signature)) refuse();
  } else if (retryAfter !== undefined || report.reclaimReservations.length) refuse();
  paymentRead = await c.read(() => o.reader.getAccountAtLeast(order.payment, fence));
  if (paymentRead.kind !== "ok" || !slot(paymentRead.slot) || paymentRead.slot < fence || !paymentRead.account || paymentRead.account.owner !== o.identity.programId || paymentRead.account.executable !== false) refuse();
  const p = decodePayment(paymentRead.account.data), terms = order.required.accepts[0];
  if (!p || p.payer !== order.payer || p.server !== terms.payTo || p.mint !== terms.asset || p.maximum.toString() !== terms.amount || p.captureDeadline !== BigInt(terms.extra.captureDeadline) || p.refundDeadline !== BigInt(terms.extra.refundDeadline) || await paymentAddress(o.identity.programId, p.payer, p.salt) !== order.payment || p.held <= 0n || p.held > p.maximum || p.refundable > p.maximum - p.held) refuse();
  if (reclaimRecovery) {
    const previous = entries.find(e => e.signature === retryAfter)!;
    if (p.held.toString() !== previous.expectedHeld || p.refundable.toString() !== previous.expectedRefundable) refuse();
    reclaimRecovery.paymentSlot = paymentRead.slot.toString();
  }
  const paymentSlot = paymentRead.slot;
  const clock = await c.read(() => o.reader.getClockAtLeast(paymentSlot, c.deadline));
  if (clock.kind !== "ok" || clock.commitment !== "finalized" || !slot(clock.slot) || clock.slot < paymentRead.slot || typeof clock.unixTimestamp !== "bigint" || clock.unixTimestamp < p.captureDeadline || clock.unixTimestamp > (1n << 63n) - 1n) refuse();
  sameRecoveryPins(s.pins, snapshot(c).pins);
  return { s, payment: order.payment, data: p, proof: { pins: s.pins, capture: { signature: o.captureSignature, messageHash: target.messageHash!, blockhash: capture.blockhash, originSlot: origin.slot, expirySlot: expiry.slot.toString(), observedSlot: statusSlot(statuses.get(o.captureSignature)!).toString() },
    payment: { slot: paymentRead.slot.toString(), owner: paymentRead.account.owner, executable: false, dataBase64: Buffer.from(paymentRead.account.data).toString("base64") }, clock: { slot: clock.slot.toString(), unixTimestamp: clock.unixTimestamp.toString() }, ...(retryAfter === undefined ? {} : { retryAfter }), ...(reclaimRecovery ? { reclaimRecovery } : {}) } };
}
function sameSuccessorProof(a: Proof["reclaimRecovery"], b: Proof["reclaimRecovery"]) {
  if (!a || !b) return a === b;
  return a.kind === b.kind && a.blockhash === b.blockhash && a.originSlot === b.originSlot && BigInt(b.expirySlot) >= BigInt(a.expirySlot) && BigInt(b.paymentSlot) >= BigInt(a.paymentSlot);
}
function freshProof(reviewed: Proof, fresh: Proof) {
  sameRecoveryPins(reviewed.pins, fresh.pins);
  if (JSON.stringify({ ...reviewed.capture, expirySlot: "", observedSlot: "" }) !== JSON.stringify({ ...fresh.capture, expirySlot: "", observedSlot: "" }) || reviewed.payment.dataBase64 !== fresh.payment.dataBase64 || BigInt(fresh.capture.expirySlot) < BigInt(reviewed.capture.expirySlot) || BigInt(fresh.capture.observedSlot) < BigInt(reviewed.capture.observedSlot) || BigInt(fresh.payment.slot) < BigInt(reviewed.payment.slot) || BigInt(fresh.clock.slot) < BigInt(reviewed.clock.slot) || BigInt(fresh.clock.unixTimestamp) < BigInt(reviewed.clock.unixTimestamp) || reviewed.retryAfter !== fresh.retryAfter || !sameSuccessorProof(reviewed.reclaimRecovery, fresh.reclaimRecovery)) refuse();
}
/** No signer is loaded. Exact single-instruction direct payer message, immutable for review. */
export async function offerPayerRecovery(o: PayerRecoveryOptions & { lifetime: Lifetime; retryAfter?: string }): Promise<PayerRecoveryOffer> {
  o = { ...o, identity: { ...o.identity }, lifetime: { ...o.lifetime } };
  return fenced(o, async c => {
    const a = await assess(c, o.retryAfter), l = o.lifetime;
    if (!isAddress(l.blockhash) || !slot(l.lastValidBlockHeight) || !slot(l.blockhashSlot) || l.commitment !== "finalized" || l.network !== o.identity.network || l.genesisHash !== o.identity.genesisHash || l.blockhashSlot < BigInt(a.proof.clock.slot)) refuse();
    canonicalOrigin(await c.read(() => o.reader.verifyBlockhashOrigin(l.blockhash, l.blockhashSlot!, o.identity.genesisHash, o.identity.network, c.deadline)), l.blockhash, l.blockhashSlot!.toString(), o.identity);
    const validity = await c.read(() => o.reader.getFinalizedBlockhashStatus(l.blockhash, l.blockhashSlot!, c.deadline));
    if (validity.kind !== "ok" || validity.valid !== true || !slot(validity.slot) || validity.slot < l.blockhashSlot!) refuse();
    const tx = await buildTransaction({ feePayer: a.data.payer, signers: [], lifetime: l, instructions: [await reclaimInstruction({ programId: o.identity.programId, payment: a.payment, payer: a.data.payer, server: a.data.server, mint: a.data.mint })] });
    c.guard(); sameRecoveryPins(a.s.pins, snapshot(c).pins);
    return JSON.parse(JSON.stringify({ version: 1, identity: o.identity, orderId: o.orderId, action: o.action, captureSignature: o.captureSignature, payment: a.payment, payer: a.data.payer, held: a.data.held.toString(), refundable: a.data.refundable.toString(), proof: a.proof,
      lifetime: { blockhash: l.blockhash, lastValidBlockHeight: l.lastValidBlockHeight.toString(), blockhashSlot: l.blockhashSlot!.toString() }, unsignedBase64: getBase64EncodedWireTransaction(tx), messageHash: messageHash(tx.messageBytes) }));
  });
}
/** One explicit submission, with no internal signing and no retry. */
export async function submitPayerRecovery(o: PayerRecoveryOptions & { offer: PayerRecoveryOffer; consent: PayerRecoveryConsent; transactionBase64: string; backend: { simulate(transaction: Transaction, deadline: number): ReturnType<Ledger["simulate"]>; submit(transaction: Transaction, deadline: number): ReturnType<Ledger["submit"]> } }): Promise<{ signature: string; result: SubmitResult }> {
  o = { ...o, identity: { ...o.identity }, backend: { simulate: o.backend.simulate.bind(o.backend), submit: o.backend.submit.bind(o.backend) } };
  // Pin caller input before the first await; mutable external objects never rewrite consent.
  const input = json(JSON.stringify({ offer: o.offer, consent: o.consent, transactionBase64: o.transactionBase64 }));
  return fenced(o, async c => {
    const offer = input.offer as PayerRecoveryOffer; validateConsent(input.consent, offer); await validateOfferShape(offer, o);
    const tx = await exactSignedReclaim(input.transactionBase64, offer), signature = getSignatureFromTransaction(tx);
    const a = await assess(c, offer.proof.retryAfter); freshProof(offer.proof, a.proof);
    const validity = await c.read(() => o.reader.getFinalizedBlockhashStatus(offer.lifetime.blockhash, BigInt(offer.lifetime.blockhashSlot), c.deadline));
    if (validity.kind !== "ok" || validity.valid !== true || !slot(validity.slot) || validity.slot < BigInt(offer.lifetime.blockhashSlot)) refuse();
    // Backend sees only a non-broadcastable wire until all persistence has completed.
    const simulation = await c.read(() => o.backend.simulate({ ...tx, signatures: { [offer.payer as Address]: null } }, c.deadline));
    c.guard(); if (!simulation.ok) refuse();
    const final = await assess(c, offer.proof.retryAfter); freshProof(offer.proof, final.proof);
    const record: RecordV1 = { version: 1, kind: "unknown-capture-payer-recovery", offer, offerSha256: payerRecoveryOfferDigest(offer), consent: input.consent, submissionProof: final.proof, signature, transactionBase64: input.transactionBase64,
      originals: [...a.s.bytes].filter(([name]) => name.startsWith(`orders/${o.orderId}.json`) || name.startsWith("facilitator/")).map(([name, raw]) => ({ name, base64: raw.toString("base64") })) };
    const recordPath = join(pathFor(o.domain, "orders"), recordName(o.orderId, offer.messageHash));
    c.guard(); sameRecoveryPins(a.s.pins, snapshot(c).pins);
    if (Buffer.byteLength(JSON.stringify(record)) > 1000000) refuse();
    const raw = createRecoveryRecord(recordPath, record); if (readRecoveryRecord(recordPath) !== raw) refuse();
    const afterRecord = snapshot(c);
    sameRecoveryPins(a.s.pins, afterRecord.pins.filter(p => !(p.role === "orders" && p.name === recordName(o.orderId, offer.messageHash))));
    const recordPin = afterRecord.pins.find(p => p.role === "orders" && p.name === recordName(o.orderId, offer.messageHash)); if (!recordPin) refuse();
    const journal = new FileSubmissionJournal(pathFor(o.domain, "reclaim"), { coordination: o.domain });
    c.guard(); journal.prepare({ payerRecoveryRecord: { name: recordPin.name, sha256: recordPin.sha256, identity: recordPin.identity }, signature, messageHash: offer.messageHash, transactionBase64: input.transactionBase64, operation: "reclaim", payment: offer.payment, payer: offer.payer,
      blockhash: offer.lifetime.blockhash, blockhashSlot: offer.lifetime.blockhashSlot, lastValidBlockHeight: offer.lifetime.lastValidBlockHeight,
      expectedHeld: offer.held, expectedRefundable: offer.refundable, ...(offer.proof.retryAfter ? { retryAfter: offer.proof.retryAfter } : {}), ...(offer.proof.reclaimRecovery ? { reclaimRecovery: offer.proof.reclaimRecovery } : {}) });
    const reserved = snapshot(c), expectedNames = [recordName(o.orderId, offer.messageHash), `${signature}.json`, offer.proof.retryAfter ? `reclaim-${offer.payment}-after-${offer.proof.retryAfter}.lock` : `reclaim-${offer.payment}.lock`];
    sameRecoveryPins(a.s.pins, reserved.pins.filter(p => !(p.role === "orders" && p.name === expectedNames[0] || p.role === "reclaim" && expectedNames.slice(1).includes(p.name))));
    await attributed(c, reserved, json(a.s.bytes.get(`orders/${o.orderId}.json`)!));
    c.guard(); sameRecoveryPins(reserved.pins, snapshot(c).pins); if (readRecoveryRecord(recordPath) !== raw) refuse();
    // Fresh proof after persistence still cannot waive a reservation. Refusal here means
    // this exact signature must be reconciled; even an unsent prepared attempt is not reused.
    const captureStatus = await c.read(() => o.reader.getSignatureStatus(o.captureSignature));
    if (captureStatus.kind !== "not-found" || statusSlot(captureStatus) < BigInt(final.proof.capture.observedSlot)) refuse();
    const minimum = statusSlot(captureStatus) > BigInt(final.proof.clock.slot) ? statusSlot(captureStatus) : BigInt(final.proof.clock.slot);
    const paymentNow = await c.read(() => o.reader.getAccountAtLeast(offer.payment as Address, minimum));
    if (paymentNow.kind !== "ok" || !slot(paymentNow.slot) || paymentNow.slot < minimum || !paymentNow.account || paymentNow.account.owner !== o.identity.programId || paymentNow.account.executable !== false || Buffer.from(paymentNow.account.data).toString("base64") !== offer.proof.payment.dataBase64) refuse();
    const paymentNowSlot = paymentNow.slot;
    const clockNow = await c.read(() => o.reader.getClockAtLeast(paymentNowSlot, c.deadline));
    if (clockNow.kind !== "ok" || clockNow.commitment !== "finalized" || !slot(clockNow.slot) || clockNow.slot < paymentNowSlot || clockNow.unixTimestamp < BigInt(final.proof.clock.unixTimestamp)) refuse();
    const hashNow = await c.read(() => o.reader.getFinalizedBlockhashStatus(offer.lifetime.blockhash, BigInt(offer.lifetime.blockhashSlot), c.deadline));
    if (hashNow.kind !== "ok" || hashNow.valid !== true || !slot(hashNow.slot) || hashNow.slot < BigInt(offer.lifetime.blockhashSlot)) refuse();
    c.guard(); sameRecoveryPins(reserved.pins, snapshot(c).pins);
    let result: SubmitResult;
    try { result = await o.backend.submit(tx, c.deadline); }
    catch { try { c.guard(); sameRecoveryPins(reserved.pins, snapshot(c).pins); journal.resolve(signature, { result: "submit-threw", recordedAt: new Date().toISOString() }); } catch { /* reservations remain */ } throw new Error(`payer reclaim response lost; reconcile original signature ${signature}`); }
    // Do not erase a response-persistence failure or report durable success on a failed fsync.
    c.guard(); sameRecoveryPins(reserved.pins, snapshot(c).pins);
    journal.resolve(signature, { ...submissionOutcome(result), recordedAt: new Date().toISOString() });
    return { signature, result };
  });
}
/** Explicit same-signature observation only. No simulate, sign, draft, or submit parameter. */
export async function reconcilePayerRecovery(o: PayerRecoveryOptions & { reclaimSignature: string }): Promise<SignatureLookup> {
  o = { ...o, identity: { ...o.identity } };
  return fenced(o, async c => {
    const s = snapshot(c), order = json(s.bytes.get(`orders/${o.orderId}.json`)!);
    const { entries } = await attributed(c, s, order), entry = entries.find(e => e.signature === o.reclaimSignature); if (!entry || !isSignature(o.reclaimSignature)) refuse();
    if (s.bytes.get(`reclaim/${entry.retryAfter ? `reclaim-${entry.payment}-after-${entry.retryAfter}.lock` : `reclaim-${entry.payment}.lock`}`)?.toString() !== entry.signature || s.bytes.get(`orders/${o.orderId}.json.busy`)?.toString() !== o.action) refuse();
    const status = await c.read(() => o.reader.getSignatureStatus(entry.signature));
    if (!isU64Decimal(entry.blockhashSlot) || statusSlot(status) < BigInt(entry.blockhashSlot!)) refuse();
    sameRecoveryPins(s.pins, snapshot(c).pins);
    const prior = entry.attempts[0]?.outcome?.result;
    if (status.kind === "found" && status.commitment === "finalized" && (prior === "finalized-succeeded" && status.err !== null || prior === "finalized-failed" && status.err === null)) refuse();
    if (status.kind === "found" && status.commitment === "finalized" && (status.err === null || typeof status.err === "string" && status.err.length)) {
      new FileSubmissionJournal(pathFor(o.domain, "reclaim"), { coordination: o.domain }).resolve(entry.signature, { result: status.err === null ? "finalized-succeeded" : "finalized-failed", recordedAt: new Date().toISOString(), ...(status.err === null ? {} : { detail: status.err }) });
    }
    return status;
  });
}
