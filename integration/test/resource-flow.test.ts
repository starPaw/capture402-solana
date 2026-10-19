// Integration test for the SAC-006 gap #2/#3 escrow flow: `createGatewayApp` (bearer auth +
// merchant/mint allowlist + sponsorship cap) in front of the LiteSVM-backed `Facilitator`, and
// `createResourceApp` driving the x402 v2 HTTP transport (`402 + PAYMENT-REQUIRED →
// PAYMENT-SIGNATURE PaymentPayload → settle(authorize) → handler → settle(capture|void) →
// PAYMENT-RESPONSE`) against it over real HTTP, paid by the real client code (`payForResource`).
// Exercises: the standard challenge/payload/response headers; a full capture flow; handler
// failure taking the void path; replay rejection; non-standard, foreign, stale, and forged
// payments rejected before any reservation; refused, pending, and lost facilitator answers never
// starting the handler or completing a payment while their signatures are journaled; and the
// gateway's authentication, allowlist, and sponsorship cap.
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve, type ServerType } from "@hono/node-server";
import { getSignatureFromTransaction, partiallySignTransaction, type Address, type Transaction } from "@solana/kit";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { authorizePaymentPayload, type ClientPolicy, payForResource, selectOffer, signAuthorize } from "../src/client.js";
import { createGatewayApp } from "../src/gateway.js";
import {
  decodeHeader,
  encodeHeader,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  type PaymentRequired,
  parsePaymentRequired,
} from "../src/http-transport.js";
import { OperationStore } from "../src/operation-store.js";
import { createResourceApp, type HandlerResult, type ResourceServerConfig } from "../src/resource-server.js";
import { SponsorshipGuard } from "../src/sponsorship.js";
import { authorizePayload } from "../src/transactions.js";
import type { SettleResponse } from "../src/types.js";
import { createHarness, type Harness, NOW } from "./fixture.js";

type Started = { url: string; close: () => Promise<void> };

async function startServer(app: Hono): Promise<Started> {
  const s: ServerType = await new Promise((resolve) => {
    const srv = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(srv));
  });
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  return { url, close: () => new Promise<void>((resolve) => s.close(() => resolve())) };
}

let h: Harness;
let gateway: Started;
let resource: Started;
let store: OperationStore;
let handlerCalls = 0;
let handlerImpl: (ctx: { payer: Address; payment: Address }) => Promise<HandlerResult>;
let policy: ClientPolicy;
const BEARER_TOKEN = "test-bearer-token";

function resourceConfig(over: Partial<ResourceServerConfig> = {}): ResourceServerConfig {
  return {
    facilitatorUrl: gateway.url,
    bearerToken: BEARER_TOKEN,
    network: h.ledger.network,
    programId: h.facilitator.programId,
    feePayer: h.facilitatorKey.address,
    server: h.server,
    asset: h.mint,
    amount: 100n,
    captureDeadlineSeconds: 120,
    refundDeadlineSeconds: 600,
    store,
    getLatestBlockhash: async () => h.lifetime(),
    now: () => h.svm.getClock().unixTimestamp,
    handler: async (ctx) => {
      handlerCalls += 1;
      return handlerImpl(ctx);
    },
    ...over,
  };
}

beforeAll(async () => {
  h = await createHarness();
  const sponsorship = new SponsorshipGuard({ ledger: h.ledger, feePayer: h.facilitatorKey.address, maxAttempts: 1000, minLamportsBalance: 1n });
  gateway = await startServer(createGatewayApp(h.facilitator, { bearerToken: BEARER_TOKEN, sponsorship, allowlist: { merchant: h.server.address, mint: h.mint } }));
  store = new OperationStore(mkdtempSync(join(tmpdir(), "sac006-resource-flow-")));
  resource = await startServer(createResourceApp(resourceConfig()));
  policy = {
    network: h.ledger.network,
    programId: h.facilitator.programId,
    payTo: h.server.address,
    asset: h.mint,
    maxAmount: 100n,
    maxCaptureWindowSeconds: 300,
    feePayer: h.facilitatorKey.address,
  };
});

afterEach(() => {
  handlerImpl = async () => ({ ok: true, amount: 100n, releaseRemainder: true });
  h.ledger.commitment = "finalized";
  h.ledger.beforeSubmit = undefined;
  h.setTime(NOW);
});

afterAll(async () => {
  await resource.close();
  await gateway.close();
  await h.close();
});

const pay = (url = resource.url, salt = h.newSalt()) =>
  payForResource({
    resourceUrl: `${url}/resource`,
    policy,
    payer: h.payer,
    now: async () => h.svm.getClock().unixTimestamp,
    latestBlockhash: async () => h.lifetime(),
    salt,
  });

/** Fetches the challenge and signs an authorize the way the client does, for tests that then tamper with it. */
async function signedChallenge(url = resource.url): Promise<{ paymentRequired: PaymentRequired; tx: Transaction; accepted: PaymentRequired["accepts"][number] }> {
  const challenge = await fetch(`${url}/resource`);
  const paymentRequired = parsePaymentRequired(decodeHeader(challenge.headers.get(PAYMENT_REQUIRED_HEADER)!));
  const offer = selectOffer(paymentRequired, policy, h.svm.getClock().unixTimestamp);
  const tx = await signAuthorize(h.payer, offer, policy, h.newSalt(), h.lifetime());
  return { paymentRequired, tx, accepted: offer.requirements };
}

const send = (payload: unknown, url = resource.url) => fetch(`${url}/resource`, { headers: { [PAYMENT_SIGNATURE_HEADER]: encodeHeader(payload) } });

/** Asserts a request was turned away before reservation, settlement, or the handler. */
async function expectUntouched(run: () => Promise<Response>, status: number) {
  const records = store.list().length;
  const submissions = h.ledger.submissions.length;
  const calls = handlerCalls;
  const res = await run();
  expect(res.status).toBe(status);
  expect(store.list().length).toBe(records);
  expect(h.ledger.submissions.length).toBe(submissions);
  expect(handlerCalls).toBe(calls);
  return res;
}

describe("x402 HTTP transport", () => {
  test("the 402 carries a PAYMENT-REQUIRED header with the escrow offer", async () => {
    const res = await fetch(`${resource.url}/resource`);
    expect(res.status).toBe(402);
    const required = parsePaymentRequired(decodeHeader(res.headers.get(PAYMENT_REQUIRED_HEADER)!));
    expect(required.x402Version).toBe(2);
    expect(required.resource.url).toBe(`${resource.url}/resource`);
    expect(required.error).toMatch(/PAYMENT-SIGNATURE header is required/);
    const offer = required.accepts[0]!;
    expect(offer).toMatchObject({ scheme: "auth-capture", network: h.ledger.network, amount: "100", asset: h.mint, payTo: h.server.address });
    expect(offer.extra).toEqual({
      paymentFlow: "escrow",
      captureDeadline: Number(NOW) + 120,
      refundDeadline: Number(NOW) + 720,
      programId: h.facilitator.programId,
      feePayer: h.facilitatorKey.address,
    });
  });

  test("a PaymentPayload envelope completes end to end and settles the full amount to the server", async () => {
    const payerBefore = h.tokens(await h.payerAta());
    const serverBefore = h.tokens(await h.serverAta());
    const calledBefore = handlerCalls;

    const res = await pay();
    expect(res.status).toBe(200);
    expect(handlerCalls).toBe(calledBefore + 1);
    const receipt = res.paymentResponse as SettleResponse;
    expect(receipt.success).toBe(true);
    expect(receipt.extensions?.["auth-capture"]).toMatchObject({ operation: "capture", amount: "100" });
    expect(h.tokens(await h.serverAta())).toBe(serverBefore + 100n);
    expect(h.tokens(await h.payerAta())).toBe(payerBefore - 100n);

    const persisted = store.list().find((r) => r.authorize?.payment === (res.body as { payment: string }).payment)!;
    expect(persisted.status).toBe("completed");
    expect(persisted.authorize!.signature).toBe(persisted.authorizeReceipt!.transaction);
    expect(persisted.terminal!.signature).toBe(receipt.transaction);
    expect(persisted.terminal!.lastValidBlockHeight).toBeDefined();
  });

  test("the pre-envelope `{ transaction }` header is rejected as malformed before anything is reserved", async () => {
    const { tx } = await signedChallenge();
    const res = await expectUntouched(() => send(authorizePayload(tx)), 400);
    expect(((await res.json()) as { error: string }).error).toMatch(/invalid PAYMENT-SIGNATURE: PaymentPayload/);
  });

  test("a non-base64 header is rejected as malformed", async () => {
    await expectUntouched(() => fetch(`${resource.url}/resource`, { headers: { [PAYMENT_SIGNATURE_HEADER]: "not base64!" } }), 400);
  });
});

describe("payments the server never offered are refused before reservation", () => {
  test("an accepted offer naming another program gets a fresh 402 challenge", async () => {
    const { paymentRequired, tx, accepted } = await signedChallenge();
    const foreign = { ...accepted, extra: { ...accepted.extra, programId: h.outsider.address } };
    const res = await expectUntouched(() => send(authorizePaymentPayload(paymentRequired, foreign, tx)), 402);
    expect(res.headers.get(PAYMENT_REQUIRED_HEADER)).toBeTruthy();
  });

  test("a clock read a few seconds behind the challenge's still accepts the offer", async () => {
    const { paymentRequired, tx, accepted } = await signedChallenge();
    h.setTime(NOW - 5n); // a lagging RPC node behind a load balancer
    const res = await send(authorizePaymentPayload(paymentRequired, accepted, tx));
    expect(res.status).toBe(200);
  });

  test("an offer older than maxTimeoutSeconds is no longer accepted", async () => {
    const { paymentRequired, tx, accepted } = await signedChallenge();
    h.setTime(NOW + 61n);
    await expectUntouched(() => send(authorizePaymentPayload(paymentRequired, accepted, tx)), 402);
  });

  test("a client-chosen short capture deadline is refused", async () => {
    const { paymentRequired } = await signedChallenge();
    const short = selectOffer(paymentRequired, policy, NOW);
    short.captureDeadline = NOW + 2n;
    short.refundDeadline = NOW + 2n + 600n;
    short.requirements = { ...short.requirements, extra: { ...short.requirements.extra, captureDeadline: Number(NOW + 2n), refundDeadline: Number(NOW + 602n) } };
    const tx = await signAuthorize(h.payer, short, policy, h.newSalt(), h.lifetime());
    await expectUntouched(() => send(authorizePaymentPayload(paymentRequired, short.requirements, tx)), 402);
  });

  test("a payer signature that does not cover the message is rejected and claims no fingerprint", async () => {
    const { paymentRequired, tx, accepted } = await signedChallenge();
    const sig = new Uint8Array(tx.signatures[h.payer.address]!);
    sig[0] = sig[0]! ^ 0xff;
    const forged = { ...tx, signatures: { ...tx.signatures, [h.payer.address]: sig } } as unknown as Transaction;
    const res = await expectUntouched(() => send(authorizePaymentPayload(paymentRequired, accepted, forged)), 400);
    expect(((await res.json()) as { error: string }).error).toMatch(/payer signature/);
  });
});

describe("resource flow: handler outcomes and replay", () => {
  test("a handler failure voids the hold and returns the full amount to the payer", async () => {
    const payerBefore = h.tokens(await h.payerAta());
    const serverBefore = h.tokens(await h.serverAta());
    handlerImpl = async () => ({ ok: false, detail: "protected work failed" });
    const res = await pay();
    expect(res.status).toBe(500);
    expect((res.body as { detail: string }).detail).toBe("protected work failed");
    expect((res.paymentResponse as SettleResponse).extensions?.["auth-capture"]).toMatchObject({ operation: "void" });
    expect(h.tokens(await h.payerAta())).toBe(payerBefore);
    expect(h.tokens(await h.serverAta())).toBe(serverBefore);
  });

  test("a duplicate request with the same PaymentPayload is rejected and the handler runs at most once", async () => {
    const calledBefore = handlerCalls;
    const { paymentRequired, tx, accepted } = await signedChallenge();
    const payload = authorizePaymentPayload(paymentRequired, accepted, tx);
    expect((await send(payload)).status).toBe(200);
    const second = await send(payload);
    expect(second.status).toBe(409);
    expect(handlerCalls).toBe(calledBefore + 1);
  });

  test("concurrent identical requests run the handler at most once", async () => {
    const calledBefore = handlerCalls;
    const { paymentRequired, tx, accepted } = await signedChallenge();
    const payload = authorizePaymentPayload(paymentRequired, accepted, tx);
    const statuses = (await Promise.all(Array.from({ length: 5 }, () => send(payload)))).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409, 409, 409, 409]);
    expect(handlerCalls).toBe(calledBefore + 1);
  });
});

describe("unresolved and refused settlements keep their evidence and never complete", () => {
  test("a pending authorize keeps the facilitator's signature and never starts the handler", async () => {
    h.ledger.commitment = "confirmed";
    const calledBefore = handlerCalls;
    const res = await pay();
    expect(res.status).toBe(402);
    expect(handlerCalls).toBe(calledBefore);
    const receipt = res.paymentResponse as SettleResponse;
    expect(receipt.errorReason).toBe("settlement_pending");
    expect(receipt.transaction).not.toBe("");
    const record = store.list().find((r) => r.authorizeReceipt?.transaction === receipt.transaction)!;
    expect(record.status).toBe("authorize-pending");
    expect(record.authorize!.signature).toBe(receipt.transaction);
    expect(store.unresolved().map((r) => r.fingerprint)).toContain(record.fingerprint);
  });

  test("a lost facilitator response leaves the authorize unresolved and listed, even though it landed", async () => {
    let calls = 0;
    const lossy: typeof fetch = async (input, init) => {
      await fetch(input, init); // the facilitator really settles…
      calls += 1;
      throw new Error("socket hang up"); // …but its answer never arrives.
    };
    const lost = await startServer(createResourceApp(resourceConfig({ fetchImpl: lossy })));
    try {
      const calledBefore = handlerCalls;
      const submissionsBefore = h.ledger.submissions.length;
      const res = await pay(lost.url);
      expect(res.status).toBe(402);
      expect(res.paymentResponse).toBeUndefined();
      expect(res.body).toEqual({ error: "settlement_unknown", status: "UNKNOWN" });
      expect(calls).toBe(1);
      expect(handlerCalls).toBe(calledBefore);
      expect(h.ledger.submissions.slice(submissionsBefore).map((s) => s.status)).toEqual(["succeeded"]);
      const record = store.list().find((r) => r.status === "authorize-pending" && r.note?.includes("socket hang up"))!;
      expect(record.authorize!.signature).toBe("");
      expect(record.note).toMatch(/facilitator response lost/);
      expect(store.unresolved().map((r) => r.fingerprint)).toContain(record.fingerprint);
    } finally {
      await lost.close();
    }
  });

  test("a pending terminal settle keeps its signature and never reports completion", async () => {
    let submits = 0;
    h.ledger.beforeSubmit = () => {
      submits += 1;
      if (submits === 2) h.ledger.commitment = "confirmed"; // authorize finalizes; the capture does not.
    };
    const res = await pay();
    expect(res.status).toBe(500);
    const receipt = res.paymentResponse as SettleResponse;
    expect(receipt.success).toBe(false);
    expect(receipt.errorReason).toBe("settlement_pending");
    expect((res.body as { ok?: boolean }).ok).toBeUndefined();
    const record = store.list().find((r) => r.terminalReceipt?.transaction === receipt.transaction)!;
    expect(record.status).toBe("terminal-pending");
    expect(record.terminal!.signature).toBe(receipt.transaction);
    expect(record.handlerResult).toEqual({ ok: true, amount: "100", releaseRemainder: true });
  });

  test("a facilitator that never answers is cut off at facilitatorTimeoutMs and stays unresolved", async () => {
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    const app = await startServer(createResourceApp(resourceConfig({ fetchImpl: hanging, facilitatorTimeoutMs: 50 })));
    try {
      const calledBefore = handlerCalls;
      const start = Date.now();
      const res = await pay(app.url);
      expect(Date.now() - start).toBeLessThan(2_000);
      expect(res.status).toBe(402);
      expect(handlerCalls).toBe(calledBefore);
      const record = store.list().find((r) => r.status === "authorize-pending" && /timeout|abort/i.test(r.note ?? ""))!;
      expect(record.note).toMatch(/facilitator response lost/);
    } finally {
      await app.close();
    }
  });

  test("an unrecognized facilitator reason is unresolved, never a definitive rejection", async () => {
    const unknown: typeof fetch = async () =>
      new Response(JSON.stringify({ success: false, errorReason: "some_future_reason", transaction: "", network: h.ledger.network }), { status: 200 });
    const app = await startServer(createResourceApp(resourceConfig({ fetchImpl: unknown })));
    try {
      const calledBefore = handlerCalls;
      const res = await pay(app.url);
      expect(res.status).toBe(402);
      expect(handlerCalls).toBe(calledBefore);
      const record = store.list().find((r) => r.note?.includes("some_future_reason"))!;
      expect(record.status).toBe("authorize-pending");
      expect(record.authorize!.signature).toBe("");
      expect(record.authorizeReceipt).toBeUndefined();
      expect(res.paymentResponse).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  test("a gateway refusal is a definitive authorize rejection and never starts the handler", async () => {
    const capped = new SponsorshipGuard({ ledger: h.ledger, feePayer: h.facilitatorKey.address, maxAttempts: 0, minLamportsBalance: 1n });
    const cappedGateway = await startServer(createGatewayApp(h.facilitator, { bearerToken: BEARER_TOKEN, sponsorship: capped, allowlist: { merchant: h.server.address, mint: h.mint } }));
    const app = await startServer(createResourceApp(resourceConfig({ facilitatorUrl: cappedGateway.url })));
    try {
      const calledBefore = handlerCalls;
      const res = await pay(app.url);
      expect(res.status).toBe(402);
      expect(handlerCalls).toBe(calledBefore);
      const receipt = res.paymentResponse as SettleResponse;
      expect(receipt.errorReason).toMatch(/facilitator_refused/);
      expect(store.list().find((r) => r.authorizeReceipt?.errorReason === receipt.errorReason)?.status).toBe("authorize-rejected");
    } finally {
      await app.close();
      await cappedGateway.close();
    }
  });
});

describe("gateway: authentication and allowlist precede the facilitator", () => {
  test("a crash after metering preserves the complete handler result before terminal signing", async () => {
    const app = await startServer(createResourceApp(resourceConfig({
      handler: async () => ({ ok: true, amount: 37n, releaseRemainder: false }),
      getLatestBlockhash: async () => { throw new Error("injected stop after metering"); },
    })));
    try {
      const response = await pay(app.url);
      expect(response.status).toBe(500);
      const record = store.unresolved().find(r => r.note?.includes("injected stop after metering"))!;
      expect(record.status).toBe("handler-succeeded");
      expect(record.handlerResult).toEqual({ ok: true, amount: "37", releaseRemainder: false });
      expect(record.terminal).toBeUndefined();
    } finally { await app.close(); }
  });
  test.each(["empty", "foreign-network", "unrelated-signature", "http-error"])("malformed success receipt (%s) never starts the handler or leaks success", async (variant) => {
    const corrupt: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      const receipt = await response.json() as SettleResponse;
      if (variant === "empty") receipt.transaction = "";
      if (variant === "foreign-network") receipt.network = "solana:foreign";
      if (variant === "unrelated-signature") receipt.transaction = "1".repeat(64);
      return new Response(JSON.stringify(receipt), { status: variant === "http-error" ? 500 : 200 });
    };
    const app = await startServer(createResourceApp(resourceConfig({ fetchImpl: corrupt })));
    try {
      const before = handlerCalls;
      const response = await pay(app.url);
      expect(handlerCalls).toBe(before);
      expect(response.status).toBe(402);
      expect(response.paymentResponse).toBeUndefined();
      expect(response.body).toEqual({ error: "settlement_unknown", status: "UNKNOWN" });
    } finally { await app.close(); }
  });

  test("a request with no bearer token is rejected before reaching the facilitator", async () => {
    const before = h.ledger.submissions.length;
    const res = await fetch(`${gateway.url}/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(h.body(authorizePayload(await h.signedAuthorize({ salt: h.newSalt() })))),
    });
    expect(res.status).toBe(401);
    expect(h.ledger.submissions.length).toBe(before);
  });

  test("a request with the wrong bearer token is rejected before reaching the facilitator", async () => {
    const before = h.ledger.submissions.length;
    const res = await fetch(`${gateway.url}/settle`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong-token" },
      body: JSON.stringify(h.body(authorizePayload(await h.signedAuthorize({ salt: h.newSalt() })))),
    });
    expect(res.status).toBe(401);
    expect(h.ledger.submissions.length).toBe(before);
  });

  test("a non-allowlisted merchant is rejected before reaching the facilitator", async () => {
    const before = h.ledger.submissions.length;
    const req = h.requirements({ payTo: h.outsider.address });
    const res = await fetch(`${gateway.url}/settle`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${BEARER_TOKEN}` },
      body: JSON.stringify(h.body(authorizePayload(await h.signedAuthorize({ salt: h.newSalt(), server: h.outsider.address })), req)),
    });
    expect(res.status).toBe(403);
    expect(h.ledger.submissions.length).toBe(before);
  });

  test("/supported stays public and reachable with no bearer token", async () => {
    const res = await fetch(`${gateway.url}/supported`);
    expect(res.status).toBe(200);
  });
});

describe("gateway: sponsorship cap", () => {
  test("denies a settle attempt once the attempt cap is reached, before reaching the facilitator", async () => {
    const cappedGuard = new SponsorshipGuard({ ledger: h.ledger, feePayer: h.facilitatorKey.address, maxAttempts: 0, minLamportsBalance: 1n });
    const capped = await startServer(createGatewayApp(h.facilitator, { bearerToken: BEARER_TOKEN, sponsorship: cappedGuard, allowlist: { merchant: h.server.address, mint: h.mint } }));
    try {
      const before = h.ledger.submissions.length;
      const res = await fetch(`${capped.url}/settle`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${BEARER_TOKEN}` },
        body: JSON.stringify(h.body(authorizePayload(await h.signedAuthorize({ salt: h.newSalt() })))),
      });
      expect(res.status).toBe(429);
      expect(h.ledger.submissions.length).toBe(before);
    } finally {
      await capped.close();
    }
  });
});

// Issue #76: an absent or untrusted original signature is application UNKNOWN, never a receipt.
describe("unknown-signature fence across resource restart", () => {
  test.each(["authorize", "terminal"] as const)("interruption before %s UNKNOWN persistence retains the pre-dispatch record across restart", async stage => {
    const dir = mkdtempSync(join(tmpdir(), "issue76-interrupted-"));
    const localStore = new OperationStore(dir);
    const target = stage === "authorize" ? 1 : 2;
    let requests = 0;
    const lossy: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (++requests === target) throw new Error("lost before interruption");
      return response;
    };
    const update = localStore.update.bind(localStore);
    vi.spyOn(localStore, "update").mockImplementation((fp, patch) => {
      if (patch.status === `${stage}-pending`) throw new Error("interrupted before UNKNOWN write");
      return update(fp, patch);
    });
    const config = resourceConfig({ store: localStore, fetchImpl: lossy });
    const running = await startServer(createResourceApp(config));
    let payload: unknown;
    try {
      const challenge = await signedChallenge(running.url);
      payload = authorizePaymentPayload(challenge.paymentRequired, challenge.accepted, challenge.tx);
      const response = await send(payload, running.url);
      expect(response.status).toBe(500);
      expect(response.headers.get(PAYMENT_RESPONSE_HEADER)).toBeNull();
      const original = localStore.unresolved()[0]!;
      expect(original.status).toBe(stage === "authorize" ? "authorizing" : "terminal-settling");
      expect((stage === "authorize" ? original.authorize! : original.terminal!).transactionBase64.length).toBeGreaterThan(0);
    } finally { await running.close(); }
    const retained = localStore.list();
    const submissions = h.ledger.submissions.length;
    const calls = handlerCalls;
    const restartedStore = new OperationStore(dir);
    const restarted = await startServer(createResourceApp({ ...config, store: restartedStore }));
    try {
      expect((await send(payload, restarted.url)).status).toBe(409);
      expect(restartedStore.unresolved()).toEqual(retained);
      expect(h.ledger.submissions.length).toBe(submissions);
      expect(handlerCalls).toBe(calls);
      expect(requests).toBe(target);
    } finally { await restarted.close(); }
  });
  const faults = ["lost", "timeout", "json", "shape", "empty-pending", "wrong-network", "bad-signature", "foreign-signature", "empty-success", "http-error"] as const;
  test.each((["authorize", "capture", "void"] as const).flatMap(stage => faults.map(fault => [stage, fault] as const)))(
    "%s / %s preserves originals and prevents duplicate economics after restart", async (stage, fault) => {
      const dir = mkdtempSync(join(tmpdir(), "issue76-resource-"));
      const localStore = new OperationStore(dir);
      const foreign = getSignatureFromTransaction(await partiallySignTransaction([h.facilitatorKey.keyPair], await h.signedAuthorize({ salt: h.newSalt() })));
      let requests = 0;
      const intercepted: typeof fetch = async (input, init) => {
        requests += 1;
        if (requests !== (stage === "authorize" ? 1 : 2)) return fetch(input, init);
        if (fault === "timeout") return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
        const response = await fetch(input, init); // original finalizes before the response is lost/corrupted
        if (fault === "lost") throw new Error("issue76 lost finalized response");
        if (fault === "json") return new Response("{", { status: 200 });
        if (fault === "shape") return Response.json({ success: false });
        const receipt = await response.json() as SettleResponse;
        if (["empty-pending", "wrong-network", "bad-signature", "foreign-signature"].includes(fault)) {
          receipt.success = false; receipt.errorReason = "settlement_pending";
        }
        if (fault === "empty-pending" || fault === "empty-success") receipt.transaction = "";
        if (fault === "wrong-network") receipt.network = "solana:foreign";
        if (fault === "bad-signature") receipt.transaction = "bad";
        if (fault === "foreign-signature") receipt.transaction = foreign;
        return Response.json(receipt, { status: fault === "http-error" ? 500 : 200 });
      };
      if (stage === "void") handlerImpl = async () => ({ ok: false, detail: "issue76 handler failure" });
      const config = resourceConfig({ store: localStore, fetchImpl: intercepted, facilitatorTimeoutMs: 100 });
      const running = await startServer(createResourceApp(config));
      const before = h.ledger.submissions.length;
      const handlersBefore = handlerCalls;
      let payload: unknown;
      try {
        const challenge = await signedChallenge(running.url);
        payload = authorizePaymentPayload(challenge.paymentRequired, challenge.accepted, challenge.tx);
        const response = await send(payload, running.url);
        expect(response.status).toBe(stage === "authorize" ? 402 : 500);
        expect(response.headers.get(PAYMENT_RESPONSE_HEADER)).toBeNull();
        expect(await response.json()).toEqual({ error: "settlement_unknown", status: "UNKNOWN" });
        const record = localStore.list()[0]!;
        expect(record.status).toBe(stage === "authorize" ? "authorize-pending" : "terminal-pending");
        const original = stage === "authorize" ? record.authorize! : record.terminal!;
        expect(original.signature).toBe("");
        expect(original.transactionBase64.length).toBeGreaterThan(0);
        expect(stage === "authorize" ? record.authorizeReceipt : record.terminalReceipt).toBeUndefined();
        if (stage !== "authorize") expect(record.handlerResult?.ok).toBe(stage === "capture");
        expect(localStore.unresolved()).toEqual([record]);
        expect(handlerCalls).toBe(handlersBefore + (stage === "authorize" ? 0 : 1));
        expect(requests).toBe(stage === "authorize" ? 1 : 2);
        expect(h.ledger.submissions.length - before).toBe((stage === "authorize" ? 1 : 2) - (fault === "timeout" ? 1 : 0));
        expect((await send(payload, running.url)).status).toBe(409);
      } finally { await running.close(); }
      const retained = localStore.list();
      const submissions = h.ledger.submissions.length;
      const calls = handlerCalls;
      const requestCount = requests;
      const restartedStore = new OperationStore(dir);
      const restarted = await startServer(createResourceApp({ ...config, store: restartedStore }));
      try {
        for (let i = 0; i < 2; i++) expect((await send(payload, restarted.url)).status).toBe(409);
        expect(restartedStore.list()).toEqual(retained);
        expect(restartedStore.unresolved()).toEqual(retained);
        expect(h.ledger.submissions.length).toBe(submissions);
        expect(handlerCalls).toBe(calls);
        expect(requests).toBe(requestCount);
      } finally { await restarted.close(); }
    },
  );
});
