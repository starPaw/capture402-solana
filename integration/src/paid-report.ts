// Two fixed paid stages over existing authorize/capture/void instructions (#70/#75).
// One private OperationStore record owns the manifest, original attempts and immutable result.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { type Address, getBase64Encoder, getTransactionDecoder, isAddress } from "@solana/kit";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie } from "hono/cookie";
import { withShared } from "./coordination.ts";
import { decodeHeader, encodeHeader, parsePaymentPayload, PAYMENT_REQUIRED_HEADER, PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER, type PaymentRequired } from "./http-transport.ts";
import { transactionObservation, type LifetimeObservation } from "./lifetime-provenance.ts";
import { ReservationConflict, type OperationRecord, type PreSubmission } from "./operation-store.ts";
import { proveReportSettlement, type ReportProof, type ReportProofReader, type ReportTerms } from "./paid-report-proof.ts";
import { paymentAddress } from "./program.ts";
import { acceptedDeadlines, freshRequirements, peekAuthorize, settle, type ResourceServerConfig } from "./resource-server.ts";
import { authorizeInstruction, buildTransaction, captureInstruction, capturePayload, encodeTransaction,
  voidInstruction, voidPayload } from "./transactions.ts";
import { isObject, SETTLEMENT_UNKNOWN, type PaymentRequirements, type SettleResponse } from "./types.ts";

type Region = "all" | "eu" | "us";
export type ReportRequest = { region: Region };
type Stage = "authorize" | "dataset" | "summary" | "release";
type Artifact = { mimeType: "application/json"; utf8: string; sha256: string };
type Attempt = { stage: Stage; original: PreSubmission; receipt?: SettleResponse; proof?: ReportProof };
export type PaidReportOrder = {
  schema: 1; id: string; capabilityHash: string; requestBody: string; manifest: string;
  terms: ReportTerms; required: PaymentRequired; unsigned: string;
  authorizeLifetime: LifetimeObservation;
  state: "draft" | "running" | "blocked" | "completed";
  artifacts: { dataset?: Artifact; summary?: Artifact }; attempts: Attempt[]; completedResponse?: string;
};
export type PaidReportConfig = ResourceServerConfig & { origin: string; proofReader: ReportProofReader };
const COOKIE = "capture402-report";
const decoder = getTransactionDecoder();
const decode = (wire: string) => decoder.decode(getBase64Encoder().encode(wire));
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** Fixed serialization: changing it changes the existing salt commitment, not the ABI. */
export function reportManifest(id: string, origin: string, request: ReportRequest, payer: string, requirements: PaymentRequirements): string {
  return JSON.stringify(["capture402-report-v1", id, "POST", `${origin}/resource`, JSON.stringify(request), payer,
    requirements.network, requirements.extra!.programId, requirements.payTo, requirements.asset, requirements.amount,
    requirements.extra!.captureDeadline, requirements.extra!.refundDeadline, requirements.extra!.feePayer, requirements.maxTimeoutSeconds]);
}
export function parseReportRequest(input: unknown): ReportRequest {
  if (!isObject(input) || Object.keys(input).join() !== "region" || !["all", "eu", "us"].includes(input.region as string)) {
    throw new Error("request must contain one region: all, eu or us");
  }
  return { region: input.region as Region };
}

// Deliberately synthetic, disclosed data; no customer or production observations are invented.
const SAMPLE = [
  { id: "eu-1", region: "eu", requests: 120, failures: 3, latencyMs: 210 },
  { id: "eu-2", region: "eu", requests: 80, failures: 1, latencyMs: 180 },
  { id: "eu-3", region: "eu", requests: 100, failures: 2, latencyMs: 240 },
  { id: "us-1", region: "us", requests: 140, failures: 4, latencyMs: 160 },
  { id: "us-2", region: "us", requests: 60, failures: 0, latencyMs: 190 },
  { id: "us-3", region: "us", requests: 100, failures: 1, latencyMs: 220 },
] as const;
const rows = (request: ReportRequest) => SAMPLE.filter(row => request.region === "all" || row.region === request.region);
function artifact(value: unknown): Artifact {
  const utf8 = JSON.stringify(value);
  return { mimeType: "application/json", utf8, sha256: hash(utf8) };
}
function dataset(request: ReportRequest): Artifact {
  return artifact({ schema: 1, source: "synthetic-demo-v1", request, rows: rows(request) });
}
function summary(request: ReportRequest): Artifact {
  const selected = rows(request);
  const requests = selected.reduce((n, row) => n + row.requests, 0);
  const failures = selected.reduce((n, row) => n + row.failures, 0);
  return artifact({ schema: 1, source: "synthetic-demo-v1", request, rowCount: selected.length, requests, failures,
    successRate: (requests - failures) / requests,
    meanLatencyMs: selected.reduce((n, row) => n + row.latencyMs, 0) / selected.length });
}

export function createPaidReportApp(config: PaidReportConfig): Hono {
  if (new URL(config.origin).origin !== config.origin || config.amount <= 0n || config.amount % 100n !== 0n) {
    throw new Error("report needs canonical origin and a 100-unit ceiling");
  }
  const unit = config.amount / 100n;
  const app = new Hono();
  app.use("*", bodyLimit({ maxSize: 8192 }));
  app.use("*", async (ctx, next) => withShared(config.store.coordination, async () => {
    config.store.assertAccess();
    ctx.header("Cache-Control", "no-store");
    ctx.header("X-Content-Type-Options", "nosniff");
    if (ctx.req.method === "POST" && ctx.req.header("origin") !== config.origin) return ctx.json({ error: "same-origin report action required" }, 403);
    await next();
  }));
  // Configuration/RPC errors can carry credential URLs. Keep them out of HTTP responses.
  app.onError((_error, ctx) => ctx.json({ error: "report unavailable; inspect the original private record" }, 409));
  const required = (offer: PaymentRequirements): PaymentRequired => ({ x402Version: 2,
    resource: { url: `${config.origin}/resource`, description: "Synthetic dataset (40) + aggregate report (25); ceiling 100, release 35", mimeType: "application/json" },
    accepts: [offer] });
  function capability(ctx: Context): string {
    const cookie = getCookie(ctx, COOKIE);
    if (!cookie || !/^[a-f0-9]{64}$/.test(cookie)) throw new Error("report session required");
    return cookie;
  }
  function owned(ctx: Context, id: string): { record: OperationRecord; order: PaidReportOrder } {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("invalid report ID");
    const record = config.store.read(id);
    const order = record?.paidReport;
    if (!record || !order || order.schema !== 1 || order.id !== id || record.resource !== "/resource" ||
        !timingSafeEqual(Buffer.from(hash(capability(ctx)), "hex"), Buffer.from(order.capabilityHash, "hex"))) {
      throw new Error("report capability differs");
    }
    return { record, order };
  }
  function quote(ctx: Context, order: PaidReportOrder) {
    ctx.header(PAYMENT_REQUIRED_HEADER, encodeHeader(order.required));
    return ctx.json({ order: order.id, manifest: order.manifest, salt: order.terms.salt, required: order.required, unsigned: order.unsigned }, 402);
  }
  function ready(): boolean {
    return !config.store.reportRunReserved() && config.store.list().every(record => record.paidReport &&
      ["draft", "completed"].includes(record.paidReport.state));
  }
  function deliver(ctx: Context, order: PaidReportOrder) {
    if (order.state !== "completed" || !order.completedResponse || !order.attempts.at(-1)?.proof) {
      return ctx.json({ order: order.id, state: order.state, error: "report not complete; no automatic resume" }, 409);
    }
    ctx.header(PAYMENT_RESPONSE_HEADER, encodeHeader(order.attempts.at(-1)!.receipt));
    ctx.header("Content-Type", "application/json; charset=utf-8");
    return ctx.body(order.completedResponse, 200);
  }
  app.get("/resource", async ctx => {
    const challenge = required(await freshRequirements(config));
    ctx.header(PAYMENT_REQUIRED_HEADER, encodeHeader(challenge));
    return ctx.json(challenge, 402); // No draft, signing, settlement or artifact work.
  });
  app.get("/api/report-session", ctx => {
    const existing = getCookie(ctx, COOKIE);
    if (!existing || !/^[a-f0-9]{64}$/.test(existing)) setCookie(ctx, COOKIE, randomBytes(32).toString("hex"),
      { httpOnly: true, secure: config.origin.startsWith("https:"), sameSite: "Strict", path: "/", maxAge: 86400 });
    return ctx.json({ source: "synthetic-demo-v1", regions: ["all", "eu", "us"], stages: { dataset: 40, summary: 25, release: 35, ceiling: 100 } });
  });
  app.post("/api/orders", async ctx => {
    const key = ctx.req.header("idempotency-key");
    if (!key || !/^[A-Za-z0-9_-]{16,128}$/.test(key)) return ctx.json({ error: "16–128 character Idempotency-Key required" }, 400);
    let payer: Address, request: ReportRequest;
    try {
      const input: unknown = await ctx.req.json();
      if (!isObject(input) || Object.keys(input).sort().join() !== "payer,request" || !isAddress(input.payer as string)) throw new Error("invalid draft");
      payer = input.payer as Address; request = parseReportRequest(input.request);
    } catch { return ctx.json({ error: "draft must contain payer and request.region (all, eu or us)" }, 400); }
    const cookie = capability(ctx);
    const id = hash(JSON.stringify([config.network, config.programId, payer, key]));
    const existing = config.store.read(id);
    if (existing) {
      const { order } = owned(ctx, id);
      if (order.requestBody !== JSON.stringify(request)) return ctx.json({ error: "Idempotency-Key already binds another request" }, 409);
      if (order.state !== "draft") return ctx.json({ order: id, state: order.state, error: "inspect the original report; no new consent" }, 409);
      return quote(ctx, order);
    }
    if (!ready()) return ctx.json({ error: "original report unfinished; new economics stopped" }, 409);
    const offer = await freshRequirements(config);
    const manifest = reportManifest(id, config.origin, request, payer, offer);
    const salt = Buffer.from(hash(manifest), "hex");
    const payment = await paymentAddress(config.programId, payer, salt);
    const terms: ReportTerms = { payer, payment, salt: salt.toString("hex"), maximum: config.amount.toString(),
      captureDeadline: String(offer.extra!.captureDeadline), refundDeadline: String(offer.extra!.refundDeadline) };
    const lifetime = await config.getLatestBlockhash();
    const instruction = await authorizeInstruction({ programId: config.programId, funder: config.feePayer, payer,
      server: config.server.address, mint: config.asset, salt, maximum: config.amount,
      captureDeadline: BigInt(terms.captureDeadline), refundDeadline: BigInt(terms.refundDeadline) });
    const tx = await buildTransaction({ feePayer: config.feePayer, instructions: [instruction], signers: [], lifetime });
    const order: PaidReportOrder = { schema: 1, id, capabilityHash: hash(cookie), requestBody: JSON.stringify(request), manifest,
      terms, required: required(offer), unsigned: encodeTransaction(tx), authorizeLifetime: transactionObservation(tx)!,
      state: "draft", artifacts: {}, attempts: [] };
    try { config.store.reserve(id, payer, "/resource"); }
    catch (e) { if (e instanceof ReservationConflict) return ctx.json({ error: "draft already reserved; retrieve the original quote" }, 409); throw e; }
    config.store.update(id, { paidReport: order });
    return quote(ctx, order);
  });
  app.get("/api/orders/:id", ctx => quote(ctx, owned(ctx, ctx.req.param("id")).order));
  app.get("/api/orders/:id/result", ctx => deliver(ctx, owned(ctx, ctx.req.param("id")).order));

  app.post("/resource", async ctx => {
    const { order } = owned(ctx, ctx.req.query("order") ?? "");
    let request: ReportRequest;
    try { request = parseReportRequest(await ctx.req.json()); }
    catch { return ctx.json({ error: "request.region must be all, eu or us" }, 400); }
    if (JSON.stringify(request) !== order.requestBody) return ctx.json({ error: "request differs from signed manifest" }, 409);
    if (order.state !== "draft") return ctx.json({ order: order.id, error: "report already submitted; retrieve its original result" }, 409);
    const header = ctx.req.header(PAYMENT_SIGNATURE_HEADER);
    if (!header) return quote(ctx, order);
    let payload: ReturnType<typeof parsePaymentPayload>, transaction: ReturnType<typeof decode>;
    try {
      payload = parsePaymentPayload(decodeHeader(header));
      if (Object.keys(payload.payload).join() !== "transaction" || typeof payload.payload.transaction !== "string") throw new Error("wire required");
      transaction = decode(payload.payload.transaction);
      const signed = await peekAuthorize(config, transaction);
      if (signed.payer !== order.terms.payer || !Buffer.from(transaction.messageBytes).equals(Buffer.from(decode(order.unsigned).messageBytes)) ||
          JSON.stringify(payload.resource) !== JSON.stringify(order.required.resource) ||
          JSON.stringify(payload.accepted) !== JSON.stringify(order.required.accepts[0])) throw new Error("original quote required");
    } catch { return ctx.json({ error: "payer must sign the exact manifest-bound offer" }, 400); }
    if (typeof await acceptedDeadlines(config, payload.accepted) === "string") {
      ctx.header(PAYMENT_REQUIRED_HEADER, encodeHeader({ ...order.required, error: "original quote expired; do not submit it" }));
      return ctx.json({ error: "original quote expired; do not submit it" }, 402);
    }
    if (!ready()) return ctx.json({ error: "original report unfinished; new economics stopped" }, 409);
    try { config.store.reserveReportRun(order.id); }
    catch { return ctx.json({ error: "original run reserved; no retry or resume" }, 409); }
    const save = (patch: Partial<OperationRecord> = {}) => config.store.update(order.id, { paidReport: order, ...patch });
    order.state = "running";
    save();
    const common = { programId: config.programId, payment: order.terms.payment, payer: order.terms.payer,
      server: config.server.address, mint: config.asset };
    let lastReceipt: SettleResponse | undefined;
    let declinedAuthorize = false;
    async function attempt(stage: Stage, tx: ReturnType<typeof decode>, paymentPayload: typeof payload,
      h: bigint, f: bigint, nextH: bigint, nextF: bigint, payerDelta: bigint, merchantDelta: bigint, vaultDelta: bigint) {
      const observation = stage === "authorize" ? order.authorizeLifetime : transactionObservation(tx);
      if (!observation) throw new Error("prepared lifetime unavailable");
      const original: PreSubmission = { transactionBase64: encodeTransaction(tx), signature: "",
        blockhash: observation.blockhash,
        lastValidBlockHeight: observation.lastValidBlockHeight, lifetimeObservation: { observation },
        payment: order.terms.payment, expectedHeld: h.toString(), expectedRefundable: f.toString() };
      const entry: Attempt = { stage, original };
      order.attempts.push(entry);
      save(stage === "authorize" ? { status: "authorizing", authorize: original } : {
        status: "terminal-settling", terminal: { ...original, op: stage === "release" ? "void" : "capture" } });
      const outcome = await settle(config, { x402Version: 2, paymentPayload: { ...paymentPayload, extensions: undefined },
        paymentRequirements: order.required.accepts[0]! }, tx, order.terms.payer, observation);
      entry.receipt = outcome.receipt;
      original.signature = outcome.receipt?.transaction ?? "";
      lastReceipt = outcome.receipt;
      save(stage === "authorize" ? { authorize: original, authorizeReceipt: entry.receipt } : {
        terminal: { ...original, op: stage === "release" ? "void" : "capture" }, terminalReceipt: entry.receipt });
      if (outcome.kind !== "succeeded") {
        declinedAuthorize = stage === "authorize" && outcome.kind === "rejected";
        order.state = "blocked";
        save({ status: stage === "authorize" ? (outcome.kind === "rejected" ? "authorize-rejected" : "authorize-pending") :
          (outcome.kind === "rejected" ? "terminal-rejected" : "terminal-pending") });
        return false;
      }
      entry.proof = await proveReportSettlement(config, config.proofReader, order.terms, tx, outcome.receipt.transaction,
        { held: nextH, refundable: nextF, payerDelta, merchantDelta, vaultDelta });
      save({ status: stage === "authorize" ? "authorized" : "handler-succeeded" });
      return true;
    }
    function failure() {
      if (lastReceipt) ctx.header(PAYMENT_RESPONSE_HEADER, encodeHeader(lastReceipt));
      if (declinedAuthorize) ctx.header(PAYMENT_REQUIRED_HEADER, encodeHeader({ ...order.required, error: "authorization declined; original order remains blocked" }));
      return ctx.json(lastReceipt ? { error: "report settlement incomplete", order: order.id } : SETTLEMENT_UNKNOWN, declinedAuthorize ? 402 : 500);
    }
    try {
      if (!await attempt("authorize", transaction, payload, 0n, 0n, config.amount, 0n, -config.amount, 0n, config.amount)) return failure();
      for (const [stage, amount, h, f, make] of [
        ["dataset", 40n * unit, 100n * unit, 0n, dataset],
        ["summary", 25n * unit, 60n * unit, 40n * unit, summary],
      ] as const) {
        save({ status: "handler-started" });
        order.artifacts[stage] = make(request); // Private bytes/hash before any merchant consent.
        save({ status: "handler-succeeded" });
        if (BigInt(await config.now()) >= BigInt(order.terms.captureDeadline)) throw new Error("capture window ended");
        const ix = await captureInstruction(common, amount, false, h, f);
        const tx = await buildTransaction({ feePayer: config.feePayer, instructions: [ix], signers: [config.server], lifetime: await config.getLatestBlockhash() });
        const nextPayload = { x402Version: 2 as const, resource: order.required.resource, accepted: order.required.accepts[0]!,
          payload: capturePayload(order.terms.payment, tx, amount, false, h, f) };
        if (!await attempt(stage, tx, nextPayload, h, f, h - amount, f + amount, 0n, amount, -amount)) return failure();
      }
      if (BigInt(await config.now()) >= BigInt(order.terms.captureDeadline)) throw new Error("application void window ended");
      const ix = await voidInstruction(common, 35n * unit, 65n * unit);
      const tx = await buildTransaction({ feePayer: config.feePayer, instructions: [ix], signers: [config.server], lifetime: await config.getLatestBlockhash() });
      const nextPayload = { x402Version: 2 as const, resource: order.required.resource, accepted: order.required.accepts[0]!,
        payload: voidPayload(order.terms.payment, tx, 35n * unit, 65n * unit) };
      if (!await attempt("release", tx, nextPayload, 35n * unit, 65n * unit, 0n, 65n * unit, 35n * unit, 0n, -35n * unit)) return failure();
      order.completedResponse = JSON.stringify({ ok: true, order: order.id, payment: order.terms.payment, manifestSha256: hash(order.manifest),
        artifacts: order.artifacts, receipts: order.attempts.map(entry => ({ stage: entry.stage, receipt: entry.receipt, proof: entry.proof })) });
      order.state = "completed";
      save({ status: "completed" }); // Durable immutable response before HTTP delivery.
      config.store.completeReportRun(order.id);
      return deliver(ctx, order);
    } catch {
      order.state = "blocked";
      // Keep originals/artifacts private; never infer failed execution or automatically resume.
      try { save({ note: "report interrupted or original delivery proof unavailable" }); } catch { /* Original durable stage stands. */ }
      return ctx.json({ error: "delivery_unverified", order: order.id, status: "UNKNOWN" }, 500);
    }
  });
  return app;
}
