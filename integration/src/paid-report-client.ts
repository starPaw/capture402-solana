// Same-origin client for the disclosed local SVM auth-capture extension.
// Prepare before signing so callers can retain the private session/order on interrupted HTTP.
import { createHash } from "node:crypto";
import { type KeyPairSigner, type Blockhash, getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from "@solana/kit";
import { authorizePaymentPayload, selectOffer, type ClientPolicy } from "./client.ts";
import { decodeHeader, encodeHeader, PAYMENT_RESPONSE_HEADER, PAYMENT_SIGNATURE_HEADER, parsePaymentRequired } from "./http-transport.ts";
import { parseReportRequest, reportManifest, type ReportRequest } from "./paid-report.ts";
import { authorizeInstruction, buildTransaction } from "./transactions.ts";
import { isObject } from "./types.ts";

export type PreparedReport = {
  origin: string; cookie: string; order: string; request: ReportRequest; unsigned: string;
  required: ReturnType<typeof parsePaymentRequired>; salt: string; manifest: string;
};
export async function prepareReport(options: {
  origin: string; payer: string; request: ReportRequest; idempotencyKey: string; cookie?: string;
  fetchImpl?: typeof fetch; requestTimeoutMs?: number;
}): Promise<PreparedReport> {
  if (new URL(options.origin).origin !== options.origin) throw new Error("canonical report origin required");
  const request = parseReportRequest(options.request);
  const fetcher = options.fetchImpl ?? fetch;
  const signal = () => AbortSignal.timeout(options.requestTimeoutMs ?? 30_000);
  const session = await fetcher(`${options.origin}/api/report-session`, {
    headers: options.cookie ? { cookie: options.cookie } : {}, signal: signal(), redirect: "error",
  });
  if (!session.ok) throw new Error("report session unavailable");
  const cookie = options.cookie ?? session.headers.get("set-cookie")?.split(";")[0];
  if (!cookie || !/^capture402-report=[a-f0-9]{64}$/.test(cookie)) throw new Error("report session cookie unavailable");
  const response = await fetcher(`${options.origin}/api/orders`, { method: "POST", signal: signal(), redirect: "error",
    headers: { origin: options.origin, cookie, "content-type": "application/json", "idempotency-key": options.idempotencyKey },
    body: JSON.stringify({ payer: options.payer, request }) });
  if (response.status !== 402) throw new Error("original report draft unavailable; no new consent");
  const quote: unknown = await response.json();
  if (!isObject(quote) || typeof quote.order !== "string" || !/^[a-f0-9]{64}$/.test(quote.order) ||
      typeof quote.unsigned !== "string" || typeof quote.manifest !== "string" || typeof quote.salt !== "string") throw new Error("invalid report quote");
  const required = parsePaymentRequired(quote.required);
  if (required.accepts.length !== 1 || required.resource.url !== `${options.origin}/resource`) throw new Error("report resource differs");
  const manifest = reportManifest(quote.order, options.origin, request, options.payer, required.accepts[0]!);
  const salt = createHash("sha256").update(manifest).digest("hex");
  if (quote.manifest !== manifest || quote.salt !== salt) throw new Error("report manifest commitment differs");
  return { origin: options.origin, cookie, order: quote.order, request, unsigned: quote.unsigned, required, salt, manifest };
}

export async function submitReport(prepared: PreparedReport, options: {
  payer: KeyPairSigner; policy: ClientPolicy; now: () => Promise<bigint>; fetchImpl?: typeof fetch; requestTimeoutMs?: number;
}): Promise<Response> {
  const offer = selectOffer(prepared.required, options.policy, await options.now());
  // Recheck the full commitment at the signing boundary, including caller mutations.
  const manifest = reportManifest(prepared.order, prepared.origin, parseReportRequest(prepared.request), options.payer.address, offer.requirements);
  const salt = createHash("sha256").update(manifest).digest("hex");
  if (prepared.manifest !== manifest || prepared.salt !== salt || prepared.required.resource.url !== `${prepared.origin}/resource`) throw new Error("report signing commitment differs");
  const unsigned = getTransactionDecoder().decode(getBase64Encoder().encode(prepared.unsigned));
  const message = getCompiledTransactionMessageDecoder().decode(unsigned.messageBytes);
  if (offer.feePayer === options.payer.address) throw new Error("the sponsor cannot be the payer");
  const ix = await authorizeInstruction({ programId: options.policy.programId, payer: options.payer.address,
    server: options.policy.payTo, mint: options.policy.asset, funder: offer.feePayer, salt: Buffer.from(salt, "hex"),
    maximum: offer.maximum, captureDeadline: offer.captureDeadline, refundDeadline: offer.refundDeadline });
  const build = { feePayer: offer.feePayer, instructions: [ix],
    lifetime: { blockhash: message.lifetimeToken as Blockhash, lastValidBlockHeight: 0n } };
  const expected = await buildTransaction({ ...build, signers: [] });
  if (!Buffer.from(expected.messageBytes).equals(Buffer.from(unsigned.messageBytes))) throw new Error("unsigned report message differs from trusted policy");
  // No payer signature or wallet prompt until the entire offered message matches.
  const transaction = await buildTransaction({ ...build, signers: [options.payer] });
  return (options.fetchImpl ?? fetch)(`${prepared.origin}/resource?order=${prepared.order}`, { method: "POST", redirect: "error",
    headers: { origin: prepared.origin, cookie: prepared.cookie, "content-type": "application/json",
      [PAYMENT_SIGNATURE_HEADER]: encodeHeader(authorizePaymentPayload(prepared.required, offer.requirements, transaction)) },
    body: JSON.stringify(prepared.request), signal: AbortSignal.timeout(options.requestTimeoutMs ?? 900_000) });
}

/** Read-only identical purchased bytes. Never signs, submits, or resumes an interrupted run. */
export async function retrieveReport(prepared: Pick<PreparedReport, "origin" | "order" | "cookie">, fetcher: typeof fetch = fetch): Promise<Response> {
  return fetcher(`${prepared.origin}/api/orders/${prepared.order}/result`, { headers: { cookie: prepared.cookie }, signal: AbortSignal.timeout(30_000), redirect: "error" });
}

export async function readPaidReport(response: Response): Promise<{ body: unknown; receipt: unknown }> {
  const header = response.headers.get(PAYMENT_RESPONSE_HEADER);
  if (response.status !== 200 || !header) throw new Error("report delivery incomplete; preserve original order");
  const body: unknown = await response.json();
  if (!isObject(body) || body.ok !== true || !isObject(body.artifacts)) throw new Error("report artifacts unavailable");
  for (const stage of ["dataset", "summary"]) {
    const part = body.artifacts[stage];
    if (!isObject(part) || typeof part.utf8 !== "string" || part.sha256 !== createHash("sha256").update(part.utf8).digest("hex")) {
      throw new Error("report artifact hash differs");
    }
  }
  return { body, receipt: decodeHeader(header) };
}
