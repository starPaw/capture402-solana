import { getAddressDecoder, getBase58Decoder } from "@solana/kit";
import type { V2OrderBinding, V2OrderRequest } from "../../src/v2-order-journal.ts";
const address = (byte: number) => getAddressDecoder().decode(new Uint8Array(32).fill(byte));
export const orderBinding: V2OrderBinding = { namespace: "synthetic-orders", network: "solana:synthetic-v2",
  genesisHash: address(6), programId: address(43), merchant: address(2), providerId: "synthetic-loopback" };
export const orderRequest: V2OrderRequest = { orderId: "a".repeat(64), payer: address(1), mint: address(3),
  rentRefundRecipient: address(4), feePayer: address(5), payment: address(7), salt: "b".repeat(64),
  authorizeUntilSlot: "20", maximum: "100", captureDeadline: "1100", refundDeadline: "1200",
  blockhash: address(8), lastValidBlockHeight: "500", messageBase64: Buffer.from("synthetic-reviewed-message").toString("base64") };
export const signedAttempt = { signature: getBase58Decoder().decode(new Uint8Array(64).fill(1)), transactionBase64: Buffer.from("synthetic-signed-wire").toString("base64") };
