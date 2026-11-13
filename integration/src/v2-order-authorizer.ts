// The opt-in v2 service authorization boundary. One durable business-order claim
// precedes signing; no API in this module resets, re-signs or resubmits a claim.
import {
  getCompiledTransactionMessageDecoder, getPublicKeyFromAddress, getSignatureFromTransaction,
  getTransactionDecoder, verifySignature, type Address, type SignatureBytes,
} from "@solana/kit";
import { authorizeV2Instruction, paymentV2Address } from "./lifecycle.ts";
import { buildTransaction, encodeTransaction, type Lifetime } from "./transactions.ts";
import { validV2ErrorJson } from "./v2-order-evidence.ts";
import {
  canonicalBase64, canonicalV2OrderRequest, V2OrderJournal,
  type V2OrderBinding, type V2OrderLease, type V2OrderSnapshot, type V2OrderObservation,
} from "./v2-order-journal.ts";

export type V2OrderIntent = {
  /** Stable merchant business ID (hex SHA-256 or opaque 32 bytes), obtained from
   * trusted order storage. Never accept a client-supplied retry/idempotency ID. */
  orderId: string;
  payer: Address;
  mint: Address;
  salt: Uint8Array;
  authorizeUntilSlot: bigint;
  maximum: bigint;
  captureDeadline: bigint;
  refundDeadline: bigint;
  observedSlot: bigint;
  lifetime: Lifetime;
};
export type V2FinalizedReceipt = {
  signature: string;
  commitment: "finalized";
  slot: bigint;
  transactionBase64: string;
  /** null is successful execution; a non-null value is a finalized failure. */
  errorJson: string | null;
};
export interface V2OrderTransport {
  readonly network: string;
  readonly providerId: string;
  getGenesisHash(): Promise<string>;
  /** Implementations MUST send once, without transport/RPC economic retries. */
  sendOnce(transactionBase64: string): Promise<string>;
  /** Read-only, bounded observation of this exact signature on the same provider.
   * No account-absence inference. Missing/pruned/non-finalized evidence is null. */
  finalizedReceipt(signature: string): Promise<V2FinalizedReceipt | null>;
}
export type V2OrderAuthorizerConfig = {
  journal: V2OrderJournal;
  feePayer: Address;
  rentRefundRecipient: Address;
  transport: V2OrderTransport;
  /** Trusted consent/signing boundary, called only for a newly durable claim.
   * Sign exactly these bytes with all required signers; never send them here. */
  sign: (unsignedTransactionBase64: string) => Promise<string>;
};
export type V2OrderAuthorizationResult = {
  kind: "attempt" | "existing" | "blocked";
  /** true means the stored original attempt has different terms/message bytes. */
  conflict: boolean;
  snapshot: V2OrderSnapshot;
};

const unknown = (): V2OrderSnapshot => ({ status: "UNKNOWN", reason: "incomplete-journal" });
const unavailable = () => Error("v2 authorization evidence unavailable; retain original order and UNKNOWN");

/** Reconstruct and compare the complete canonical wire, then verify EVERY required
 * signature. Comparing to the service-built message also excludes added fees,
 * instructions, accounts, lookups, altered terms and blockhash replacement. */
async function verifySignedWire(wire: string, expectedMessage: string): Promise<string> {
  if (!canonicalBase64(wire)) throw unavailable();
  const tx = getTransactionDecoder().decode(Buffer.from(wire, "base64"));
  if (encodeTransaction(tx) !== wire || Buffer.from(tx.messageBytes).toString("base64") !== expectedMessage) throw unavailable();
  const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  if (message.version !== "legacy") throw unavailable();
  const required = message.staticAccounts.slice(0, message.header.numSignerAccounts);
  if (!required.length || Object.keys(tx.signatures).length !== required.length) throw unavailable();
  for (const address of required) {
    const signature = tx.signatures[address];
    if (!signature || !(await verifySignature(await getPublicKeyFromAddress(address), signature as SignatureBytes, tx.messageBytes))) throw unavailable();
  }
  return getSignatureFromTransaction(tx);
}

export class V2OrderAuthorizer {
  private readonly journal: V2OrderJournal;
  private readonly binding: Readonly<V2OrderBinding>;
  private readonly feePayer: Address;
  private readonly rentRefundRecipient: Address;
  private readonly transport: V2OrderTransport;
  private readonly sign: V2OrderAuthorizerConfig["sign"];

  constructor(config: V2OrderAuthorizerConfig) {
    this.journal = config.journal; this.journal.assert();
    this.binding = this.journal.enrollment.binding;
    this.feePayer = config.feePayer; this.rentRefundRecipient = config.rentRefundRecipient;
    // Bind the configured callbacks once: a later replacement of a config object
    // cannot silently select another signer, endpoint or transport implementation.
    const transport = config.transport;
    this.transport = Object.freeze({ network: transport.network, providerId: transport.providerId,
      getGenesisHash: transport.getGenesisHash.bind(transport), sendOnce: transport.sendOnce.bind(transport),
      finalizedReceipt: transport.finalizedReceipt.bind(transport) });
    this.sign = config.sign;
    this.assertPins();
  }
  private assertPins(): void {
    this.journal.assert();
    if (this.transport.network !== this.binding.network || this.transport.providerId !== this.binding.providerId) throw unavailable();
  }
  private async verifyProvider(): Promise<void> {
    this.assertPins();
    if (await this.transport.getGenesisHash() !== this.binding.genesisHash) throw unavailable();
    this.assertPins();
  }

  /** Application callers must authenticate and load the stable business order
   * before invoking this method. All workers for that merchant use ONE enrolled
   * store. A distinct store/namespace or direct blockchain transaction is outside
   * this service guarantee. AUTHORIZED is a hold, never proof of paid delivery. */
  async authorize(input: V2OrderIntent): Promise<V2OrderAuthorizationResult> {
    // Copy mutable inputs before the first await. No caller-owned buffer reaches
    // the signer or persists after a concurrent request mutates its request object.
    const intent = { ...input, salt: new Uint8Array(input.salt), lifetime: { ...input.lifetime } };
    const identity = { protocolVersion: 2 as const, programId: this.binding.programId,
      server: this.binding.merchant, payer: intent.payer, mint: intent.mint,
      rentRefundRecipient: this.rentRefundRecipient, salt: intent.salt, authorizeUntilSlot: intent.authorizeUntilSlot };
    if (intent.lifetime.network !== undefined && intent.lifetime.network !== this.binding.network
        || intent.lifetime.genesisHash !== undefined && intent.lifetime.genesisHash !== this.binding.genesisHash) throw unavailable();
    const transaction = await buildTransaction({ feePayer: this.feePayer, signers: [], lifetime: intent.lifetime,
      instructions: [await authorizeV2Instruction({ ...identity, maximum: intent.maximum,
        captureDeadline: intent.captureDeadline, refundDeadline: intent.refundDeadline, observedSlot: intent.observedSlot })] });
    const request = canonicalV2OrderRequest({ orderId: intent.orderId, payer: intent.payer, mint: intent.mint,
      rentRefundRecipient: this.rentRefundRecipient, feePayer: this.feePayer, payment: await paymentV2Address(identity),
      salt: Buffer.from(intent.salt).toString("hex"), authorizeUntilSlot: intent.authorizeUntilSlot.toString(),
      maximum: intent.maximum.toString(), captureDeadline: intent.captureDeadline.toString(), refundDeadline: intent.refundDeadline.toString(),
      blockhash: intent.lifetime.blockhash, lastValidBlockHeight: intent.lifetime.lastValidBlockHeight.toString(),
      messageBase64: Buffer.from(transaction.messageBytes).toString("base64") });
    let lease: V2OrderLease | undefined;
    try {
      this.assertPins();
      const claim = this.journal.claim(request);
      if (claim.kind === "existing") return claim;
      lease = claim.lease;
      await this.verifyProvider();
      this.journal.assertSigning(lease);
      const wire = await this.sign(encodeTransaction(transaction));
      const signature = await verifySignedWire(wire, request.messageBase64);
      this.journal.signed(lease, { signature, transactionBase64: wire });
      await this.verifyProvider();
      this.journal.dispatch(lease);
      this.journal.assertDispatch(lease);
      // Persist uncertainty BEFORE the first possible network side effect. A lost
      // response cannot grant another lease, even if the provider never received it.
      const acknowledged = await this.transport.sendOnce(wire);
      if (acknowledged !== signature) throw unavailable();
      const receipt = await this.transport.finalizedReceipt(signature);
      await this.verifyProvider();
      let observation: V2OrderObservation = { status: "UNKNOWN", signature, commitment: null, evidence: null };
      if (receipt !== null) {
        if (receipt.commitment !== "finalized" || receipt.signature !== signature || receipt.transactionBase64 !== wire
            || typeof receipt.slot !== "bigint" || receipt.slot < 0n || receipt.slot >= 1n << 64n
            || !(receipt.errorJson === null || validV2ErrorJson(receipt.errorJson))) throw unavailable();
        observation = { status: receipt.errorJson === null ? "AUTHORIZED" : "FAILED", signature, commitment: "finalized",
          evidence: { slot: receipt.slot.toString(), transactionBase64: wire, errorJson: receipt.errorJson } };
      }
      this.journal.observe(lease, observation);
      return { kind: "attempt", conflict: false, snapshot: this.journal.snapshot(request.orderId) };
    } catch {
      if (lease) this.journal.block(lease);
      // Never propagate a provider exception containing URLs/credentials or wires.
      // Never turn a persistence failure into a new store or fresh signing attempt.
      let snapshot = unknown();
      try { snapshot = this.journal.snapshot(request.orderId); } catch { /* retain UNKNOWN */ }
      return { kind: "blocked", conflict: false, snapshot };
    }
  }
}
