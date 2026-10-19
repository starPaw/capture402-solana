// Application delivery proof over the existing auth-capture ABI. No economic retry.
import { type Address, getBase64Encoder, getCompiledTransactionMessageDecoder, getSignatureFromTransaction, getTransactionDecoder, type Transaction } from "@solana/kit";
import { ata, bytesEqual, decodePayment } from "./program.ts";
import type { ChainReader } from "./reconciliation.ts";
import type { ResourceServerConfig } from "./resource-server.ts";

export type TokenObservation = { accountIndex: number; mint: string; owner?: string; amount: string };
export type FinalizedTransactionEvidence =
  | { kind: "unavailable" }
  | { kind: "ok"; slot: bigint; transactionBase64: string; accounts: readonly string[];
      before: readonly TokenObservation[]; after: readonly TokenObservation[] };
export type ReportProofReader = Pick<ChainReader, "getSignatureStatus" | "getAccountAtLeast"> & {
  getFinalizedTransaction(signature: string): Promise<FinalizedTransactionEvidence>;
};
export type ReportTerms = {
  payer: Address; payment: Address; salt: string; maximum: string; captureDeadline: string; refundDeadline: string;
};
export type ReportProof = { signature: string; slot: string; held: string; refundable: string;
  tokenDeltas: { payer: string; merchant: string; vault: string } };

export async function proveReportSettlement(
  config: ResourceServerConfig,
  reader: ReportProofReader,
  terms: ReportTerms,
  transaction: Transaction,
  signature: string,
  expected: { held: bigint; refundable: bigint; payerDelta: bigint; merchantDelta: bigint; vaultDelta: bigint },
): Promise<ReportProof> {
  const status = await reader.getSignatureStatus(signature);
  if (status.kind !== "found" || status.commitment !== "finalized" || status.err !== null) throw new Error("original finality unavailable");
  const evidence = await reader.getFinalizedTransaction(signature);
  if (evidence.kind !== "ok" || evidence.slot !== status.slot) throw new Error("original transaction metadata unavailable");
  const original = getTransactionDecoder().decode(getBase64Encoder().encode(evidence.transactionBase64));
  if (getSignatureFromTransaction(original) !== signature || !bytesEqual(new Uint8Array(original.messageBytes), new Uint8Array(transaction.messageBytes))) {
    throw new Error("transaction metadata differs from original message");
  }
  // Use the submitted message's account list, never metadata-supplied account substitutions.
  const accounts = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes).staticAccounts;
  if (accounts.join(",") !== evidence.accounts.join(",")) throw new Error("transaction account mapping differs");
  function amount(observations: readonly TokenObservation[], address: Address, owner: Address): bigint {
    const index = accounts.indexOf(address);
    const matches = observations.filter(item => item.accountIndex === index);
    if (matches.length > 1) throw new Error("duplicate token metadata");
    const entry = matches[0];
    // New ATAs have no pre-balance. An untouched merchant ATA may have no entry at all.
    if (!entry) return 0n;
    if (index < 0 || entry.mint !== config.asset || entry.owner !== owner || !/^(0|[1-9][0-9]*)$/.test(entry.amount)) {
      throw new Error("token metadata identity differs");
    }
    return BigInt(entry.amount);
  }
  const payerAta = await ata(terms.payer, config.asset);
  const merchantAta = await ata(config.server.address, config.asset);
  const vault = await ata(terms.payment, config.asset);
  const deltas = {
    payer: amount(evidence.after, payerAta, terms.payer) - amount(evidence.before, payerAta, terms.payer),
    merchant: amount(evidence.after, merchantAta, config.server.address) - amount(evidence.before, merchantAta, config.server.address),
    vault: amount(evidence.after, vault, terms.payment) - amount(evidence.before, vault, terms.payment),
  };
  if (deltas.payer !== expected.payerDelta || deltas.merchant !== expected.merchantDelta || deltas.vault !== expected.vaultDelta) {
    throw new Error("original token effects differ");
  }
  const snapshot = await reader.getAccountAtLeast(terms.payment, status.slot);
  if (snapshot.kind !== "ok" || snapshot.slot < status.slot || snapshot.account?.owner !== config.programId) {
    throw new Error("fenced payment unavailable");
  }
  const payment = decodePayment(snapshot.account.data);
  if (!payment || payment.payer !== terms.payer || payment.server !== config.server.address || payment.mint !== config.asset ||
      Buffer.from(payment.salt).toString("hex") !== terms.salt || payment.maximum.toString() !== terms.maximum ||
      payment.captureDeadline.toString() !== terms.captureDeadline || payment.refundDeadline.toString() !== terms.refundDeadline ||
      payment.held !== expected.held || payment.refundable !== expected.refundable) throw new Error("fenced payment terms or H/F differ");
  return { signature, slot: status.slot.toString(), held: payment.held.toString(), refundable: payment.refundable.toString(),
    tokenDeltas: { payer: deltas.payer.toString(), merchant: deltas.merchant.toString(), vault: deltas.vault.toString() } };
}
