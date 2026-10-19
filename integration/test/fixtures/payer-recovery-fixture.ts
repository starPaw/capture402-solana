import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getBase64Encoder, getTransactionDecoder, getBase64EncodedWireTransaction, partiallySignTransaction, type Blockhash } from "@solana/kit";
import { outcomeFixture, type OutcomeFixtureKeys } from "./outcome-fixture.ts";
import { offerPayerRecovery, submitPayerRecovery, payerRecoveryOfferDigest, type PayerRecoveryOptions, type PayerRecoveryReader, type PayerRecoveryOffer } from "../../src/payer-recovery.ts";
import type { Ledger } from "../../src/ledger.ts";
export async function payerFixture(keys?: OutcomeFixtureKeys) {
  const f = await outcomeFixture(true, false, "beer", keys), captureJournal = join(f.paths.facilitator, f.signature + ".json");
  const entry = JSON.parse(readFileSync(captureJournal, "utf8"));
  entry.lifetimeProvenance = { version: 1, messageHash: entry.messageHash, blockhash: entry.blockhash,
    observation: { state: "recorded", source: "first-party", value: { version: 1, messageHash: entry.messageHash, blockhash: entry.blockhash, lastValidBlockHeight: "10", contextSlot: "10", commitment: "finalized", network: f.identity.network, genesisHash: f.identity.genesisHash } },
    origin: { state: "verified", blockhash: entry.blockhash, slot: "10", commitment: "finalized", network: f.identity.network, genesisHash: f.identity.genesisHash } };
  f.persist(captureJournal, entry);
  const hash = f.order.payer as unknown as Blockhash;
  const reader: PayerRecoveryReader = { verifyIdentity: async () => f.identity,
    getSignatureStatus: async sig => sig === f.authSignature ? { kind: "found", commitment: "finalized", slot: 30n, observedSlot: 41n, err: null } : { kind: "not-found", observedSlot: sig === f.signature ? 41n : 55n },
    findSignaturesByMessage: async () => { throw new Error("cannot replace original"); }, isBlockhashValid: async () => { throw new Error("bare invalid hash"); },
    getAccountAtLeast: async (_a, minimum) => ({ kind: "ok", slot: minimum > 42n ? minimum : 42n, account: f.account }),
    getClockAtLeast: async minimum => ({ kind: "ok", commitment: "finalized", slot: minimum > 43n ? minimum : 43n, unixTimestamp: 1000n }),
    verifyBlockhashOrigin: async (blockhash, candidate, genesis, network) => ({ state: "verified", blockhash, slot: candidate.toString(), commitment: "finalized", network, genesisHash: genesis }),
    getFinalizedBlockhashStatus: async (blockhash, origin) => ({ kind: "ok", valid: blockhash === hash, slot: origin > 41n ? origin : 41n }) };
  const options: PayerRecoveryOptions = { domain: f.domain, enrollment: f.enrollment, identity: f.identity, orderId: f.id, action: "beer", captureSignature: f.signature, reader };
  const lifetime = { blockhash: hash, lastValidBlockHeight: 1000n, blockhashSlot: 44n, contextSlot: 44n, commitment: "finalized" as const, network: f.identity.network, genesisHash: f.identity.genesisHash };
  const calls = { simulation: 0, submission: 0, wire: "" };
  const backend: Pick<Ledger, "simulate" | "submit"> = { simulate: async tx => { calls.simulation++; if (Object.values(tx.signatures).some(Boolean)) throw new Error("broadcastable simulation"); return { ok: true }; },
    submit: async tx => { calls.submission++; calls.wire = getBase64EncodedWireTransaction(tx); return { kind: "submitted" }; } };
  const offer = () => offerPayerRecovery({ ...options, lifetime });
  async function signed(offer: PayerRecoveryOffer) {
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(offer.unsignedBase64));
    return getBase64EncodedWireTransaction(await partiallySignTransaction([f.payer.keyPair], tx));
  }
  function consent(offer: PayerRecoveryOffer) { const digest = payerRecoveryOfferDigest(offer); return { offerSha256: digest, payer: offer.payer, payment: offer.payment, accept: true as const, ownerAuthorization: `payer-reclaim:${offer.payment}:${digest}:disposable-synthetic-only` }; }
  async function request(value?: PayerRecoveryOffer) { const offerValue = value ?? await offer(); return { ...options, offer: offerValue, consent: consent(offerValue), transactionBase64: await signed(offerValue), backend }; }
  return { ...f, captureJournal, options, recoveryReader: reader, lifetime, calls, backend, offer, signed, consent, request, submit: async () => submitPayerRecovery(await request()) };
}
