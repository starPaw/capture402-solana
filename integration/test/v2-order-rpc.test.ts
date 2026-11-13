import { expect, test, vi } from "vitest";
import type { Rpc, SolanaRpcApi } from "@solana/kit";
import { V2OrderRpcTransport } from "../src/v2-order-rpc.ts";
import { validV2ErrorJson } from "../src/v2-order-evidence.ts";
import { orderBinding, signedAttempt } from "./fixtures/v2-order-fixture.ts";

const sendable = (value: unknown) => ({ send: vi.fn(async () => value) });
function fixture() {
  const status: any = { confirmationStatus: "finalized", slot: 10n, err: null };
  const tx: any = { slot: 10n, meta: { err: null }, transaction: [signedAttempt.transactionBase64, "base64"] };
  const rpc = { getGenesisHash: vi.fn(() => sendable(orderBinding.genesisHash)),
    sendTransaction: vi.fn(() => sendable(signedAttempt.signature)),
    getSignatureStatuses: vi.fn(() => sendable({ value: [status] })), getTransaction: vi.fn(() => sendable(tx)) };
  const adapter = new V2OrderRpcTransport({ ...orderBinding, rpc: rpc as unknown as Rpc<SolanaRpcApi>,
    observeTimeoutMs: 5, pollIntervalMs: 1, requestTimeoutMs: 5 });
  return { status, tx, rpc, adapter };
}
test("explicit RPC uses exact original wire once with maxRetries=0 and finalized evidence", async () => {
  const f = fixture(); expect(await f.adapter.getGenesisHash()).toBe(orderBinding.genesisHash);
  expect(await f.adapter.sendOnce(signedAttempt.transactionBase64)).toBe(signedAttempt.signature);
  expect(f.rpc.sendTransaction).toHaveBeenCalledExactlyOnceWith(signedAttempt.transactionBase64,
    { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 0n });
  expect(await f.adapter.finalizedReceipt(signedAttempt.signature)).toEqual({ ...signedAttempt, commitment: "finalized", slot: 10n, errorJson: null });
  expect(f.rpc.getSignatureStatuses).toHaveBeenCalledWith([signedAttempt.signature], { searchTransactionHistory: true });
  expect(f.rpc.getTransaction).toHaveBeenCalledWith(signedAttempt.signature,
    { commitment: "finalized", encoding: "base64", maxSupportedTransactionVersion: 0 });
});
test.each(["processed", "confirmed", "absent", "pruned", "wrong-slot", "different-error", "missing-metadata"])("%s evidence cannot finalize", async mode => {
  const f = fixture();
  if (["processed", "confirmed"].includes(mode)) f.status.confirmationStatus = mode;
  if (mode === "absent") f.rpc.getSignatureStatuses.mockImplementation(() => sendable({ value: [null] }));
  if (mode === "pruned") f.rpc.getTransaction.mockImplementation(() => sendable(null));
  if (mode === "wrong-slot") f.tx.slot = 11n;
  if (mode === "different-error") f.tx.meta.err = "AccountNotFound";
  if (mode === "missing-metadata") f.tx.meta = null;
  expect(await f.adapter.finalizedReceipt(signedAttempt.signature)).toBeNull();
  expect(f.rpc.sendTransaction).not.toHaveBeenCalled();
});
test("matching finalized failure is retained, never retried", async () => {
  const f = fixture(); f.status.err = f.tx.meta.err = { InstructionError: [0n, { Custom: 7n }] };
  expect(await f.adapter.finalizedReceipt(signedAttempt.signature)).toMatchObject({ errorJson: '{"InstructionError":[0,{"Custom":7}]}' });
  expect(f.rpc.sendTransaction).not.toHaveBeenCalled();
});
test.each(["true", "false", "0", "null", "[]", "{}", '"unknown-error"', '{"InstructionError":[0,"unknown-error"]}',
  '{"InstructionError":[256,"InsufficientFunds"]}', '{"InstructionError":[0,{"Custom":-1}]}', "partial"])("malformed error %s remains UNKNOWN", async raw => {
  expect(validV2ErrorJson(raw)).toBe(false);
  if (raw === "partial") return;
  const f = fixture(); f.tx.meta.err = f.status.err = JSON.parse(raw);
  // null is successful execution; it is invalid only as an encoded failure string.
  if (raw !== "null") expect(await f.adapter.finalizedReceipt(signedAttempt.signature)).toBeNull();
});
test("lost acknowledgement propagates uncertainty after just one send", async () => {
  const f = fixture(), send = vi.fn(async () => { throw Error("synthetic transport timeout"); });
  f.rpc.sendTransaction.mockReturnValue({ send });
  await expect(f.adapter.sendOnce(signedAttempt.transactionBase64)).rejects.toThrow("timeout");
  expect(send).toHaveBeenCalledTimes(1); expect(f.rpc.getSignatureStatuses).not.toHaveBeenCalled();
});
test.each([0, -1, Infinity, NaN, 60_001, 1.5])("invalid timeout %s is refused", timeout => {
  expect(() => new V2OrderRpcTransport({ ...orderBinding, rpc: {} as never, requestTimeoutMs: timeout })).toThrow();
});
