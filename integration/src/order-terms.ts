// Merchant-issued business identity. A client must not manufacture another order
// key by editing an offer, salt, expiry or PDA. The MAC is not payer consent.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { PaymentRequirements } from "./types.ts";

export const businessOrderKey = (merchant: string, id: string) => createHash("sha256")
  .update(JSON.stringify(["capture402-order-v2", merchant, id])).digest("hex");
function message(r: PaymentRequirements): string {
  const e = r.extra!;
  return JSON.stringify(["capture402-order-offer-v2", r.scheme, r.network, r.asset, r.payTo, r.amount, r.maxTimeoutSeconds,
    e.protocolVersion, e.programId, e.feePayer, e.paymentFlow, e.captureDeadline, e.refundDeadline, e.authorizeUntilSlot, e.orderId]);
}
export function sealOrderTerms(r: PaymentRequirements, key: string): PaymentRequirements {
  if (!key) throw Error("trusted order signing key required");
  return { ...r, extra: { ...r.extra, orderProof: createHmac("sha256", key).update(message(r)).digest("hex") } };
}
export function validOrderTerms(r: PaymentRequirements, key: string | undefined): boolean {
  const proof = r.extra?.orderProof;
  if (!key || typeof proof !== "string" || !/^[a-f0-9]{64}$/.test(proof)
      || r.extra?.protocolVersion !== 2 || typeof r.extra?.orderId !== "string" || !/^[a-f0-9]{64}$/.test(r.extra.orderId)) return false;
  return timingSafeEqual(Buffer.from(proof, "hex"), createHmac("sha256", key).update(message(r)).digest());
}
