import { sealOrderTerms } from "../src/order-terms.ts";
// Opt-in, disposable Agave 4.4 check. The endpoint is generated here, always loopback;
// no installed CLI configuration, external RPC, wallet, or deployment is used.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  createSolanaRpc, generateKeyPairSigner, getAddressDecoder, getSignatureFromTransaction,
  getTransactionDecoder, partiallySignTransaction,
  type Address, type Instruction, type KeyPairSigner,
} from "@solana/kit";
import { getCreateAccountInstruction, getTransferSolInstruction } from "@solana-program/system";
import {
  getCreateAssociatedTokenIdempotentInstruction, getFreezeAccountInstruction,
  getInitializeMint2Instruction, getMintToInstruction, getThawAccountInstruction,
  getTokenDecoder,
  getTransferCheckedInstruction,
} from "@solana-program/token";
import { ata, ASSOCIATED_TOKEN_PROGRAM_ADDRESS, decodePayment, LOCAL_PROGRAM_ID, paymentAddress, TOKEN_PROGRAM_ADDRESS } from "../src/program.ts";
import {
  authorizeInstruction, buildTransaction, captureInstruction, encodeTransaction,
  reclaimInstruction, refundInstruction, voidInstruction,
} from "../src/transactions.ts";
import {
  LOCAL_V2_PROGRAM_ID, authorizeV2Instruction, captureV2Instruction, closeEmptyVaultV2Instruction,
  closePaymentV2Instruction, decodePaymentV2, paymentV2Address, reclaimV2Instruction,
  recoverRetiredV2Instruction, refundV2Instruction, sweepSurplusV2Instruction, voidV2Instruction,
  type V2Stored,
} from "../src/lifecycle.ts";
import { V2OrderAuthorizer, type V2OrderIntent } from "../src/v2-order-authorizer.ts";
import { initializeV2OrderJournal, V2OrderJournal } from "../src/v2-order-journal.ts";
import { V2OrderRpcTransport } from "../src/v2-order-rpc.ts";

const expectedAgave = process.env.CAPTURE402_TEST_AGAVE_VERSION ?? "4.4.0-rc.1";
assert(["4.4.0-rc.1", "4.4.1"].includes(expectedAgave), "unsupported local validator version");
assert(execFileSync("solana-test-validator", ["--version"], { encoding: "utf8" }).startsWith(`solana-test-validator ${expectedAgave} `));
const binary = fileURLToPath(new URL("../../target/deploy/svm_auth_capture.so", import.meta.url));
const executable = readFileSync(binary);
const binarySha256 = createHash("sha256").update(executable).digest("hex");
const sponsor = await generateKeyPairSigner(true); // Exportable only for disposable subprocess fixtures.
const rentFunder = await generateKeyPairSigner();
const payer = await generateKeyPairSigner();
const merchant = await generateKeyPairSigner();
const mint = await generateKeyPairSigner();
const reservation = createServer();
reservation.listen(0, "127.0.0.1");
await once(reservation, "listening");
const port = (reservation.address() as { port: number }).port;
await new Promise<void>(resolve => reservation.close(() => resolve()));
assert(port < 65_450, "allocated port must leave room for the isolated validator");
const url = `http://127.0.0.1:${port}`;
const directory = mkdtempSync(join(tmpdir(), "capture402-agave-local-"));
const config = join(directory, "cli.yml");
writeFileSync(config, JSON.stringify({ json_rpc_url: url, websocket_url: "", keypair_path: "unused", commitment: "confirmed" }));
const log = join(directory, "validator.log");
const logFd = openSync(log, "w", 0o600);
const validator = spawn("solana-test-validator", [
  "--config", config, "--bind-address", "127.0.0.1", "--rpc-port", String(port),
  "--faucet-port", String(port + 2), "--gossip-port", String(port + 3),
  "--dynamic-port-range", `${port + 4}-${port + 54}`, "--ledger", join(directory, "ledger"),
  "--limit-blockstore-size", "10000", "--mint", sponsor.address,
  "--upgradeable-program", LOCAL_PROGRAM_ID, binary, "none", "--log",
], { stdio: ["ignore", logFd, logFd] });
closeSync(logFd);
const exited = new Promise<void>(resolve => validator.once("close", () => resolve()));
let processError: Error | undefined;
validator.once("error", error => { processError = error; });

async function rpc(method: string, params: unknown[] = []): Promise<any> {
  const response = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(5_000), redirect: "error",
  });
  assert(response.ok);
  const result = await response.json() as { result?: unknown; error?: unknown };
  assert(!result.error, JSON.stringify(result.error));
  return result.result;
}

async function account(address: string) {
  const result = await rpc("getAccountInfo", [address, { encoding: "base64", commitment: "confirmed" }]);
  assert(result.value, `missing fixture account ${address}`);
  return { ...result.value, data: Buffer.from(result.value.data[0], "base64") };
}

async function clock(): Promise<bigint> {
  const value = await account("SysvarC1ock11111111111111111111111111111111");
  return value.data.readBigInt64LE(32);
}

let previousBlockhash = "";
const cleanupMetrics: { operations: number[]; bytes: number; fee: number; computeUnits: number }[] = [];
async function send(instructions: Instruction[], signers: KeyPairSigner[], failure = false) {
  let latest;
  const deadline = Date.now() + 20_000;
  do {
    latest = await rpc("getLatestBlockhash", [{ commitment: "confirmed" }]);
    if (latest.value.blockhash !== previousBlockhash) break;
    assert(Date.now() < deadline, "fresh local blockhash timeout");
    await delay(100);
  } while (true);
  previousBlockhash = latest.value.blockhash;
  const transaction = await buildTransaction({ feePayer: sponsor.address, instructions,
    signers: [sponsor, ...signers], lifetime: latest.value });
  const signature = getSignatureFromTransaction(transaction);
  const wireLength = Buffer.from(encodeTransaction(transaction), "base64").length;
  // Exactly one submission. Unexpected/uncertain outcomes fail this disposable run.
  assert.equal(await rpc("sendTransaction", [encodeTransaction(transaction), {
    encoding: "base64", skipPreflight: failure, preflightCommitment: "confirmed", maxRetries: 0,
  }]), signature);
  while (Date.now() < deadline) {
    const status = (await rpc("getSignatureStatuses", [[signature]])).value[0];
    if (status && ["confirmed", "finalized"].includes(status.confirmationStatus)) {
      assert.equal(status.err !== null, failure, JSON.stringify(status));
      const transaction = await rpc("getTransaction", [signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
      if (transaction) {
        const operations = instructions.filter(ix => ix.programAddress === LOCAL_V2_PROGRAM_ID && ix.data![0]! >= 5).map(ix => ix.data![0]!);
        if (!failure && operations.length) cleanupMetrics.push({ operations, bytes: wireLength,
          fee: transaction.meta.fee, computeUnits: transaction.meta.computeUnitsConsumed });
        return transaction.meta;
      }
    }
    await delay(100);
  }
  throw new Error("local transaction outcome unresolved; no retry");
}

try {
  const startupDeadline = Date.now() + 45_000;
  let version;
  while (!version) {
    if (processError) throw processError;
    assert(validator.exitCode === null && validator.signalCode === null, "local validator exited during startup");
    assert(Date.now() < startupDeadline, "local validator startup timeout");
    try { version = await rpc("getVersion"); } catch { await delay(200); }
  }
  assert.equal(version["solana-core"], expectedAgave);
  // Genesis program accounts may be visible before the executable cache is ready.
  // Probe by simulation only; never resubmit setup or payment transactions.
  for (const programAddress of [LOCAL_PROGRAM_ID, LOCAL_V2_PROGRAM_ID, TOKEN_PROGRAM_ADDRESS, ASSOCIATED_TOKEN_PROGRAM_ADDRESS]) {
    const readyDeadline = Date.now() + 20_000;
    while (true) {
      const latest = await rpc("getLatestBlockhash", [{ commitment: "confirmed" }]);
      const probe = await buildTransaction({ feePayer: sponsor.address, signers: [sponsor], lifetime: latest.value,
        instructions: [{ programAddress, accounts: [], data: new Uint8Array() }] });
      const result = (await rpc("simulateTransaction", [encodeTransaction(probe), { encoding: "base64", commitment: "confirmed", sigVerify: true }])).value;
      if (result.err === null || (Array.isArray(result.err?.InstructionError) && result.err.InstructionError[1] !== "UnsupportedProgramId")) break;
      assert(Date.now() < readyDeadline, `genesis program not ready: ${programAddress} ${JSON.stringify(result)}`);
      await delay(200);
    }
  }
  const program = await account(LOCAL_PROGRAM_ID);
  assert.equal(program.executable, true);
  assert.equal(program.owner, "BPFLoaderUpgradeab1e11111111111111111111111");
  const programData = await account(getAddressDecoder().decode(program.data.subarray(4, 36)));
  assert(programData.data.subarray(45, 45 + executable.length).equals(executable), "genesis executable must match the source build");
  assert(programData.data.subarray(45 + executable.length).every((byte: number) => byte === 0));
  const payerAta = await ata(payer.address, mint.address);
  const merchantAta = await ata(merchant.address, mint.address);
  await send([
    getCreateAccountInstruction({ payer: sponsor, newAccount: mint,
      lamports: BigInt(await rpc("getMinimumBalanceForRentExemption", [82])), space: 82n, programAddress: TOKEN_PROGRAM_ADDRESS }),
    getInitializeMint2Instruction({ mint: mint.address, decimals: 6, mintAuthority: sponsor.address, freezeAuthority: sponsor.address }),
    getCreateAssociatedTokenIdempotentInstruction({ payer: sponsor, owner: payer.address, mint: mint.address, ata: payerAta }),
    getCreateAssociatedTokenIdempotentInstruction({ payer: sponsor, owner: merchant.address, mint: mint.address, ata: merchantAta }),
    getMintToInstruction({ mint: mint.address, token: payerAta, mintAuthority: sponsor, amount: 1_000n }),
  ], [mint]);
  const amount = async (address: Address) => getTokenDecoder().decode((await account(address)).data).amount;
  const stored = async (saltByte: number, captureDeadline: bigint) => {
    const salt = new Uint8Array(32).fill(saltByte);
    const authorizeUntilSlot = BigInt(await rpc("getSlot", [{commitment:"confirmed"}])) + 1000n;
    const payment = await paymentAddress(LOCAL_PROGRAM_ID, payer.address, salt, authorizeUntilSlot);
    await send([await authorizeInstruction({ programId: LOCAL_PROGRAM_ID, payer: payer.address,
      server: merchant.address, mint: mint.address, funder: sponsor.address, salt, authorizeUntilSlot,
      maximum: 100n, captureDeadline, refundDeadline: captureDeadline + 120n })], [payer]);
    return { programId: LOCAL_PROGRAM_ID, payer: payer.address, server: merchant.address, mint: mint.address, payment };
  };
  const check = async (s: Awaited<ReturnType<typeof stored>>, held: bigint, refundable: bigint, payerAmount: bigint, merchantAmount: bigint) => {
    const p = decodePayment((await account(s.payment)).data);
    assert(p);
    assert.equal(p.held, held); assert.equal(p.refundable, refundable);
    assert.equal(p.maximum, 100n); assert.equal(p.payer, payer.address); assert.equal(p.server, merchant.address);
    assert.equal(await amount(await ata(s.payment, mint.address)), held);
    assert.equal(await amount(payerAta), payerAmount); assert.equal(await amount(merchantAta), merchantAmount);
  };

  const first = await stored(1, (await clock()) + 120n);
  await check(first, 100n, 0n, 900n, 0n);
  // A failing second CPI must roll back the successful merchant leg as well.
  await send([getFreezeAccountInstruction({ account: payerAta, mint: mint.address, owner: sponsor })], []);
  const rollback = await send([await captureInstruction(first, 40n, true, 100n, 0n)], [merchant], true);
  assert.deepEqual(rollback.err, { InstructionError: [0, { Custom: 17 }] }); // SPL AccountFrozen.
  assert.equal(rollback.logMessages.filter((line: string) => line === `Program ${TOKEN_PROGRAM_ADDRESS} invoke [2]`).length, 2);
  assert.equal(rollback.logMessages.filter((line: string) => line === `Program ${TOKEN_PROGRAM_ADDRESS} success`).length, 1);
  await check(first, 100n, 0n, 900n, 0n);
  await send([getThawAccountInstruction({ account: payerAta, mint: mint.address, owner: sponsor })], []);
  await send([await captureInstruction(first, 40n, true, 100n, 0n)], [merchant]);
  await check(first, 0n, 40n, 960n, 40n);
  await send([await refundInstruction(first, 10n, 0n, 40n)], [merchant]);
  await check(first, 0n, 30n, 970n, 30n);
  const stale = await send([await captureInstruction(first, 1n, false, 100n, 0n)], [merchant], true);
  assert.deepEqual(stale.err, { InstructionError: [0, "InvalidArgument"] });
  await check(first, 0n, 30n, 970n, 30n);

  const second = await stored(2, (await clock()) + 120n);
  await send([await captureInstruction(second, 25n, false, 100n, 0n)], [merchant]);
  await send([await voidInstruction(second, 75n, 25n)], [merchant]);
  await check(second, 0n, 25n, 945n, 55n);
  const dc = (await clock()) + 5n;
  const third = await stored(3, dc);
  const waitDeadline = Date.now() + 20_000;
  while ((await clock()) < dc) { assert(Date.now() < waitDeadline); await delay(200); }
  await send([await reclaimInstruction(third)], [payer]);
  await check(third, 0n, 0n, 945n, 55n);

  // The explicit creation funder receives rent while an
  // unrelated fee payer performs cleanup without payer/merchant/funder consent.
  await send([getTransferSolInstruction({ source: sponsor, destination: rentFunder.address, amount: 2_000_000_000n })], []);
  const balance = async (address: Address) => BigInt((await rpc("getBalance", [address, { commitment: "confirmed" }])).value);
  const missing = async (address: Address) => (await rpc("getAccountInfo", [address, { commitment: "confirmed" }])).value === null;
  const slotNow = async () => (await account("SysvarC1ock11111111111111111111111111111111")).data.readBigUInt64LE(0) as bigint;
  const waitSlot = async (expiry: bigint) => {
    const deadline = Date.now() + 20_000;
    while ((await slotNow()) <= expiry) { assert(Date.now() < deadline, "v2 expiry wait timed out"); await delay(100); }
  };
  const v2Stored = async (saltByte: number, dc = 0n, window = 18n) => {
    const observedSlot = await slotNow();
    const s: V2Stored = { protocolVersion: 2, programId: LOCAL_V2_PROGRAM_ID, payer: payer.address,
      server: merchant.address, mint: mint.address, rentRefundRecipient: rentFunder.address,
      salt: new Uint8Array(32).fill(saltByte), authorizeUntilSlot: observedSlot + window };
    const terms = { ...s, observedSlot, maximum: 100n, captureDeadline: dc || (await clock()) + 120n,
      refundDeadline: (dc || (await clock()) + 120n) + 120n };
    const auth = await authorizeV2Instruction(terms);
    await send([auth], [payer, rentFunder]);
    return { s, auth, payment: await paymentV2Address(s), vault: await ata(await paymentV2Address(s), mint.address) };
  };

  const rentBefore = await balance(rentFunder.address);
  const firstV2 = await v2Stored(11);
  const stateV2 = decodePaymentV2((await account(firstV2.payment)).data)!;
  assert.equal(stateV2.rentRefundRecipient, rentFunder.address);
  const paymentDeposit = await balance(firstV2.payment), vaultDeposit = await balance(firstV2.vault);
  assert.equal(await balance(rentFunder.address), rentBefore - paymentDeposit - vaultDeposit);
  await send([await closePaymentV2Instruction(firstV2.s)], [], true); // H > 0.
  await send([getFreezeAccountInstruction({ account: payerAta, mint: mint.address, owner: sponsor })], []);
  await send([await captureV2Instruction(firstV2.s, 40n, true, 100n, 0n)], [merchant], true);
  assert.equal(decodePaymentV2((await account(firstV2.payment)).data)!.held, 100n);
  await send([getThawAccountInstruction({ account: payerAta, mint: mint.address, owner: sponsor })], []);
  await send([await captureV2Instruction(firstV2.s, 40n, true, 100n, 0n)], [merchant]);
  await send([getFreezeAccountInstruction({ account: firstV2.vault, mint: mint.address, owner: sponsor })], []);
  const wrongRecipient = { ...firstV2.s, rentRefundRecipient: sponsor.address };
  await send([await closeEmptyVaultV2Instruction(wrongRecipient)], [], true);
  await send([await closeEmptyVaultV2Instruction(firstV2.s)], []);
  assert(await missing(firstV2.vault));
  assert.equal(await balance(rentFunder.address), rentBefore - paymentDeposit);
  await send([await closePaymentV2Instruction(firstV2.s)], [], true); // F > 0 before Dr.
  await send([await refundV2Instruction(firstV2.s, 40n, 0n, 40n)], [merchant]);
  await waitSlot(firstV2.s.authorizeUntilSlot);
  const gift = getTransferSolInstruction({ source: sponsor, destination: firstV2.payment, amount: 1_000_000n });
  // All three instructions must roll back: closing/refunding SOL cannot revive an expired identity.
  const resurrection = await send([await closePaymentV2Instruction(firstV2.s), gift, firstV2.auth], [payer, rentFunder], true);
  assert.deepEqual(resurrection.err, { InstructionError: [2, "InvalidArgument"] });
  assert.equal((await account(firstV2.payment)).data.length, 216);
  assert.equal(await balance(rentFunder.address), rentBefore - paymentDeposit);
  await send([await closePaymentV2Instruction(firstV2.s), gift], []);
  const retired = await account(firstV2.payment);
  assert.equal(retired.owner, "11111111111111111111111111111111"); assert.equal(retired.data.length, 0);
  assert.equal(await balance(rentFunder.address), rentBefore);
  await send([firstV2.auth], [payer, rentFunder], true);
  const renewedTerms = { ...firstV2.s, authorizeUntilSlot: (await slotNow()) + 100n, observedSlot: await slotNow(), maximum: 100n,
    captureDeadline: (await clock()) + 120n, refundDeadline: (await clock()) + 240n };
  const renewed = await authorizeV2Instruction(renewedTerms);
  const substituted = { ...renewed, accounts: renewed.accounts!.map((a, index) => index === 2 ? { ...a, address: firstV2.payment } : a) };
  await send([substituted], [payer, rentFunder], true);
  // Donations after deletion have fixed payer custody, never the cleaner's.
  await send([getCreateAssociatedTokenIdempotentInstruction({ payer: sponsor, owner: firstV2.payment, mint: mint.address, ata: firstV2.vault }),
    getTransferCheckedInstruction({ source: payerAta, mint: mint.address, destination: firstV2.vault, authority: payer, amount: 3n, decimals: 6 })], [payer]);
  const payerSol = await balance(payer.address), retiredGift = await balance(firstV2.payment) + await balance(firstV2.vault);
  await send([await recoverRetiredV2Instruction(firstV2.s)], []);
  assert.equal(await balance(payer.address), payerSol + retiredGift);
  assert(await missing(firstV2.payment)); assert(await missing(firstV2.vault));
  assert.equal(await amount(payerAta), 945n);

  const dustV2 = await v2Stored(12, 0n, 24n);
  await send([await voidV2Instruction(dustV2.s, 100n, 0n)], [merchant]);
  await send([getTransferCheckedInstruction({ source: payerAta, mint: mint.address, destination: dustV2.vault, authority: payer, amount: 7n, decimals: 6 })], [payer]);
  await send([await closeEmptyVaultV2Instruction(dustV2.s)], [], true);
  await send([getFreezeAccountInstruction({ account: dustV2.vault, mint: mint.address, owner: sponsor })], []);
  await send([await sweepSurplusV2Instruction(dustV2.s), await closeEmptyVaultV2Instruction(dustV2.s)], [], true);
  assert.equal(await amount(dustV2.vault), 7n);
  await send([getThawAccountInstruction({ account: dustV2.vault, mint: mint.address, owner: sponsor })], []);
  await send([await sweepSurplusV2Instruction(dustV2.s), await closeEmptyVaultV2Instruction(dustV2.s)], []);
  await send([getCreateAssociatedTokenIdempotentInstruction({ payer: sponsor, owner: dustV2.payment, mint: mint.address, ata: dustV2.vault })], []);
  await waitSlot(dustV2.s.authorizeUntilSlot);
  await send([await closePaymentV2Instruction(dustV2.s)], [], true); // Recreated vault rechecked at execution.
  await send([await closeEmptyVaultV2Instruction(dustV2.s), await closePaymentV2Instruction(dustV2.s)], []);
  assert(await missing(dustV2.payment)); assert.equal(await amount(payerAta), 945n);

  const reclaimV2 = await v2Stored(13, (await clock()) + 5n, 18n);
  const reclaimAt = decodePaymentV2((await account(reclaimV2.payment)).data)!.captureDeadline;
  const reclaimWaitDeadline = Date.now() + 20_000;
  while ((await clock()) < reclaimAt) { assert(Date.now() < reclaimWaitDeadline); await delay(100); }
  await send([await reclaimV2Instruction(reclaimV2.s)], [payer]);
  await waitSlot(reclaimV2.s.authorizeUntilSlot);
  await send([await closeEmptyVaultV2Instruction(reclaimV2.s), await closePaymentV2Instruction(reclaimV2.s)], []);
  assert.equal(await amount(payerAta), 945n); assert.equal(await amount(merchantAta), 55n);
  const batchA = await v2Stored(14), batchB = await v2Stored(15);
  await send([await voidV2Instruction(batchA.s, 100n, 0n), await voidV2Instruction(batchB.s, 100n, 0n)], [merchant]);
  await waitSlot(batchB.s.authorizeUntilSlot);
  await send([await closeEmptyVaultV2Instruction(batchA.s), await closePaymentV2Instruction(batchA.s),
    await closeEmptyVaultV2Instruction(batchB.s), await closePaymentV2Instruction(batchB.s)], []);
  assert(await missing(batchA.payment)); assert(await missing(batchB.payment));
  // Shared business-order guard with the actual pinned RPC adapter. Programs
  // remain genesis-loaded; this never deploys or contacts an external endpoint.
  const orderRoot = join(directory, "orders");
  const enrollment = initializeV2OrderJournal(orderRoot, { namespace: "synthetic-agave-orders", network: "solana:agave-v2-local",
    genesisHash: await rpc("getGenesisHash"), programId: LOCAL_V2_PROGRAM_ID, merchant: merchant.address, providerId: "isolated-loopback" });
  const orderRpc = new V2OrderRpcTransport({ ...enrollment.binding, rpc: createSolanaRpc(url), observeTimeoutMs: 45_000 });
  let signs = 0, submissions = 0;
  const signOrder = async (wire: string) => {
    signs++;
    return encodeTransaction(await partiallySignTransaction([sponsor.keyPair, payer.keyPair, rentFunder.keyPair],
      getTransactionDecoder().decode(Buffer.from(wire, "base64"))));
  };
  for (const lostResponse of [false, true]) {
    const startSlot = await slotNow(), now = await clock(), lifetime = (await rpc("getLatestBlockhash", [{ commitment: "confirmed" }])).value;
    const intent: V2OrderIntent = { orderId: (lostResponse ? "b" : "a").repeat(64), payer: payer.address, mint: mint.address,
      salt: new Uint8Array(32).fill(lostResponse ? 22 : 21), authorizeUntilSlot: startSlot + 15n,
      maximum: 100n, captureDeadline: now + 120n, refundDeadline: now + 240n, observedSlot: startSlot,
      lifetime: { blockhash: lifetime.blockhash, lastValidBlockHeight: BigInt(lifetime.lastValidBlockHeight) } };
    const transport = { network: orderRpc.network, providerId: orderRpc.providerId,
      getGenesisHash: () => orderRpc.getGenesisHash(), finalizedReceipt: (signature: string) => orderRpc.finalizedReceipt(signature),
      sendOnce: async (wire: string) => {
        submissions++; const signature = await orderRpc.sendOnce(wire);
        if (lostResponse) throw Error("synthetic lost response after RPC acknowledgement");
        return signature;
      } };
    const service = () => new V2OrderAuthorizer({ journal: new V2OrderJournal(orderRoot, enrollment),
      feePayer: sponsor.address, rentRefundRecipient: rentFunder.address, transport, sign: signOrder });
    const result = await service().authorize(intent);
    assert.equal(result.snapshot.status, lostResponse ? "UNKNOWN" : "AUTHORIZED");
    assert(result.snapshot.signature);
    if (lostResponse) assert(await orderRpc.finalizedReceipt(result.snapshot.signature), "lost-response fixture must actually land");
    const stored: V2Stored = { ...intent, protocolVersion: 2, programId: LOCAL_V2_PROGRAM_ID,
      server: merchant.address, rentRefundRecipient: rentFunder.address };
    const payment = await paymentV2Address(stored), vault = await ata(payment, mint.address);
    const before = await balance(rentFunder.address), rent = await balance(payment) + await balance(vault);
    await send([await voidV2Instruction(stored, 100n, 0n)], [merchant]);
    await waitSlot(stored.authorizeUntilSlot);
    await send([await closeEmptyVaultV2Instruction(stored), await closePaymentV2Instruction(stored)], []);
    assert(await missing(payment)); assert(await missing(vault));
    assert.equal(await balance(rentFunder.address), before + rent);
    const priorSigns = signs, priorSends = submissions;
    const repeats = await Promise.all(Array.from({ length: 8 }, (_, i) => service().authorize({ ...intent,
      salt: new Uint8Array(32).fill(30 + i), authorizeUntilSlot: intent.authorizeUntilSlot + 1n + BigInt(i) })));
    assert(repeats.every(value => value.kind === "existing" && value.conflict && value.snapshot.status === result.snapshot.status));
    assert.equal(signs, priorSigns); assert.equal(submissions, priorSends);
    assert.equal(await amount(payerAta), 945n); assert.equal(await amount(merchantAta), 55n);
  }
  // Real service restarts and concurrent independent processes against this Agave validator.
  // Only generated disposable keys are written, with owner-only permissions, then removed.
  const worker = fileURLToPath(new URL("./fixtures/agave-relay-worker.ts", import.meta.url));
  const runWorker = (input:string,index:number) => new Promise<any>((resolve,reject)=>{
    const child=spawn(process.execPath,["--experimental-strip-types",worker,input,String(index)],{stdio:["ignore","pipe","pipe"]});
    let out="",err="";child.stdout.on("data",chunk=>out+=chunk);child.stderr.on("data",chunk=>err+=chunk);
    const timer=setTimeout(()=>{child.kill("SIGKILL");reject(Error("local relay worker timeout"));},60_000);
    child.once("error",reject);child.once("close",code=>{clearTimeout(timer);if(code!==0)reject(Error(`local relay worker failed: ${err}`));else {try{resolve(JSON.parse(out));}catch{reject(Error("invalid worker response"));}}});
  });
  let relayProcessChecks=0;
  for(const lost of [false,true]) {
    const startSlot=await slotNow(),now=await clock(),life=(await rpc("getLatestBlockhash",[{commitment:"confirmed"}])).value;
    const orderId=(lost?"d":"c").repeat(64),requests=[],identities:V2Stored[]=[];
    for(let i=0;i<4;i++) {
      const identity:V2Stored={protocolVersion:2,programId:LOCAL_PROGRAM_ID,payer:payer.address,server:merchant.address,
        mint:mint.address,rentRefundRecipient:sponsor.address,salt:new Uint8Array(32).fill((lost?60:50)+i),authorizeUntilSlot:startSlot+60n+BigInt(i)};
      identities.push(identity);
      const tx=await buildTransaction({feePayer:sponsor.address,instructions:[await authorizeV2Instruction({...identity,
        observedSlot:startSlot,maximum:100n,captureDeadline:now+120n,refundDeadline:now+240n})],signers:[payer],lifetime:life});
      const req=sealOrderTerms({scheme:"auth-capture",network:enrollment.binding.network,asset:mint.address,payTo:merchant.address,amount:"100",maxTimeoutSeconds:60,
        extra:{protocolVersion:2,programId:LOCAL_PROGRAM_ID,feePayer:sponsor.address,paymentFlow:"escrow",captureDeadline:Number(now+120n),refundDeadline:Number(now+240n),
          authorizeUntilSlot:identity.authorizeUntilSlot.toString(),orderId}},"synthetic-agave-order-key");
      requests.push({x402Version:2,paymentPayload:{x402Version:2,accepted:req,payload:{transaction:encodeTransaction(tx)}},paymentRequirements:req});
    }
    const input=join(directory,`relay-${lost}.json`),dispatches=join(directory,`relay-${lost}-dispatches`);
    writeFileSync(dispatches,"",{mode:0o600});
    writeFileSync(input,JSON.stringify({url,sponsor:sponsor.address,privateKey:Buffer.from(await crypto.subtle.exportKey("pkcs8",sponsor.keyPair.privateKey)).toString("base64"),
      enrollment,orders:orderRoot,submissions:join(directory,`relay-submissions-${lost}`),orderKey:"synthetic-agave-order-key",requests,lost,dispatches}),{mode:0o600});
    const results=await Promise.all(requests.map((_,i)=>runWorker(input,i)));
    assert.equal(results.filter(r=>r.success).length,lost?0:1);
    assert.equal(readFileSync(dispatches,"utf8"),"dispatch\n");
    const winner=results.findIndex(r=>r.signature);assert(winner>=0);
    const identity=identities[winner]!;
    assert(await orderRpc.finalizedReceipt(results[winner].signature));
    const originalSnapshot=new V2OrderJournal(orderRoot,enrollment).snapshot(orderId);
    assert.equal(originalSnapshot.status,lost?"UNKNOWN":"AUTHORIZED");
    await send([await voidV2Instruction(identity,100n,0n)],[merchant]);await waitSlot(identity.authorizeUntilSlot);
    await send([await closeEmptyVaultV2Instruction(identity),await closePaymentV2Instruction(identity)],[]);
    assert(await missing(await paymentV2Address(identity)));
    const restarted=await Promise.all(requests.map((_,i)=>runWorker(input,i)));
    assert(restarted.every(r=>!r.success));assert.equal(readFileSync(dispatches,"utf8"),"dispatch\n");
    assert.deepEqual(new V2OrderJournal(orderRoot,enrollment).snapshot(orderId),originalSnapshot);
    assert.equal(await amount(payerAta),945n);relayProcessChecks+=requests.length*2;
  }
  // Read the validator's actual storage deposits; simulator/default Rent values
  // can differ with the feature profile. These are refundable deposits, not fees.
  const minimumBalanceByDataLength = Object.fromEntries(await Promise.all(
    [0, 8, 40, 48, 165, 176, 216].map(async length => [length,
      await rpc("getMinimumBalanceForRentExemption", [length, { commitment: "confirmed" }])]),
  ));
  console.log(JSON.stringify({ agave: version["solana-core"], featureSet: version["feature-set"], binarySha256, cleanupMetrics, relayProcessChecks,
    minimumBalanceByDataLength,
    checks: ["sole-v2-genesis-executable", "v2-authorize-capture-release-refund-void-reclaim", "v2-second-CPI-rollback-stale-consent",
      "v2-explicit-funder-rent-return", "v2-positive-hold-guard", "v2-second-CPI-rollback", "v2-empty-frozen-close", "v2-wrong-recipient",
      "v2-refund-after-vault-close", "v2-live-refund-guard", "v2-same-transaction-revival-rejected", "v2-real-deallocation",
      "v2-expired-replay-and-expiry-substitution-rejected", "v2-retired-gifts", "v2-dust-and-frozen-rollback", "v2-recreated-vault-guard", "v2-payer-reclaim", "v2-two-payment-cleanup-batch",
      "v2-shared-order-journal-new-salt-expiry-after-close", "v2-lost-response-UNKNOWN-after-close-and-restart", "v2-parallel-order-requests-no-resubmission", "v2-facilitator-process-race-and-restart-after-close"] }));
} catch (error) {
  console.error(readFileSync(log, "utf8").split("\n").slice(-30).join("\n"));
  throw error;
} finally {
  validator.kill("SIGTERM");
  await Promise.race([exited, delay(5_000)]);
  if (validator.exitCode === null && validator.signalCode === null) validator.kill("SIGKILL");
  await exited;
  rmSync(directory, { recursive: true, force: true });
}
