import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { getSignatureFromTransaction, getTransactionDecoder, partiallySignTransaction, type Address } from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import { V2OrderAuthorizer, type V2FinalizedReceipt, type V2OrderIntent } from "../src/v2-order-authorizer.ts";
import { initializeV2OrderJournal, V2OrderJournal } from "../src/v2-order-journal.ts";
import { encodeTransaction } from "../src/transactions.ts";
import { ata } from "../src/program.ts";
import { captureV2Instruction, closeEmptyVaultV2Instruction, closePaymentV2Instruction,
  LOCAL_V2_PROGRAM_ID, paymentV2Address, voidV2Instruction, type V2Stored } from "../src/lifecycle.ts";
import { createHarness, DC, DR, type Harness } from "./fixture.ts";
import { orderBinding } from "./fixtures/v2-order-fixture.ts";

describe("v2 common order authorization service (compiled SBF)", () => {
  let h: Harness;
  const directories: string[] = [];
  beforeAll(async () => {
    h = await createHarness();
    h.svm.addProgramFromFile(LOCAL_V2_PROGRAM_ID, fileURLToPath(new URL("../../target/deploy/svm_auth_capture.so", import.meta.url)));
  });
  afterAll(async () => { await h?.close(); for (const dir of directories) rmSync(dir, { recursive: true, force: true }); });
  function fixture() {
    const clock = h.svm.getClock(); clock.slot = 10n; clock.unixTimestamp = 1000n; h.svm.setClock(clock);
    const parent = mkdtempSync(join(tmpdir(), "capture402-v2-authorizer-")); directories.push(parent);
    const root = join(parent, "store"), binding = { ...orderBinding, merchant: h.server.address, programId: LOCAL_V2_PROGRAM_ID };
    const enrollment = initializeV2OrderJournal(root, binding), journal = new V2OrderJournal(root, enrollment);
    const intent: V2OrderIntent = { orderId: "a".repeat(64), payer: h.payer.address, mint: h.mint, salt: h.newSalt(),
      authorizeUntilSlot: 20n, maximum: 100n, captureDeadline: DC, refundDeadline: DR, observedSlot: 10n, lifetime: h.lifetime() };
    let receipt: V2FinalizedReceipt | null = null;
    const transport = {
      network: binding.network, providerId: binding.providerId, getGenesisHash: vi.fn(async () => binding.genesisHash),
      sendOnce: vi.fn(async (wire: string): Promise<string> => {
        const tx = getTransactionDecoder().decode(Buffer.from(wire, "base64")), signature = getSignatureFromTransaction(tx);
        const result = h.svm.sendTransaction(tx);
        let errorJson: string | null = null;
        if (result instanceof FailedTransactionMetadata) {
          const error = result.err();
          if (typeof error !== "object" || !("index" in error) || !("err" in error)) throw Error("unexpected fixture failure");
          expect(error.index).toBe(0); expect(error.err()).toBe(5); // Pinned LiteSVM InstructionErrorFieldless.InsufficientFunds.
          errorJson = JSON.stringify({ InstructionError: [error.index, "InsufficientFunds"] });
        }
        receipt = { signature, transactionBase64: wire, commitment: "finalized", slot: 10n,
          errorJson };
        return signature;
      }),
      finalizedReceipt: vi.fn(async (_signature: string) => receipt),
    };
    const sign = vi.fn(async (wire: string) => encodeTransaction(await partiallySignTransaction(
      [h.setup.keyPair, h.facilitatorKey.keyPair, h.payer.keyPair], getTransactionDecoder().decode(Buffer.from(wire, "base64")))));
    const config = { journal, feePayer: h.setup.address, rentRefundRecipient: h.facilitatorKey.address, transport, sign };
    const service = () => new V2OrderAuthorizer({ ...config, journal: new V2OrderJournal(root, enrollment) });
    const stored: V2Stored = { ...intent, protocolVersion: 2, programId: LOCAL_V2_PROGRAM_ID,
      server: h.server.address, rentRefundRecipient: h.facilitatorKey.address };
    return { root, enrollment, journal, intent, transport, sign, config, service, stored };
  }
  const changed = (intent: V2OrderIntent) => ({ ...intent, salt: h.newSalt(), authorizeUntilSlot: intent.authorizeUntilSlot + 1n });
  const balance = (address: Address) => { const account = h.svm.getAccount(address); if (!account.exists) throw Error("fixture account absent"); return account.lamports; };
  const saved = (journal: V2OrderJournal, orderId: string) => readdirSync(journal.orderPath(orderId)).sort()
    .map(name => [name, readFileSync(join(journal.orderPath(orderId), name)).toString("base64")]);

  test("paid order remains blocked with a new E/salt after full rent return, deletion and service restart", async () => {
    const f = fixture(), payment = await paymentV2Address(f.stored), vault = await ata(payment, h.mint);
    const payerAta = await ata(h.payer.address, h.mint), merchantAta = await ata(h.server.address, h.mint);
    const payerBefore = h.tokens(payerAta), merchantBefore = h.tokens(merchantAta);
    expect(await f.service().authorize(f.intent)).toMatchObject({ kind: "attempt", snapshot: { status: "AUTHORIZED" } });
    h.ok(await h.direct([await captureV2Instruction(f.stored, 100n, true, 100n, 0n)], [h.server]));
    const deposit = balance(payment) + balance(vault);
    const sponsorBefore = balance(h.facilitatorKey.address);
    const clock = h.svm.getClock(); clock.slot = 21n; clock.unixTimestamp = DR; h.svm.setClock(clock);
    h.ok(await h.direct([await closeEmptyVaultV2Instruction(f.stored), await closePaymentV2Instruction(f.stored)]));
    expect(h.svm.getAccount(payment).exists).toBe(false); expect(h.svm.getAccount(vault).exists).toBe(false);
    expect(balance(h.facilitatorKey.address)).toBe(sponsorBefore + deposit);
    const original = saved(f.journal, f.intent.orderId);
    expect(await f.service().authorize(changed(f.intent))).toMatchObject({ kind: "existing", conflict: true, snapshot: { status: "AUTHORIZED" } });
    expect(await f.service().authorize(f.intent)).toMatchObject({ kind: "existing", conflict: false, snapshot: { status: "AUTHORIZED" } });
    expect(f.sign).toHaveBeenCalledTimes(1); expect(f.transport.sendOnce).toHaveBeenCalledTimes(1);
    expect(saved(f.journal, f.intent.orderId)).toEqual(original);
    expect(h.tokens(payerAta)).toBe(payerBefore - 100n); expect(h.tokens(merchantAta)).toBe(merchantBefore + 100n);
  });

  test.each([false, true])("lost send response, landed=%s: UNKNOWN survives closure and restart", async landed => {
    const f = fixture(), submit = f.transport.sendOnce.getMockImplementation()!;
    f.transport.sendOnce.mockImplementation(async wire => { if (landed) await submit(wire); throw Error("synthetic lost response"); });
    expect(await f.service().authorize(f.intent)).toMatchObject({ kind: "blocked", snapshot: { status: "UNKNOWN", reason: "dispatch-uncertain" } });
    if (landed) {
      h.ok(await h.direct([await voidV2Instruction(f.stored, 100n, 0n)], [h.server]));
      const clock = h.svm.getClock(); clock.slot = 21n; h.svm.setClock(clock);
      h.ok(await h.direct([await closeEmptyVaultV2Instruction(f.stored), await closePaymentV2Instruction(f.stored)]));
    }
    expect(h.svm.getAccount(await paymentV2Address(f.stored)).exists).toBe(false);
    const original = saved(f.journal, f.intent.orderId);
    expect(await f.service().authorize(changed(f.intent))).toMatchObject({ kind: "existing", conflict: true, snapshot: { status: "UNKNOWN" } });
    expect(saved(f.journal, f.intent.orderId)).toEqual(original);
    expect(f.sign).toHaveBeenCalledTimes(1); expect(f.transport.sendOnce).toHaveBeenCalledTimes(1);
  });

  test("parallel requests sharing a store sign and submit only one attempt", async () => {
    const f = fixture();
    const results = await Promise.all(Array.from({ length: 12 }, () => f.service().authorize(changed(f.intent))));
    expect(results.filter(result => result.kind === "attempt")).toHaveLength(1);
    expect(results.filter(result => result.kind === "existing")).toHaveLength(11);
    expect(f.sign).toHaveBeenCalledTimes(1); expect(f.transport.sendOnce).toHaveBeenCalledTimes(1);
  });

  test.each(["missing-signature", "altered-message", "trailing-wire", "throw"])("signer %s cannot submit; order stays reserved", async attack => {
    const f = fixture(), sign = f.sign.getMockImplementation()!;
    f.sign.mockImplementation(async wire => {
      if (attack === "throw") throw Error("synthetic signer failure");
      if (attack === "missing-signature") return wire;
      const signed = Buffer.from(await sign(wire), "base64");
      if (attack === "altered-message") { signed[signed.length - 1] = signed[signed.length - 1]! ^ 1; return signed.toString("base64"); }
      return Buffer.concat([signed, Buffer.of(0)]).toString("base64");
    });
    expect(await f.service().authorize(f.intent)).toMatchObject({ snapshot: { status: "UNKNOWN" } });
    expect(await f.service().authorize(changed(f.intent))).toMatchObject({ kind: "existing" });
    expect(f.sign).toHaveBeenCalledTimes(1); expect(f.transport.sendOnce).not.toHaveBeenCalled();
  });

  test.each(["signature", "wire", "commitment", "slot", "missing", "throw", "genesis", "malformed-error"])("untrusted receipt %s cannot settle UNKNOWN", async attack => {
    const f = fixture(), observe = f.transport.finalizedReceipt.getMockImplementation()!;
    f.transport.finalizedReceipt.mockImplementation(async signature => {
      const receipt = (await observe(signature))!;
      if (attack === "throw") throw Error("synthetic unavailable history");
      if (attack === "missing") return null;
      if (attack === "genesis") { f.transport.getGenesisHash.mockResolvedValue(h.payer.address); return receipt; }
      if (attack === "malformed-error") return { ...receipt, errorJson: "false" };
      return { ...receipt, ...(attack === "signature" ? { signature: "1".repeat(88) } : attack === "wire" ? { transactionBase64: "YQ==" }
        : attack === "slot" ? { slot: -1n } : { commitment: "confirmed" as never }) };
    });
    expect(await f.service().authorize(f.intent)).toMatchObject({ snapshot: { status: "UNKNOWN" } });
    expect(await f.service().authorize(changed(f.intent))).toMatchObject({ kind: "existing", snapshot: { status: "UNKNOWN" } });
    expect(f.transport.sendOnce).toHaveBeenCalledTimes(1); expect(f.sign).toHaveBeenCalledTimes(1);
  });

  test.each([0, 1, 2])("invalid required signature %s blocks RPC and preserves the order", async index => {
    const f = fixture(), sign = f.sign.getMockImplementation()!;
    f.sign.mockImplementation(async wire => {
      const bytes = Buffer.from(await sign(wire), "base64");
      expect(bytes[0]).toBe(3); bytes[1 + index * 64] = bytes[1 + index * 64]! ^ 1;
      return bytes.toString("base64");
    });
    expect(await f.service().authorize(f.intent)).toMatchObject({ snapshot: { status: "UNKNOWN" } });
    expect(await f.service().authorize(changed(f.intent))).toMatchObject({ kind: "existing" });
    expect(f.transport.sendOnce).not.toHaveBeenCalled(); expect(f.sign).toHaveBeenCalledTimes(1);
  });

  test("wrong acknowledgement never switches to another signature's receipt", async () => {
    const f = fixture(); f.transport.sendOnce.mockResolvedValue("1".repeat(88));
    expect(await f.service().authorize(f.intent)).toMatchObject({ snapshot: { status: "UNKNOWN", reason: "dispatch-uncertain" } });
    expect(f.transport.finalizedReceipt).not.toHaveBeenCalled();
    expect(await f.service().authorize(changed(f.intent))).toMatchObject({ kind: "existing" });
    expect(f.transport.sendOnce).toHaveBeenCalledTimes(1);
  });

  test("genesis drift after signing retains the wire and prevents dispatch", async () => {
    const f = fixture(); f.transport.getGenesisHash.mockResolvedValueOnce(f.enrollment.binding.genesisHash).mockResolvedValue(h.payer.address);
    expect(await f.service().authorize(f.intent)).toMatchObject({ snapshot: { status: "UNKNOWN", reason: "signed" } });
    expect(f.sign).toHaveBeenCalledTimes(1); expect(f.transport.sendOnce).not.toHaveBeenCalled();
    expect(await f.service().authorize(changed(f.intent))).toMatchObject({ kind: "existing" });
  });

  test("finalized failure permanently retains the order and original receipt", async () => {
    const f = fixture(); f.intent.maximum = 1_000_000n;
    expect(await f.service().authorize(f.intent)).toMatchObject({ snapshot: { status: "FAILED" } });
    expect(await f.service().authorize({ ...changed(f.intent), maximum: 1n })).toMatchObject({ kind: "existing", conflict: true, snapshot: { status: "FAILED" } });
    expect(f.transport.sendOnce).toHaveBeenCalledTimes(1);
  });

  test("corrupt reservation during genesis read prevents signing", async () => {
    const f = fixture(); f.transport.getGenesisHash.mockImplementation(async () => {
      writeFileSync(join(f.journal.orderPath(f.intent.orderId), "claim.json"), "partial"); return f.enrollment.binding.genesisHash;
    });
    expect(await f.service().authorize(f.intent)).toMatchObject({ snapshot: { status: "UNKNOWN" } });
    expect(f.sign).not.toHaveBeenCalled(); expect(f.transport.sendOnce).not.toHaveBeenCalled();
    expect(await f.service().authorize(changed(f.intent))).toMatchObject({ kind: "existing" });
  });

  test("wrong genesis prevents signing; missing store never reinitializes", async () => {
    const f = fixture(); f.transport.getGenesisHash.mockResolvedValue(h.payer.address);
    expect(await f.service().authorize(f.intent)).toMatchObject({ snapshot: { status: "UNKNOWN" } });
    expect(f.sign).not.toHaveBeenCalled(); expect(f.transport.sendOnce).not.toHaveBeenCalled();
    rmSync(f.root, { recursive: true }); expect(() => f.service()).toThrow();
  });

  test("input mutation and extra runtime fields cannot replace trusted program/merchant terms", async () => {
    const f = fixture(), service = f.service(), originalSalt = f.intent.salt.slice();
    const result = service.authorize({ ...f.intent, programId: h.mint, server: h.payer.address } as V2OrderIntent);
    f.intent.salt.fill(0); f.intent.lifetime.blockhash = h.mint as never;
    expect(await result).toMatchObject({ snapshot: { status: "AUTHORIZED" } });
    expect(h.svm.getAccount(await paymentV2Address({ ...f.stored, salt: originalSalt })).exists).toBe(true);
  });
});
