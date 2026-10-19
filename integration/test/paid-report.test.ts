// Real loopback HTTP + existing SBF in LiteSVM. RPC evidence below is a local test adapter,
// built from actual pre/post token accounts; it is not a Devnet finality observation.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve, type ServerType } from "@hono/node-server";
import { getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from "@solana/kit";
import { getTokenDecoder, getTransferInstruction } from "@solana-program/token";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type ClientPolicy } from "../src/client.ts";
import { createGatewayApp } from "../src/gateway.ts";
import { decodeHeader, encodeHeader, PAYMENT_REQUIRED_HEADER, PAYMENT_RESPONSE_HEADER, PAYMENT_SIGNATURE_HEADER } from "../src/http-transport.ts";
import { OperationStore } from "../src/operation-store.ts";
import { prepareReport, readPaidReport, retrieveReport, submitReport, type PreparedReport } from "../src/paid-report-client.ts";
import { createPaidReportApp, type PaidReportConfig } from "../src/paid-report.ts";
import { type FinalizedTransactionEvidence, type ReportProofReader, type TokenObservation } from "../src/paid-report-proof.ts";
import { ata, decodePayment, TOKEN_PROGRAM_ADDRESS } from "../src/program.ts";
import { SponsorshipGuard } from "../src/sponsorship.ts";
import { authorizeInstruction, buildTransaction, captureInstruction, encodeTransaction } from "../src/transactions.ts";
import { createHarness, type Harness, NOW } from "./fixture.ts";

const ORIGIN = "http://report.test";
type Started = { url: string; close: () => Promise<void> };
async function start(app: Hono): Promise<Started> {
  const server: ServerType = await new Promise(resolve => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise(resolve => server.close(() => resolve())) };
}
let h: Harness, gateway: Started, resource: Started, store: OperationStore, dir: string;
let config: PaidReportConfig, policy: ClientPolicy, sequence: number;
let fault: { at: number; kind: "lost" | "confirmed" | "metadata" | "token" | "identity" | "wire" } | undefined;
const originals = new Map<string, FinalizedTransactionEvidence>();
const commitments = new Map<string, "finalized" | "confirmed">();
const localFetch: typeof fetch = (input, init) => fetch(String(input).replace(ORIGIN, resource.url), init);

beforeEach(async () => {
  h = await createHarness(); sequence = 0; fault = undefined; originals.clear(); commitments.clear();
  const submit = h.ledger.submit.bind(h.ledger);
  vi.spyOn(h.ledger, "submit").mockImplementation(async transaction => {
    const accounts = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes).staticAccounts;
    function balances(): TokenObservation[] {
      return accounts.flatMap((address, accountIndex) => {
        const account = h.svm.getAccount(address);
        if (!account.exists || account.programAddress !== TOKEN_PROGRAM_ADDRESS || account.data.length !== getTokenDecoder().fixedSize) return [];
        const token = getTokenDecoder().decode(account.data);
        return [{ accountIndex, mint: token.mint, owner: token.owner, amount: token.amount.toString() }];
      });
    }
    const before = balances();
    if (fault?.at === h.ledger.submissions.length + 1 && fault.kind === "confirmed") h.ledger.commitment = "confirmed";
    const result = await submit(transaction);
    const original = h.ledger.submissions.at(-1)!;
    const slot = BigInt(100 + h.ledger.submissions.length);
    originals.set(original.signature, { kind: "ok", slot, transactionBase64: encodeTransaction(transaction), accounts, before, after: balances() });
    commitments.set(original.signature, h.ledger.commitment);
    return result;
  });
  const reader: ReportProofReader = {
    getSignatureStatus: async signature => {
      const evidence = originals.get(signature);
      const submission = h.ledger.submissions.find(item => item.signature === signature);
      return evidence?.kind === "ok" && submission ? { kind: "found", slot: evidence.slot,
        commitment: commitments.get(signature)!, err: submission.status === "succeeded" ? null : "failed" } : { kind: "not-found" };
    },
    getFinalizedTransaction: async signature => {
      const evidence = originals.get(signature)!;
      if (fault?.at === h.ledger.submissions.length && evidence.kind === "ok") {
        if (fault.kind === "metadata") return { kind: "unavailable" };
        if (fault.kind === "token") return { ...evidence, after: evidence.after.map(item => ({ ...item, amount: "999" })) };
        if (fault.kind === "identity") return { ...evidence, after: evidence.after.map(item => ({ ...item, owner: h.outsider.address })) };
        if (fault.kind === "wire") return { ...evidence, transactionBase64: "AAAA" };
      }
      return evidence;
    },
    getAccountAtLeast: async (address, slot) => ({ kind: "ok", slot, account: await h.ledger.getAccount(address) }),
  };
  gateway = await start(createGatewayApp(h.facilitator, { bearerToken: "report-test-bearer", allowlist: { merchant: h.server.address, mint: h.mint },
    sponsorship: new SponsorshipGuard({ ledger: h.ledger, feePayer: h.facilitatorKey.address, maxAttempts: 100, minLamportsBalance: 1n }) }));
  dir = mkdtempSync(join(tmpdir(), "capture402-paid-report-")); store = new OperationStore(dir);
  config = { origin: ORIGIN, proofReader: reader, facilitatorUrl: gateway.url, bearerToken: "report-test-bearer", network: h.ledger.network,
    programId: h.facilitator.programId, feePayer: h.facilitatorKey.address, server: h.server, asset: h.mint, amount: 100n,
    captureDeadlineSeconds: 120, refundDeadlineSeconds: 600, store, now: () => h.svm.getClock().unixTimestamp,
    getLatestBlockhash: async () => h.lifetime(), handler: async () => { throw new Error("unused generic handler"); },
    fetchImpl: async (input, init) => {
      sequence++;
      const response = await fetch(input, init);
      if (fault?.kind === "lost" && fault.at === sequence) throw new Error("lost original finalized response");
      return response;
    } };
  resource = await start(createPaidReportApp(config));
  policy = { network: h.ledger.network, programId: h.facilitator.programId, feePayer: h.facilitatorKey.address,
    payTo: h.server.address, asset: h.mint, maxAmount: 100n, maxCaptureWindowSeconds: 300 };
});
afterEach(async () => {
  await resource?.close(); await gateway?.close(); await h?.close(); vi.restoreAllMocks(); if (dir) rmSync(dir, { recursive: true, force: true });
});
const prepare = (key = "paid_report_key_1234", region: "all" | "eu" | "us" = "eu", cookie?: string) => prepareReport({
  origin: ORIGIN, payer: h.payer.address, request: { region }, idempotencyKey: key, cookie, fetchImpl: localFetch });
const submit = (quote: PreparedReport) => submitReport(quote, { payer: h.payer, policy, now: async () => h.svm.getClock().unixTimestamp, fetchImpl: localFetch });
async function restart() {
  await resource.close(); store = new OperationStore(dir);
  config = { ...config, store }; resource = await start(createPaidReportApp(config));
}

describe("two-stage paid resource over HTTP", () => {
  test("discovery is side-effect free and uses configured origin despite the request Host", async () => {
    const response = await localFetch(`${ORIGIN}/resource`);
    expect(response.status).toBe(402);
    expect(decodeHeader(response.headers.get(PAYMENT_REQUIRED_HEADER)!)).toMatchObject({ resource: { url: `${ORIGIN}/resource` } });
    expect(store.list()).toEqual([]); expect(h.ledger.submissions).toEqual([]);
  });
  test("delivers requested dataset and aggregate only after 100 → 40 → 25 → release35 with exact token effects", async () => {
    const quote = await prepare(); const payerBefore = h.tokens(await h.payerAta()); const merchantBefore = h.tokens(await h.serverAta());
    expect(store.read(quote.order)!.paidReport!.artifacts).toEqual({});
    const response = await submit(quote);
    expect(response.status).toBe(200);
    const text = await response.clone().text();
    const { body, receipt } = await readPaidReport(response);
    const result = body as { artifacts: { dataset: { utf8: string; sha256: string }; summary: { utf8: string } }; receipts: { stage: string; proof: { held: string; refundable: string } }[] };
    expect(receipt).toMatchObject({ success: true, extensions: { "auth-capture": { operation: "void" } } });
    expect(receipt).not.toHaveProperty("amount");
    expect(JSON.parse(result.artifacts.dataset.utf8).rows).toHaveLength(3);
    expect(JSON.parse(result.artifacts.dataset.utf8).rows.every((row: { region: string }) => row.region === "eu")).toBe(true);
    expect(JSON.parse(result.artifacts.summary.utf8)).toMatchObject({ source: "synthetic-demo-v1", requests: 300, failures: 6, rowCount: 3 });
    expect(result.artifacts.dataset.sha256).toBe(createHash("sha256").update(result.artifacts.dataset.utf8).digest("hex"));
    expect(result.receipts.map(row => [row.stage, row.proof.held, row.proof.refundable])).toEqual([
      ["authorize", "100", "0"], ["dataset", "60", "40"], ["summary", "35", "65"], ["release", "0", "65"]]);
    expect(h.tokens(await h.payerAta())).toBe(payerBefore - 65n); expect(h.tokens(await h.serverAta())).toBe(merchantBefore + 65n);
    expect(h.ledger.submissions).toHaveLength(4);
    const record = store.read(quote.order)!;
    expect(record.status).toBe("completed"); expect(record.paidReport!.completedResponse).toBe(text);
    expect(record.paidReport!.attempts.every(row => row.original.lastValidBlockHeight && row.original.signature && row.proof)).toBe(true);
    await restart();
    const retrieved = await retrieveReport(quote, localFetch);
    expect(retrieved.headers.get(PAYMENT_RESPONSE_HEADER)).toBe(response.headers.get(PAYMENT_RESPONSE_HEADER));
    expect(await retrieved.text()).toBe(text); expect(h.ledger.submissions).toHaveLength(4);
    expect((await submit(quote)).status).toBe(409); expect(h.ledger.submissions).toHaveLength(4);
  });
  test("same key/body/capability keeps exact quote; changed request and foreign capability cannot replace it", async () => {
    const quote = await prepare();
    expect(await prepare("paid_report_key_1234", "eu", quote.cookie)).toEqual(quote);
    await expect(prepare("paid_report_key_1234", "us", quote.cookie)).rejects.toThrow(/no new consent/);
    await expect(prepare()).rejects.toThrow(/no new consent/);
    expect(store.list()).toHaveLength(1); expect(h.ledger.submissions).toEqual([]);
  });
  test.each([undefined, "capture402-report=" + "f".repeat(64)])("quote and result require original capability (%s)", async cookie => {
    const quote = await prepare(); await submit(quote);
    for (const suffix of ["", "/result"]) {
      const response = await localFetch(`${ORIGIN}/api/orders/${quote.order}${suffix}`, { headers: cookie ? { cookie } : {} });
      expect(response.status).toBe(409); expect(await response.text()).not.toMatch(/artifacts|unsigned|payer|rows/);
    }
    expect(h.ledger.submissions).toHaveLength(4);
  });
  test("cross-origin draft/paid request is rejected before any reservation or relay", async () => {
    const quote = await prepare();
    const response = await localFetch(`${ORIGIN}/resource?order=${quote.order}`, { method: "POST",
      headers: { origin: "https://foreign.test", cookie: quote.cookie, "content-type": "application/json" }, body: JSON.stringify(quote.request) });
    expect(response.status).toBe(403); expect(h.ledger.submissions).toEqual([]); expect(store.read(quote.order)!.paidReport!.state).toBe("draft");
  });
  test("malformed payment header never reserves a run or creates protected work", async () => {
    const quote = await prepare();
    const response = await localFetch(`${ORIGIN}/resource?order=${quote.order}`, { method: "POST",
      headers: { origin: ORIGIN, cookie: quote.cookie, "content-type": "application/json", [PAYMENT_SIGNATURE_HEADER]: "invalid" }, body: JSON.stringify(quote.request) });
    expect(response.status).toBe(400); expect(store.reportRunReserved()).toBe(false);
    expect(store.read(quote.order)!.paidReport!.artifacts).toEqual({}); expect(h.ledger.submissions).toEqual([]);
  });
  test("stale original quote returns 402 without replacement, reservation or settlement", async () => {
    const quote = await prepare(); h.setTime(NOW + 61n);
    const response = await submit(quote);
    expect(response.status).toBe(402); expect(response.headers.get(PAYMENT_REQUIRED_HEADER)).toBeTruthy();
    expect(store.read(quote.order)!.paidReport!.unsigned).toBe(quote.unsigned); expect(store.reportRunReserved()).toBe(false);
    expect(h.ledger.submissions).toEqual([]);
  });
  test("insufficient payer funds decline with 402 before either report phase", async () => {
    h.ok(await h.direct([getTransferInstruction({ source: await h.payerAta(), destination: await h.serverAta(),
      authority: h.payer, amount: h.tokens(await h.payerAta()) })], [h.payer]));
    const quote = await prepare(); const response = await submit(quote);
    expect(response.status).toBe(402); expect(response.headers.get(PAYMENT_REQUIRED_HEADER)).toBeTruthy();
    expect(store.read(quote.order)!.status).toBe("authorize-rejected"); expect(store.read(quote.order)!.paidReport!.artifacts).toEqual({});
    expect(h.ledger.submissions).toHaveLength(0); expect((await retrieveReport(quote, localFetch)).status).toBe(409);
  });
  test.each(["request", "manifest", "salt", "network", "merchant", "unsigned"])("client refuses changed %s before paid dispatch", async field => {
    const quote = await prepare();
    if (field === "request") quote.request = { region: "us" };
    if (field === "manifest") quote.manifest += " ";
    if (field === "salt") quote.salt = "0".repeat(64);
    if (field === "network") quote.required.accepts[0]!.network = "solana:foreign";
    if (field === "merchant") quote.required.accepts[0]!.payTo = h.outsider.address;
    if (field === "unsigned") quote.unsigned = "AAAA";
    await expect(submit(quote)).rejects.toThrow(); expect(h.ledger.submissions).toEqual([]);
  });
  test("changed request at the server cannot spend the original authorization", async () => {
    const quote = await prepare();
    const corrupt: typeof fetch = (input, init) => localFetch(input, { ...init, body: JSON.stringify({ region: "us" }) });
    expect((await submitReport(quote, { payer: h.payer, policy, now: async () => NOW, fetchImpl: corrupt })).status).toBe(409);
    expect(h.ledger.submissions).toEqual([]);
  });
  test("two concurrent paid requests have only one retained execution claim", async () => {
    const quote = await prepare();
    const responses = await Promise.all([submit(quote), submit(quote)]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]); expect(h.ledger.submissions).toHaveLength(4);
  });
  test("a completed report releases only the instance busy lock for a separately consented next order", async () => {
    const first = await prepare(); expect((await submit(first)).status).toBe(200);
    const second = await prepare("paid_report_second_1234", "us", first.cookie);
    expect((await submit(second)).status).toBe(200); expect(h.ledger.submissions).toHaveLength(8);
    expect((await retrieveReport(first, localFetch)).status).toBe(200);
  });
  test("an original UNKNOWN blocks both a pre-existing other draft and new order preparation across restart", async () => {
    const first = await prepare(); const second = await prepare("paid_report_second_1234", "us", first.cookie);
    fault = { at: 2, kind: "lost" }; expect((await submit(first)).status).toBe(500);
    await restart(); expect((await submit(second)).status).toBe(409);
    await expect(prepare("paid_report_new_key_1234", "us", first.cookie)).rejects.toThrow(/no new consent/);
    expect(h.ledger.submissions).toHaveLength(2);
  });
  test("a foreign legacy record cannot be reused as a paid-report namespace", async () => {
    store.reserve("a".repeat(64), h.payer.address, "/resource");
    await expect(prepare()).rejects.toThrow(/no new consent/); expect(h.ledger.submissions).toHaveLength(0);
  });
});

describe("original failure evidence fences protected bytes", () => {
  const faults = ["lost", "confirmed", "metadata", "token", "identity", "wire"] as const;
  test.each([1, 2, 3, 4].flatMap(at => faults.map(kind => [at, kind] as const)))("stage %s / %s stops delivery and survives restart", async (at, kind) => {
    fault = { at, kind }; const quote = await prepare();
    const response = await submit(quote);
    expect(response.status).toBe(500); expect(await response.clone().text()).not.toMatch(/artifacts|rows|latencyMs/);
    expect(h.ledger.submissions).toHaveLength(at); expect(store.read(quote.order)!.paidReport!.state).toBe("blocked");
    const original = store.read(quote.order)!.paidReport!.attempts.at(-1)!;
    expect(original.original.transactionBase64.length).toBeGreaterThan(0);
    if (kind === "lost") {
      expect(response.headers.get(PAYMENT_RESPONSE_HEADER)).toBeNull(); expect(original.original.signature).toBe("");
    }
    if (kind === "confirmed") {
      expect(decodeHeader(response.headers.get(PAYMENT_RESPONSE_HEADER)!)).toMatchObject({ success: false, errorReason: "settlement_pending", transaction: h.ledger.submissions.at(-1)!.signature });
    }
    const before = store.read(quote.order);
    await restart();
    expect((await submit(quote)).status).toBe(409); expect((await retrieveReport(quote, localFetch)).status).toBe(409);
    expect(h.ledger.submissions).toHaveLength(at); expect(store.read(quote.order)).toEqual(before);
  });
  test("newer conflicting H/F cannot unlock delivery after a genuine finalized capture", async () => {
    const originalRead = config.proofReader.getAccountAtLeast;
    config.proofReader.getAccountAtLeast = async (address, slot) => {
      const snapshot = await originalRead(address, slot);
      if (h.ledger.submissions.length === 2 && snapshot.kind === "ok" && snapshot.account) {
        const copy = new Uint8Array(snapshot.account.data); new DataView(copy.buffer).setBigUint64(160, 0n, true);
        return { ...snapshot, slot: slot + 1n, account: { ...snapshot.account, data: copy } };
      }
      return snapshot;
    };
    const quote = await prepare(); expect((await submit(quote)).status).toBe(500); expect(h.ledger.submissions).toHaveLength(2);
    expect((await retrieveReport(quote, localFetch)).status).toBe(409);
  });
  test("real deadline equality stops new merchant signing after authorize", async () => {
    const originalRead = config.proofReader.getAccountAtLeast;
    config.proofReader.getAccountAtLeast = async (address, slot) => { const result = await originalRead(address, slot); h.setTime(NOW + 120n); return result; };
    const quote = await prepare(); expect((await submit(quote)).status).toBe(500); expect(h.ledger.submissions).toHaveLength(1);
    const account = await h.ledger.getAccount(store.read(quote.order)!.paidReport!.terms.payment);
    expect(decodePayment(account!.data)).toMatchObject({ held: 100n, refundable: 0n });
  });
  test.each(["handler-started", "terminal-settling", "completed"])("interrupted %s persistence never returns bytes or resumes economics", async status => {
    const update = store.update.bind(store); let failed = false;
    vi.spyOn(store, "update").mockImplementation((id, patch) => {
      if (!failed && patch.status === status) { failed = true; throw new Error("simulated durable write interruption"); }
      return update(id, patch);
    });
    const quote = await prepare(); expect((await submit(quote)).status).toBe(500); expect(failed).toBe(true);
    const count = h.ledger.submissions.length; await restart();
    expect((await retrieveReport(quote, localFetch)).status).toBe(409); expect((await submit(quote)).status).toBe(409);
    expect(h.ledger.submissions).toHaveLength(count);
  });
});

describe("PR #101 adversarial security gate", () => {
  test("x402 escrow headers and scheme-specific settle steps preserve execution ordering", async () => {
    const quote = await prepare();
    const relay = config.fetchImpl!;
    const steps: unknown[] = [];
    config.fetchImpl = async (input, init) => {
      const body = JSON.parse(String(init?.body));
      const order = store.read(quote.order)!.paidReport!;
      expect(order.completedResponse).toBeUndefined();
      steps.push([body.paymentPayload.payload.type ?? "authorize", body.paymentPayload.payload.amount,
        body.paymentPayload.payload.expectedHeld, body.paymentPayload.payload.expectedRefundable,
        Object.keys(order.artifacts)]);
      expect(body.paymentRequirements.extra.paymentFlow).toBe("escrow");
      expect(body.paymentPayload.accepted).toEqual(quote.required.accepts[0]);
      return relay(input, init);
    };
    const dispatch: typeof fetch = (input, init) => {
      const payload = decodeHeader(new Headers(init?.headers).get(PAYMENT_SIGNATURE_HEADER)!);
      expect(payload).toMatchObject({ x402Version: 2, accepted: { scheme: "auth-capture", extra: { paymentFlow: "escrow" } } });
      return localFetch(input, init);
    };
    const response = await submitReport(quote, { payer: h.payer, policy, now: async () => NOW, fetchImpl: dispatch });
    expect(response.status).toBe(200);
    expect(steps).toEqual([
      ["authorize", undefined, undefined, undefined, []],
      ["capture", "40", "100", "0", ["dataset"]],
      ["capture", "25", "60", "40", ["dataset", "summary"]],
      ["void", undefined, "35", "65", ["dataset", "summary"]],
    ]);
    expect(decodeHeader(response.headers.get(PAYMENT_RESPONSE_HEADER)!)).toEqual(store.read(quote.order)!.paidReport!.attempts[3]!.receipt);
  });
  async function alteredUnsigned(quote: PreparedReport, change: "sponsor" | "metas" | "amount") {
    const order = store.read(quote.order)!.paidReport!;
    const ix = await authorizeInstruction({ programId: config.programId, payer: h.payer.address,
      server: h.server.address, mint: h.mint, funder: config.feePayer,
      salt: Buffer.from(order.terms.salt, "hex"), maximum: change === "amount" ? 101n : 100n,
      captureDeadline: BigInt(order.terms.captureDeadline), refundDeadline: BigInt(order.terms.refundDeadline) });
    const instructions = change === "metas" ? [{ ...ix, accounts: ix.accounts!.map((meta, i) =>
      i === 0 ? { ...meta, role: (meta.role ^ 1) as typeof meta.role } : meta) }] : [ix];
    return encodeTransaction(await buildTransaction({ feePayer: change === "sponsor" ? h.outsider.address : config.feePayer,
      instructions, signers: [], lifetime: h.lifetime() }));
  }
  test.each(["sponsor", "metas", "amount"] as const)("validly encoded unsigned %s substitution is rejected before payer signing", async change => {
    const quote = await prepare(); quote.unsigned = await alteredUnsigned(quote, change);
    const sign = vi.spyOn(crypto.subtle, "sign");
    await expect(submit(quote)).rejects.toThrow(/unsigned report message differs/);
    expect(sign).not.toHaveBeenCalled(); expect(h.ledger.submissions).toHaveLength(0);
    expect(store.reportRunReserved()).toBe(false);
  });
  test("another order cannot consume the original signed payment even with the same payer and session", async () => {
    const first = await prepare(); const second = await prepare("paid_report_second_1234", "eu", first.cookie);
    const redirect: typeof fetch = (input, init) => localFetch(String(input).replace(first.order, second.order), init);
    const response = await submitReport(first, { payer: h.payer, policy, now: async () => NOW, fetchImpl: redirect });
    expect(response.status).toBe(400); expect(h.ledger.submissions).toHaveLength(0);
    expect(store.reportRunReserved()).toBe(false);
  });
  test("two distinct orders competing for one instance cannot interleave captures", async () => {
    const first = await prepare(); const second = await prepare("paid_report_second_1234", "us", first.cookie);
    const responses = await Promise.all([submit(first), submit(second)]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    expect(h.ledger.submissions).toHaveLength(4);
    expect(store.list().filter(record => record.paidReport?.state === "completed")).toHaveLength(1);
  });
  test("an isolated UNKNOWN blocks new economics while completed purchases remain readable", async () => {
    const completed = await prepare(); const delivered = await submit(completed);
    const bytes = await delivered.text();
    const interrupted = await prepare("paid_report_next_key_1234", "us", completed.cookie);
    fault = { at: 1, kind: "metadata" };
    const read = config.proofReader.getFinalizedTransaction;
    config.proofReader.getFinalizedTransaction = async () => ({ kind: "unavailable" });
    expect((await submit(interrupted)).status).toBe(500);
    config.proofReader.getFinalizedTransaction = read;
    await restart();
    const result = await retrieveReport(completed, localFetch);
    expect(result.status).toBe(200); expect(await result.text()).toBe(bytes);
    await expect(prepare("paid_report_blocked_key_1234", "eu", completed.cookie)).rejects.toThrow(/no new consent/);
    expect(h.ledger.submissions).toHaveLength(5);
  });
  test.each(["not-found", "rpc-error", "failed"])("original signature %s cannot start protected work", async fault => {
    config.proofReader.getSignatureStatus = async () => {
      if (fault === "rpc-error") throw new Error("RPC unavailable");
      if (fault === "not-found") return { kind: "not-found" };
      return { kind: "found", slot: 101n, commitment: "finalized", err: "failed" };
    };
    const quote = await prepare(); expect((await submit(quote)).status).toBe(500);
    expect(store.read(quote.order)!.paidReport!.artifacts).toEqual({});
    await restart(); expect((await submit(quote)).status).toBe(409);
    expect(h.ledger.submissions).toHaveLength(1);
  });
  test.each(["accounts", "slot", "signature", "other-wire", "duplicate", "mint", "missing-vault", "missing-payer", "bad-amount"])("RPC %s substitution cannot release paid artifacts", async fault => {
    const read = config.proofReader.getFinalizedTransaction;
    config.proofReader.getFinalizedTransaction = async signature => {
      const evidence = await read(signature);
      if (evidence.kind !== "ok" || h.ledger.submissions.length !== 2) return evidence;
      const vault = await ata(store.list()[0]!.paidReport!.terms.payment, config.asset);
      const vaultIndex = evidence.accounts.indexOf(vault);
      if (fault === "accounts") return { ...evidence, accounts: evidence.accounts.map((address, i) => i === vaultIndex ? h.outsider.address : address) };
      if (fault === "slot") return { ...evidence, slot: evidence.slot - 1n };
      if (fault === "other-wire") return { ...evidence, transactionBase64: encodeTransaction(h.ledger.submissions[0]!.transaction) };
      if (fault === "signature") {
        const tx = getTransactionDecoder().decode(getBase64Encoder().encode(evidence.transactionBase64));
        return { ...evidence, transactionBase64: encodeTransaction({ ...tx, signatures: { ...tx.signatures, [config.feePayer]: null } }) };
      }
      if (fault === "missing-vault") return { ...evidence, after: evidence.after.filter(row => row.accountIndex !== vaultIndex) };
      if (fault === "missing-payer") {
        const payerIndex = evidence.accounts.indexOf(await ata(h.payer.address, config.asset));
        return { ...evidence, before: evidence.before.filter(row => row.accountIndex !== payerIndex) };
      }
      return { ...evidence, after: fault === "duplicate" ? [...evidence.after, evidence.after.find(row => row.accountIndex === vaultIndex)!] :
        evidence.after.map(row => row.accountIndex !== vaultIndex ? row : { ...row,
          ...(fault === "mint" ? { mint: h.outsider.address } : { amount: "-1" }) }) };
    };
    const quote = await prepare(); const response = await submit(quote);
    expect(response.status).toBe(500); expect(await response.text()).not.toMatch(/artifacts|rows/);
    expect(h.ledger.submissions).toHaveLength(2); expect(store.reportRunReserved()).toBe(true);
    const before = store.read(quote.order); await restart();
    expect((await retrieveReport(quote, localFetch)).status).toBe(409);
    expect((await submit(quote)).status).toBe(409); expect(store.read(quote.order)).toEqual(before);
  });
  test.each(["stale", "owner", "terms", "not-found"])("payment snapshot %s cannot prove settlement", async fault => {
    const read = config.proofReader.getAccountAtLeast;
    config.proofReader.getAccountAtLeast = async (address, slot) => {
      const snapshot = await read(address, slot);
      if (snapshot.kind !== "ok" || !snapshot.account) return snapshot;
      if (fault === "stale") return { ...snapshot, slot: slot - 1n };
      if (fault === "not-found") return { ...snapshot, account: null };
      if (fault === "owner") return { ...snapshot, account: { ...snapshot.account, owner: h.outsider.address } };
      const data = new Uint8Array(snapshot.account.data); data[0] = data[0]! ^ 1;
      return { ...snapshot, account: { ...snapshot.account, data } };
    };
    const quote = await prepare(); expect((await submit(quote)).status).toBe(500);
    expect(h.ledger.submissions).toHaveLength(1); expect(store.read(quote.order)!.paidReport!.artifacts).toEqual({});
  });
  test("a real competing capture after capture40 fences H/F and prevents capture25 and delivery", async () => {
    const read = config.proofReader.getAccountAtLeast; let competed = false;
    config.proofReader.getAccountAtLeast = async (address, slot) => {
      if (h.ledger.submissions.length === 2 && !competed) {
        competed = true;
        h.ok(await h.direct([await captureInstruction({ programId: config.programId, payment: address,
          payer: h.payer.address, server: h.server.address, mint: h.mint }, 1n, false, 60n, 40n)], [h.server]));
      }
      return read(address, slot);
    };
    const quote = await prepare(); expect((await submit(quote)).status).toBe(500); expect(competed).toBe(true);
    expect(h.ledger.submissions).toHaveLength(2);
    const payment = await h.ledger.getAccount(store.read(quote.order)!.paidReport!.terms.payment);
    expect(decodePayment(payment!.data)).toMatchObject({ held: 59n, refundable: 41n });
    expect((await retrieveReport(quote, localFetch)).status).toBe(409);
  });
  test("no HTTP 200 or protected artifact while capture25 proof is still unresolved", async () => {
    const read = config.proofReader.getFinalizedTransaction;
    let entered!: () => void, resume!: () => void;
    const enteredProof = new Promise<void>(resolve => { entered = resolve; });
    const resumeProof = new Promise<void>(resolve => { resume = resolve; });
    config.proofReader.getFinalizedTransaction = async signature => {
      if (h.ledger.submissions.length === 3) { entered(); await resumeProof; }
      return read(signature);
    };
    const quote = await prepare(); let returned = false;
    const pending = submit(quote).then(response => { returned = true; return response; });
    try {
      await enteredProof; expect(returned).toBe(false);
      const retrieval = await retrieveReport(quote, localFetch);
      expect(retrieval.status).toBe(409); expect(await retrieval.text()).not.toMatch(/artifacts|rows/);
      expect(h.ledger.submissions).toHaveLength(3);
    } finally { resume(); }
    expect((await pending).status).toBe(200); expect(h.ledger.submissions).toHaveLength(4);
  });
  test("capture25 finalized then response lost retains original wires and custody after restart", async () => {
    fault = { at: 3, kind: "lost" }; const quote = await prepare();
    expect((await submit(quote)).status).toBe(500);
    const before = store.read(quote.order)!;
    expect(before.paidReport!.attempts.map(attempt => attempt.stage)).toEqual(["authorize", "dataset", "summary"]);
    expect(before.paidReport!.attempts[2]!.original.signature).toBe("");
    expect(before.paidReport!.attempts[2]!.original.transactionBase64).toBeTruthy();
    const account = await h.ledger.getAccount(before.paidReport!.terms.payment);
    expect(decodePayment(account!.data)).toMatchObject({ held: 35n, refundable: 65n });
    await restart(); expect(store.reportRunReserved()).toBe(true);
    expect((await submit(quote)).status).toBe(409); expect((await retrieveReport(quote, localFetch)).status).toBe(409);
    expect(h.ledger.submissions).toHaveLength(3); expect(store.read(quote.order)).toEqual(before);
  });
  test("hard process exit after capture25 retains all original signatures and blocks restart economics", async () => {
    const worker = fileURLToPath(new URL("./fixtures/paid-report-crash-worker.ts", import.meta.url));
    const exit = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, ["--experimental-transform-types", worker, dir], { stdio: "ignore", timeout: 15_000 });
      child.on("error", reject); child.on("exit", resolve);
    });
    expect(exit).toBe(73);
    const quote: PreparedReport = JSON.parse(readFileSync(join(dir, "crash-prepared"), "utf8"));
    const before = store.read(quote.order)!;
    expect(before.paidReport!.state).toBe("running");
    expect(before.paidReport!.attempts.map(row => row.stage)).toEqual(["authorize", "dataset", "summary"]);
    expect(before.paidReport!.attempts.every(row => row.original.signature && row.original.transactionBase64 && row.receipt)).toBe(true);
    expect(before.paidReport!.attempts[2]!.proof).toBeUndefined();
    expect(before.paidReport!.completedResponse).toBeUndefined();
    await restart(); expect(store.reportRunReserved()).toBe(true);
    const response = await localFetch(`${ORIGIN}/resource?order=${quote.order}`, { method: "POST",
      headers: { origin: ORIGIN, cookie: quote.cookie, "content-type": "application/json" }, body: JSON.stringify(quote.request) });
    expect(response.status).toBe(409); expect((await retrieveReport({ ...quote, origin: ORIGIN }, localFetch)).status).toBe(409);
    await expect(prepare("after_hard_crash_key_1234")).rejects.toThrow(/no new consent/);
    expect(h.ledger.submissions).toHaveLength(0); expect(store.read(quote.order)).toEqual(before);
  });
});
