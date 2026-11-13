// V2 lifecycle helpers for the only supported protocol.
// This module neither signs, submits, retries nor selects an expiry.
import { getAddressDecoder, getProgramDerivedAddress, getAddressEncoder, type Address, type Instruction } from "@solana/kit";
import {
  ata, authorizeAccounts, authorizeData, decodePayment, paymentAddress,
  I64_MAX, LOCAL_PROGRAM_ID, NATIVE_MINT, SYSTEM_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS,
  toInstruction, U64_MAX, type Payment,
} from "./program.ts";
import { captureInstruction, reclaimInstruction, refundInstruction, voidInstruction } from "./transactions.ts";
import type { LedgerAccount } from "./ledger.ts";

export { LOCAL_PROGRAM_ID as LOCAL_V2_PROGRAM_ID, PAYMENT_LEN as PAYMENT_V2_LEN,
  DISCRIMINATOR as V2_DISCRIMINATOR, SEED as V2_SEED } from "./program.ts";
export const MAX_FUTURE_AUTH_SLOTS = 1_500n;
export const V2Tag = { closeEmptyVault: 5, sweepSurplus: 6, closePayment: 7, recoverRetired: 8 } as const;
export type PaymentV2 = Payment & { protocolVersion: 2; authorizeUntilSlot: bigint; rentRefundRecipient: Address };

export type V2Identity = {
  protocolVersion: 2;
  /** Must be a separately trusted v2 deployment pin. No live default exists. */
  programId: Address;
  payer: Address;
  salt: Uint8Array;
  authorizeUntilSlot: bigint;
};
export type V2Stored = V2Identity & { server: Address; mint: Address; rentRefundRecipient: Address };

function u64(value: bigint, name: string): Uint8Array {
  if (typeof value !== "bigint" || value < 0n || value > U64_MAX) throw Error(`Invalid v2 ${name}`);
  const data = new Uint8Array(8); new DataView(data.buffer).setBigUint64(0, value, true); return data;
}
function identity(s: V2Identity) {
  if (s.protocolVersion !== 2 || s.salt.length !== 32) throw Error("Invalid explicit v2 identity");
  u64(s.authorizeUntilSlot, "authorization expiry");
  if (s.authorizeUntilSlot === U64_MAX) throw Error("v2 expiry needs a representable successor slot");
}

export async function paymentV2Address(s: V2Identity): Promise<Address> {
  identity(s);
  return paymentAddress(s.programId, s.payer, s.salt, s.authorizeUntilSlot);
}

/** Exact discriminator/length; v1 bytes and truncated v2 data are never reinterpreted. */
export function decodePaymentV2(data: Uint8Array): PaymentV2 | null {
  return decodePayment(data);
}

export function authorizeV2Data(s: V2Identity, maximum: bigint, dc: bigint, dr: bigint): Uint8Array {
  identity(s); u64(maximum, "maximum");
  if (maximum === 0n || typeof dc !== "bigint" || typeof dr !== "bigint" || dc <= 0n || dr < dc || dr > I64_MAX) throw Error("Invalid v2 terms");
  return authorizeData(s.salt, maximum, dc, dr, s.authorizeUntilSlot);
}

export async function authorizeV2Instruction(s: V2Stored & {
  maximum: bigint; captureDeadline: bigint; refundDeadline: bigint;
  /** A verified chain slot observed before consent; both slot and blockhash lifetimes still apply at execution. */
  observedSlot: bigint;
}): Promise<Instruction> {
  u64(s.observedSlot, "observed slot");
  if (s.authorizeUntilSlot < s.observedSlot || s.authorizeUntilSlot - s.observedSlot > MAX_FUTURE_AUTH_SLOTS) throw Error("v2 authorization window expired or too distant");
  if (s.payer === s.server || s.mint === NATIVE_MINT) throw Error("Invalid v2 parties or mint");
  const payment = await paymentV2Address(s);
  return toInstruction(s.programId, authorizeAccounts({ payer: s.payer, server: s.server, payment, mint: s.mint,
    source: await ata(s.payer, s.mint), vault: await ata(payment, s.mint), funder: s.rentRefundRecipient }),
    authorizeV2Data(s, s.maximum, s.captureDeadline, s.refundDeadline));
}

async function stored(s: V2Stored) { return { ...s, payment: await paymentV2Address(s) }; }
function consent(h: bigint, f: bigint) { u64(h, "held consent"); u64(f, "refundable consent"); }
export async function captureV2Instruction(s: V2Stored, amount: bigint, release: boolean, h: bigint, f: bigint): Promise<Instruction> {
  consent(h, f); u64(amount, "capture amount");
  if (typeof release !== "boolean" || amount === 0n || amount > h || amount + f > U64_MAX) throw Error("Invalid v2 capture");
  return captureInstruction(await stored(s), amount, release, h, f);
}
export async function voidV2Instruction(s: V2Stored, h: bigint, f: bigint): Promise<Instruction> {
  consent(h, f); return voidInstruction(await stored(s), h, f);
}
export async function refundV2Instruction(s: V2Stored, amount: bigint, h: bigint, f: bigint): Promise<Instruction> {
  consent(h, f); u64(amount, "refund amount"); if (amount === 0n || amount > f) throw Error("Invalid v2 refund");
  return refundInstruction(await stored(s), amount, h, f);
}
export async function reclaimV2Instruction(s: V2Stored): Promise<Instruction> { return reclaimInstruction(await stored(s)); }

const slot = (address: Address, writable = false) => ({ address, writable, signer: false });
async function cleanup(s: V2Stored, tag: 5 | 6 | 7): Promise<Instruction> {
  const payment = await paymentV2Address(s);
  const slots = [slot(payment, tag === 7), slot(s.mint), slot(await ata(payment, s.mint), tag !== 7),
    slot(tag === 6 ? await ata(s.payer, s.mint) : s.rentRefundRecipient, true)];
  if (tag !== 7) slots.push(slot(TOKEN_PROGRAM_ADDRESS));
  return toInstruction(s.programId, slots, Uint8Array.of(tag));
}
export const closeEmptyVaultV2Instruction = (s: V2Stored) => cleanup(s, 5);
export const sweepSurplusV2Instruction = (s: V2Stored) => cleanup(s, 6);
export const closePaymentV2Instruction = (s: V2Stored) => cleanup(s, 7);

export async function recoverRetiredV2Instruction(s: V2Identity & { mint: Address }): Promise<Instruction> {
  const payment = await paymentV2Address(s);
  const data = new Uint8Array(41); data[0] = 8; data.set(s.salt, 1); data.set(u64(s.authorizeUntilSlot, "authorization expiry"), 33);
  return toInstruction(s.programId, [slot(s.payer, true), slot(payment, true), slot(s.mint), slot(await ata(payment, s.mint), true),
    slot(await ata(s.payer, s.mint), true), slot(SYSTEM_PROGRAM_ADDRESS), slot(TOKEN_PROGRAM_ADDRESS)], data);
}

/** Account observations are never original transaction evidence. This read-only
 * result cannot release reservations, deliver work, or authorize a new attempt.
 * The calling application must retain the original order key, exact signed wire,
 * signatures and both journals. Original finalized receipts are read separately. */
export async function observePaymentV2(s: V2Identity, reader: { getAccount(address: Address): Promise<LedgerAccount | null> }): Promise<
  { outcome: "UNKNOWN"; account: "absent" | "invalid" | "unavailable" } |
  { outcome: "UNKNOWN"; account: "present"; state: PaymentV2 }
> {
  const payment = await paymentV2Address(s);
  let account: LedgerAccount | null;
  try { account = await reader.getAccount(payment); } catch { return { outcome: "UNKNOWN", account: "unavailable" }; }
  if (!account) return { outcome: "UNKNOWN", account: "absent" };
  const state = decodePaymentV2(account.data);
  if (account.owner !== s.programId || account.executable || !state || state.payer !== s.payer ||
      state.authorizeUntilSlot !== s.authorizeUntilSlot || !state.salt.every((b, i) => b === s.salt[i])) return { outcome: "UNKNOWN", account: "invalid" };
  return { outcome: "UNKNOWN", account: "present", state };
}
