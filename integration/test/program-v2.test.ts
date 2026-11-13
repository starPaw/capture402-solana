import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { getSignatureFromTransaction } from "@solana/kit";
import { createHarness, DC, DR, type Harness } from "./fixture.ts";
import { decodeInstructionData, decodePayment, LOCAL_PROGRAM_ID, paymentAddress, U64_MAX } from "../src/program.ts";
import {
  authorizeV2Instruction, authorizeV2Data, closeEmptyVaultV2Instruction, closePaymentV2Instruction,
  decodePaymentV2, LOCAL_V2_PROGRAM_ID, observePaymentV2, paymentV2Address, voidV2Instruction,
  type V2Stored,
} from "../src/lifecycle.ts";
import { authorizePayload, buildTransaction, encodeTransaction } from "../src/transactions.ts";
import { FileSubmissionJournal, messageHash } from "../src/submission-journal.ts";
import { OperationStore } from "../src/operation-store.ts";
import { demoComputeInstructions } from "../src/demo-compute.ts";

describe("sole v2 lifecycle", () => {
let h: Harness;
const directories: string[] = [];
const directory = () => { const path = mkdtempSync(join(tmpdir(), "capture402-v2-test-")); directories.push(path); return path; };
beforeAll(async () => {
  h = await createHarness();
  h.svm.addProgramFromFile(LOCAL_V2_PROGRAM_ID, fileURLToPath(new URL("../../target/deploy/svm_auth_capture.so", import.meta.url)));
});
afterAll(async () => { await h?.close(); for (const path of directories) rmSync(path, { recursive: true, force: true }); });

function identity(): V2Stored {
  const clock = h.svm.getClock(); clock.slot = 10n; clock.unixTimestamp = 1_000n; h.svm.setClock(clock);
  return { protocolVersion: 2, programId: LOCAL_V2_PROGRAM_ID, payer: h.payer.address, server: h.server.address,
    mint: h.mint, rentRefundRecipient: h.facilitatorKey.address, salt: h.newSalt(), authorizeUntilSlot: 20n };
}
const auth = (s: V2Stored) => authorizeV2Instruction({ ...s, maximum: 100n, captureDeadline: DC, refundDeadline: DR, observedSlot: 10n });

test("v2 SDK binds all signed terms and derives a separate expiry-bound identity", async () => {
  const s = identity(), original = s.salt.slice();
  const ix = await auth(s);
  expect(ix.data?.length).toBe(75); expect(ix.data?.[1]).toBe(2);
  expect(decodeInstructionData(new Uint8Array(ix.data!))).toMatchObject({authorizeUntilSlot:20n});
  expect(ix.accounts?.[6]?.address).toBe(s.rentRefundRecipient);
  expect(await paymentV2Address(s)).not.toBe(await paymentAddress(s.programId, s.payer, s.salt, 1500n));
  expect(await paymentV2Address(s)).not.toBe(await paymentV2Address({ ...s, authorizeUntilSlot: 21n }));
  h.ok(await h.direct([ix], [h.payer, h.facilitatorKey]));
  const account = await h.ledger.getAccount(await paymentV2Address(s));
  expect(account).not.toBeNull(); expect(decodePayment(account!.data)).toMatchObject({protocolVersion:2});
  expect(decodePaymentV2(account!.data)).toMatchObject({ protocolVersion: 2, authorizeUntilSlot: 20n,
    rentRefundRecipient: s.rentRefundRecipient, held: 100n, refundable: 0n, captureDeadline: DC, refundDeadline: DR });
  expect(decodePaymentV2(account!.data.subarray(0, 176))).toBeNull();
  const padded = new Uint8Array(217); padded.set(account!.data); expect(decodePaymentV2(padded)).toBeNull();
  expect(s.salt).toEqual(original);
});

test.each([-1n, U64_MAX, U64_MAX + 1n])("v2 SDK rejects unsafe expiry %s without wrapping", async expiry => {
  const s = identity(); await expect(paymentV2Address({ ...s, authorizeUntilSlot: expiry })).rejects.toThrow();
});

test("v2 never refreshes invalid terms", async () => {
  const s = identity();
  await expect(auth({ ...s, salt: new Uint8Array(31) })).rejects.toThrow();
  await expect(auth({ ...s, authorizeUntilSlot: 9n })).rejects.toThrow();
  await expect(auth({ ...s, authorizeUntilSlot: 1511n })).rejects.toThrow();
  expect(() => authorizeV2Data(s, U64_MAX + 1n, DC, DR)).toThrow();
  expect(() => authorizeV2Data(s, 1n, DR, DC)).toThrow();
  expect(() => authorizeV2Data(s, 1n, 0n, DR)).toThrow();
  expect(() => authorizeV2Data(s, 1n, DC, 1n << 63n)).toThrow();
});

test("facilitator refuses obsolete authorization bytes before signing or submission", async () => {
  const s = identity(), ix = await auth(s), data = new Uint8Array(ix.data!).slice(0,67); data[1]=1;
  const tx = await buildTransaction({ feePayer: h.facilitatorKey.address, instructions: [{...ix,data}],
    signers: [h.payer], lifetime: h.lifetime() });
  const before = h.ledger.submissions.length;
  const result = await h.facilitator.settle(h.body(authorizePayload(tx)));
  expect(result.success).toBe(false); expect(h.ledger.submissions.length).toBe(before);
});

test.each([false, true])("lost authorize response stays UNKNOWN after restart; landed=%s", async landed => {
  const s = identity(), payment = await paymentV2Address(s), path = directory();
  const journal = new FileSubmissionJournal(join(path, "authorize"));
  const reservations = new OperationStore(join(path, "orders"));
  const orderKey = "a".repeat(64);
  reservations.reserve(orderKey, "synthetic-payer", "synthetic-order");
  const tx = await buildTransaction({ feePayer: h.setup.address, instructions: [await auth(s)],
    signers: [h.setup, h.payer, h.facilitatorKey], lifetime: h.lifetime() });
  const original = { signature: getSignatureFromTransaction(tx), messageHash: messageHash(tx.messageBytes),
    transactionBase64: encodeTransaction(tx), blockhash: h.lifetime().blockhash, operation: "authorize" as const,
    payment, payer: s.payer, expectedHeld: "0", expectedRefundable: "0" };
  journal.prepare(original); // Simulated crash after persistence: no terminal outcome is saved.
  if (landed) {
    h.ok(h.svm.sendTransaction(tx));
    expect(await observePaymentV2(s, h.ledger)).toMatchObject({ outcome: "UNKNOWN", account: "present" });
    h.ok(await h.direct([await voidV2Instruction(s, 100n, 0n)], [h.server]));
    const clock = h.svm.getClock(); clock.slot = 21n; h.svm.setClock(clock);
    h.ok(await h.direct([await closeEmptyVaultV2Instruction(s), await closePaymentV2Instruction(s)]));
  }
  const restarted = new FileSubmissionJournal(join(path, "authorize"));
  expect(await observePaymentV2(s, h.ledger)).toEqual({ outcome: "UNKNOWN", account: "absent" });
  expect(restarted.read(original.signature)).toMatchObject(original);
  expect(restarted.read(original.signature)?.attempts).toHaveLength(1);
  expect(restarted.read(original.signature)?.attempts[0]?.outcome).toBeUndefined();
  expect(() => restarted.prepare(original)).toThrow("never rebroadcast");
  expect(() => new OperationStore(join(path, "orders")).reserve(orderKey, "synthetic-payer", "synthetic-order")).toThrow();
});

test("lost cleanup response cannot be inferred from missing accounts or another closer", async () => {
  const s = identity(); h.ok(await h.direct([await auth(s)], [h.payer, h.facilitatorKey]));
  h.ok(await h.direct([await voidV2Instruction(s, 100n, 0n)], [h.server]));
  const clock = h.svm.getClock(); clock.slot = 21n; h.svm.setClock(clock);
  const observation = await observePaymentV2(s, h.ledger);
  h.ok(await h.direct([await closeEmptyVaultV2Instruction(s), await closePaymentV2Instruction(s)]));
  expect(observation).toMatchObject({ outcome: "UNKNOWN", account: "present" });
  expect(await observePaymentV2(s, h.ledger)).toEqual({ outcome: "UNKNOWN", account: "absent" });
  expect(await observePaymentV2(s, { getAccount: async () => { throw Error("pruned or unavailable RPC"); } })).toEqual({ outcome: "UNKNOWN", account: "unavailable" });
  const foreign = { ...(await h.ledger.getAccount(h.mint))!, owner: s.programId };
  expect(await observePaymentV2(s, { getAccount: async () => foreign })).toEqual({ outcome: "UNKNOWN", account: "invalid" });
});
});
