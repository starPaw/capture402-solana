import { existsSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, afterEach, test, vi } from "vitest";
import { payerFixture } from "./fixtures/payer-recovery-fixture.ts";
import { submitPayerRecovery, reconcilePayerRecovery, offerPayerRecovery, payerRecoveryOfferDigest } from "../src/payer-recovery.ts";
const roots: string[] = [];
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
async function fixture() { const f = await payerFixture(); roots.push(f.root); return f; }
const inventory = (f: Awaited<ReturnType<typeof fixture>>) => [f.paths.orders, f.paths.facilitator, f.paths.reclaim, f.paths.operations].flatMap(p => readdirSync(p).map(n => [join(p, n), readFileSync(join(p, n)).toString("base64")]));
test("exact offer, durable attribution/reservation/wire before backend; original UNKNOWN stays blocked", async () => {
  const f = await fixture(), before = inventory(f), req = await f.request(), submit = f.backend.submit;
  f.backend.submit = async tx => {
    const record = readdirSync(f.paths.orders).find(n => n.endsWith(".record"))!;
    const r = JSON.parse(readFileSync(join(f.paths.orders, record), "utf8"));
    expect(r.transactionBase64).toBe(req.transactionBase64); expect(r.offerSha256).toBe(payerRecoveryOfferDigest(req.offer));
    expect(readFileSync(join(f.paths.reclaim, `reclaim-${f.order.payment}.lock`), "utf8")).toBe(r.signature);
    expect(JSON.parse(readFileSync(join(f.paths.reclaim, r.signature + ".json"), "utf8")).transactionBase64).toBe(req.transactionBase64);
    for (const [path, raw] of before) expect(readFileSync(path!).toString("base64")).toBe(raw);
    return submit(tx);
  };
  const result = await submitPayerRecovery(req);
  expect(f.calls).toMatchObject({ simulation: 1, submission: 1, wire: req.transactionBase64 });
  await expect(submitPayerRecovery(req)).rejects.toThrow(); expect(f.calls.submission).toBe(1);
  expect(await reconcilePayerRecovery({ ...f.options, reclaimSignature: result.signature })).toMatchObject({ kind: "not-found" });
  expect(f.calls.submission).toBe(1); expect(existsSync(f.busyPath)).toBe(true); expect(JSON.parse(readFileSync(f.path, "utf8")).status).toBe("pending");
});
test.each(["missing", "hash", "message", "slot", "network", "genesis", "borrowed", "invalid-observation"])("%s capture lifetime provenance refuses without effects", async kind => {
  const f = await fixture(), e = JSON.parse(readFileSync(f.captureJournal, "utf8"));
  if (kind === "missing") delete e.lifetimeProvenance;
  if (kind === "hash") e.lifetimeProvenance.blockhash = f.order.payer;
  if (kind === "message") e.lifetimeProvenance.messageHash = "a".repeat(64);
  if (kind === "slot") e.lifetimeProvenance.origin.slot = "11";
  if (kind === "network") e.lifetimeProvenance.origin.network = "solana:wrong";
  if (kind === "genesis") e.lifetimeProvenance.origin.genesisHash = f.order.payer;
  if (kind === "borrowed") e.lifetimeProvenance.observation.value.blockhash = f.lifetime.blockhash;
  if (kind === "invalid-observation") e.lifetimeProvenance.observation.value.contextSlot = null;
  f.persist(f.captureJournal, e); const before = inventory(f);
  await expect(f.offer()).rejects.toThrow(); expect(inventory(f)).toEqual(before); expect(f.calls.submission).toBe(0);
});
test.each(["origin-unavailable", "origin-wrong-hash", "origin-confirmed", "expiry-unavailable", "hash-active", "expiry-origin", "status-unavailable", "status-processed", "status-no-slot", "payment-stale", "payment-missing", "payment-identity", "clock-stale", "clock-before", "clock-weak", "zero-hold", "identity"])("%s chain proof refuses and preserves reservations", async kind => {
  const f = await fixture(), r = f.recoveryReader;
  if (kind.startsWith("origin")) r.verifyBlockhashOrigin = async () => kind === "origin-unavailable" ? { state: "unverified", reason: "origin-unavailable" } : { state: "verified", blockhash: kind === "origin-wrong-hash" ? f.order.payer : f.identity.genesisHash, slot: "10", commitment: "confirmed" as never, network: f.identity.network, genesisHash: f.identity.genesisHash };
  if (kind.startsWith("expiry") || kind === "hash-active") r.getFinalizedBlockhashStatus = async () => kind === "expiry-unavailable" ? { kind: "unavailable", detail: "pruned" } : { kind: "ok", valid: kind === "hash-active", slot: 10n };
  if (kind.startsWith("status")) { const old = r.getSignatureStatus; r.getSignatureStatus = async s => s === f.signature ? kind === "status-unavailable" ? { kind: "unavailable", detail: "missing" } : kind === "status-no-slot" ? { kind: "not-found" } : { kind: "found", commitment: "processed", err: null, slot: 40n, observedSlot: 41n } : old(s); }
  if (kind === "payment-stale") r.getAccountAtLeast = async () => ({ kind: "ok", slot: 1n, account: f.account });
  if (kind === "payment-missing") r.getAccountAtLeast = async () => ({ kind: "ok", slot: 42n, account: null });
  if (kind === "payment-identity") f.account.data[8] = f.account.data[8]! ^ 1;
  if (kind === "zero-hold") new DataView(f.account.data.buffer).setBigUint64(160, 0n, true);
  if (kind.startsWith("clock")) r.getClockAtLeast = async () => ({ kind: "ok", commitment: kind === "clock-weak" ? "confirmed" as never : "finalized", slot: kind === "clock-stale" ? 1n : 43n, unixTimestamp: kind === "clock-before" ? 999n : 1000n });
  if (kind === "identity") r.verifyIdentity = async () => ({ ...f.identity, genesisHash: f.order.payer });
  const before = inventory(f); await expect(f.offer()).rejects.toThrow(); expect(inventory(f)).toEqual(before); expect(f.calls.submission).toBe(0);
});
test.each(["missing-busy", "missing-capture-lock", "orphan-reservation", "orphan-journal", "duplicate-journal", "foreign-operation", "unknown-file", "bom", "duplicate-key", "known-capture", "conflict-void", "capture-wire", "signature"])("%s original evidence refuses", async kind => {
  const f = await fixture();
  if (kind === "missing-busy") unlinkSync(f.busyPath);
  if (kind === "missing-capture-lock") unlinkSync(f.lockPath);
  if (kind === "orphan-reservation") f.persist(join(f.paths.reclaim, `reclaim-${f.order.payment}.lock`), f.signature);
  if (kind === "orphan-journal" || kind === "duplicate-journal") f.persist(join(f.paths.reclaim, f.signature + ".json"), JSON.parse(readFileSync(f.captureJournal, "utf8")));
  if (kind === "foreign-operation") f.persist(join(f.paths.operations, "a".repeat(64) + ".json"), { payment: f.order.payment });
  if (kind === "unknown-file") f.persist(join(f.paths.orders, "unexpected.record"), "{}");
  if (kind === "bom") f.persist(f.captureJournal, "\ufeff" + readFileSync(f.captureJournal, "utf8"));
  if (kind === "duplicate-key") f.persist(f.captureJournal, readFileSync(f.captureJournal, "utf8").replace('{', '{"operation":"void",'));
  if (["known-capture", "capture-wire", "signature"].includes(kind)) { const o = JSON.parse(readFileSync(f.path, "utf8")); if (kind === "known-capture") o.events[1].status = "finalized"; if (kind === "capture-wire") o.events[1].transactionBase64 = o.events[0].transactionBase64; if (kind === "signature") o.events[1].transaction = f.authSignature; f.persist(f.path, o); }
  if (kind === "conflict-void") f.persist(f.path + ".void.lock", { ...f.event, action: "void" });
  const before = inventory(f); await expect(f.offer()).rejects.toThrow(); expect(inventory(f)).toEqual(before);
});
test.each(["consent-missing", "consent-digest", "owner-payment", "offer-account", "offer-blockhash", "offer-instruction", "merchant-signature", "wire-signature", "state-changed", "evidence-replaced"])("%s exact offer/consent refuses before any backend bytes", async kind => {
  const f = await fixture(), req = await f.request();
  if (kind === "consent-missing") req.consent.accept = false as never;
  if (kind === "consent-digest") req.consent.offerSha256 = "a".repeat(64);
  if (kind === "owner-payment") req.consent.ownerAuthorization = "payer-reclaim:wrong";
  if (kind === "offer-account") (req.offer as any).payment = f.order.payer;
  if (kind === "offer-blockhash") (req.offer as any).lifetime.blockhash = f.identity.genesisHash;
  if (kind === "offer-instruction") (req.offer as any).messageHash = "a".repeat(64);
  if (kind === "merchant-signature") req.transactionBase64 = f.event.transactionBase64 as never;
  if (kind === "wire-signature") { const raw = Buffer.from(req.transactionBase64, "base64"); raw[1] = raw[1]! ^ 1; req.transactionBase64 = raw.toString("base64") as never; }
  if (kind === "state-changed") new DataView(f.account.data.buffer).setBigUint64(160, 60000000n, true);
  if (kind === "evidence-replaced") { const raw = readFileSync(f.lockPath); unlinkSync(f.lockPath); writeFileSync(f.lockPath, raw, { mode: 0o600 }); }
  const before = inventory(f); await expect(submitPayerRecovery(req)).rejects.toThrow(); expect(f.calls).toMatchObject({ simulation: 0, submission: 0 }); expect(inventory(f)).toEqual(before);
});
test("state changes during unsigned simulation invalidate reviewed offer", async () => {
  const f = await fixture(), req = await f.request(), before = inventory(f);
  f.backend.simulate = async () => { new DataView(f.account.data.buffer).setBigUint64(160, 60000000n, true); return { ok: true }; };
  await expect(submitPayerRecovery(req)).rejects.toThrow(); expect(f.calls.submission).toBe(0); expect(inventory(f)).toEqual(before);
});
test("lost response: same signature only, no resubmit; successor requires new consent and accepted proof", async () => {
  const f = await fixture(), req = await f.request(); f.backend.submit = async () => { f.calls.submission++; throw new Error("lost"); };
  await expect(submitPayerRecovery(req)).rejects.toThrow(/reconcile original/);
  const sig = readFileSync(join(f.paths.reclaim, `reclaim-${f.order.payment}.lock`), "utf8");
  await expect(submitPayerRecovery(req)).rejects.toThrow(); expect(f.calls.submission).toBe(1);
  expect(await reconcilePayerRecovery({ ...f.options, reclaimSignature: sig })).toMatchObject({ kind: "not-found" });
  await expect(offerPayerRecovery({ ...f.options, lifetime: f.lifetime, retryAfter: f.signature })).rejects.toThrow();
  await expect(f.offer()).rejects.toThrow();
});
test("two simultaneous recovery submissions: only one backend call", async () => {
  const f = await fixture(), req = await f.request(); const outcomes = await Promise.allSettled([submitPayerRecovery(req), submitPayerRecovery(req)]);
  expect(outcomes.filter(o => o.status === "fulfilled")).toHaveLength(1); expect(f.calls.submission).toBe(1);
});
test("recovery record cannot unlock through outcome-apply, preflight or #57 profile", async () => {
  const f = await fixture(); await f.submit(); const before = inventory(f);
  const { applyRestaurantOutcome, restaurantOutcomeEvidence } = await import("../src/restaurant-outcome-apply.ts");
  const request = { ...f.options, signature: f.signature };
  await expect(restaurantOutcomeEvidence(request)).rejects.toThrow();
  const evidenceDigest = "f".repeat(64);
  await expect(applyRestaurantOutcome({ ...request, evidenceDigest, reader: f.reader })).rejects.toThrow();
  const { project } = await import("../src/quarantine-projector.ts");
  const stores = Object.fromEntries(Object.entries(f.paths).map(([role, path]) => [role, readdirSync(path).map(name => ({ name, rawBase64: readFileSync(join(path, name)).toString("base64") }))]));
  await expect(project({ stores, selected: { signature: f.signature, messageHash: "a".repeat(64), wireSha256: "b".repeat(64), journalSha256: "c".repeat(64) }, network: f.identity.network, genesisHash: f.identity.genesisHash, programId: f.identity.programId, viewerSha: "d".repeat(40), inventorySha256: "e".repeat(64), tupleSha256: "f".repeat(64), snapshotAt: new Date().toISOString() })).rejects.toThrow();
  expect(inventory(f)).toEqual(before); expect(f.calls.submission).toBe(1);
});
test.each(["offer", "submit", "reconcile"])("live CLI %s refuses before stores, keys or effects", async verb => {
  const { payerRecoveryMain } = await import("../src/payer-recovery-cli.ts");
  await expect(payerRecoveryMain([verb])).rejects.toThrow(/no trusted live enrollment verifier/);
});
test("explicit finalized-failure reconciliation admits one separately consented successor", async () => {
  const f = await fixture(), firstReq = await f.request(), first = await submitPayerRecovery(firstReq), old = f.recoveryReader.getSignatureStatus;
  f.recoveryReader.getSignatureStatus = async sig => sig === first.signature ? { kind: "found", commitment: "finalized", err: "synthetic failure", slot: 45n, observedSlot: 46n } : old(sig);
  await expect(offerPayerRecovery({ ...f.options, lifetime: f.lifetime, retryAfter: first.signature })).rejects.toThrow(); // failure not yet reconciled
  await reconcilePayerRecovery({ ...f.options, reclaimSignature: first.signature });
  const lifetime = { ...f.lifetime, blockhash: f.merchant.address as never, blockhashSlot: 70n };
  f.recoveryReader.getFinalizedBlockhashStatus = async (hash, origin) => ({ kind: "ok", valid: hash === lifetime.blockhash, slot: origin > 41n ? origin : 41n });
  const offer = await offerPayerRecovery({ ...f.options, lifetime, retryAfter: first.signature });
  const req = await f.request(offer); expect(req.consent.offerSha256).not.toBe(firstReq.consent.offerSha256);
  const second = await submitPayerRecovery(req);
  expect(second.signature).not.toBe(first.signature); expect(f.calls.submission).toBe(2);
  await expect(submitPayerRecovery(req)).rejects.toThrow(); expect(f.calls.submission).toBe(2);
  expect(readFileSync(join(f.paths.reclaim, `reclaim-${f.order.payment}.lock`), "utf8")).toBe(first.signature);
  expect(readFileSync(join(f.paths.reclaim, `reclaim-${f.order.payment}-after-${first.signature}.lock`), "utf8")).toBe(second.signature);
  expect(existsSync(f.busyPath)).toBe(true);
});
test("canonical expiry with unchanged H/F permits one fresh consented successor, never reuses old bytes", async () => {
  const f = await fixture(), firstReq = await f.request(), first = await submitPayerRecovery(firstReq);
  const lifetime = { ...f.lifetime, blockhash: f.merchant.address as never, blockhashSlot: 70n };
  f.recoveryReader.getFinalizedBlockhashStatus = async (hash, origin) => ({ kind: "ok", valid: hash === lifetime.blockhash, slot: origin === 44n ? 49n : origin > 41n ? origin : 41n });
  const offer = await offerPayerRecovery({ ...f.options, lifetime, retryAfter: first.signature });
  const request = await f.request(offer); expect(request.consent.offerSha256).not.toBe(firstReq.consent.offerSha256);
  await expect(submitPayerRecovery({ ...request, consent: firstReq.consent })).rejects.toThrow();
  const second = await submitPayerRecovery(request); expect(second.signature).not.toBe(first.signature); expect(f.calls.submission).toBe(2);
});
test.each(["record-wire", "record-consent", "record-digest", "record-originals", "record-proof", "record-mode", "record-inode", "partial-record", "missing-root", "wrong-root", "missing-journal", "orphan-successor", "cyclic-chain"])("%s persisted attribution refuses same-signature reconciliation without effects", async kind => {
  const f = await fixture(), first = await f.submit(), recordPath = join(f.paths.orders, readdirSync(f.paths.orders).find(n => n.endsWith(".record"))!), root = join(f.paths.reclaim, `reclaim-${f.order.payment}.lock`);
  const { chmodSync } = await import("node:fs");
  if (kind.startsWith("record-") || kind === "partial-record") {
    const raw = readFileSync(recordPath, "utf8"), r = JSON.parse(raw); chmodSync(recordPath, 0o600);
    if (kind === "record-wire") r.transactionBase64 = f.event.transactionBase64;
    if (kind === "record-consent") r.consent.accept = false;
    if (kind === "record-digest") r.offerSha256 = "f".repeat(64);
    if (kind === "record-originals") r.originals.pop();
    if (kind === "record-proof") r.submissionProof.pins = [];
    if (kind === "record-inode") unlinkSync(recordPath);
    writeFileSync(recordPath, kind === "partial-record" ? "{" : JSON.stringify(r), { mode: 0o600 });
    if (kind !== "record-mode") chmodSync(recordPath, 0o400);
  }
  if (kind === "missing-root") unlinkSync(root);
  if (kind === "wrong-root") f.persist(root, f.signature);
  if (kind === "missing-journal") unlinkSync(join(f.paths.reclaim, first.signature + ".json"));
  if (kind === "orphan-successor" || kind === "cyclic-chain") f.persist(join(f.paths.reclaim, `reclaim-${f.order.payment}-after-${first.signature}.lock`), kind === "cyclic-chain" ? first.signature : f.signature);
  const before = inventory(f); await expect(reconcilePayerRecovery({ ...f.options, reclaimSignature: first.signature })).rejects.toThrow(); expect(inventory(f)).toEqual(before); expect(f.calls.submission).toBe(1);
});
test("observed race after persistence keeps all new reservations and refuses broadcast", async () => {
  const f = await fixture(), req = await f.request(), read = f.recoveryReader.getAccountAtLeast; let calls = 0;
  f.recoveryReader.getAccountAtLeast = async (...args) => { calls++; if (calls === 5) new DataView(f.account.data.buffer).setBigUint64(160, 60000000n, true); return read(...args); };
  await expect(submitPayerRecovery(req)).rejects.toThrow(); expect(f.calls.submission).toBe(0);
  expect(readdirSync(f.paths.orders).some(n => n.endsWith(".record"))).toBe(true);
  expect(existsSync(join(f.paths.reclaim, `reclaim-${f.order.payment}.lock`))).toBe(true);
  expect(readdirSync(f.paths.reclaim).some(n => n.endsWith(".json"))).toBe(true);
  await expect(submitPayerRecovery(req)).rejects.toThrow(); expect(f.calls.submission).toBe(0);
});
test("one deadline bounds unsigned simulation and late completion cannot prepare or submit", async () => {
  const f = await fixture(), req = await f.request(); let finish!: () => void;
  let signal!: () => void; const entered = new Promise<void>(done => { signal = done; });
  f.backend.simulate = () => {
    // Start the virtual clock only after real evidence/signature preflight reached simulation.
    // CPU contention cannot turn this into a different early-preflight timeout case.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    return new Promise(done => { finish = () => done({ ok: true }); signal(); });
  };
  try {
    const pending = submitPayerRecovery({ ...req, timeoutMs: 5000 });
    const rejected = expect(pending).rejects.toThrow(/deadline/);
    await Promise.race([entered, pending.then(() => { throw new Error("simulation must remain pending"); }, error => { throw error; })]);
    await vi.advanceTimersByTimeAsync(5001); await rejected;
    finish(); await vi.advanceTimersByTimeAsync(20);
    expect(f.calls.submission).toBe(0); expect(readdirSync(f.paths.reclaim)).toEqual([".coordination.lock"]); expect(readdirSync(f.paths.orders).some(n => n.endsWith(".record"))).toBe(false);
  } finally { vi.useRealTimers(); }
});
test("fabricated enrollment and changed enrollment metadata refuse before effects", async () => {
  const f = await fixture(), req = await f.request();
  await expect(submitPayerRecovery({ ...req, enrollment: { profile: "isolated-one-uid-fixture" } })).rejects.toThrow(/enrollment verifier/);
  const lock = join(f.paths.orders, ".coordination.lock"), metadata = JSON.parse(readFileSync(lock, "utf8")); metadata.domain = "f".repeat(32); f.persist(lock, metadata);
  await expect(submitPayerRecovery(req)).rejects.toThrow(); expect(f.calls.submission).toBe(0);
});
test("evidence changed while backend returns: preserve reservations without outcome mutation or retry", async () => {
  const f = await fixture(), req = await f.request(), submit = f.backend.submit;
  f.backend.submit = async tx => { const result = await submit(tx); f.persist(f.lockPath, { ...f.event, label: "changed while awaiting response" }); return result; };
  await expect(submitPayerRecovery(req)).rejects.toThrow(); expect(f.calls.submission).toBe(1);
  const entries = readdirSync(f.paths.reclaim).filter(n => n.endsWith(".json")).map(n => JSON.parse(readFileSync(join(f.paths.reclaim, n), "utf8")));
  expect(entries).toHaveLength(1); expect(entries[0].attempts[0].outcome).toBeUndefined();
  await expect(submitPayerRecovery(req)).rejects.toThrow(); expect(f.calls.submission).toBe(1);
});
test.each(["source", "extra-origin", "extra-provenance", "orphan-other-action", "orphan-other-busy"])("%s refuses incomplete provenance or orphan locks in the complete domain", async kind => {
  const f = await fixture();
  if (kind.startsWith("orphan")) f.persist(join(f.paths.orders, "b".repeat(32) + (kind === "orphan-other-action" ? ".json.beer.lock" : ".json.busy")), kind === "orphan-other-action" ? f.event : "beer");
  else { const e = JSON.parse(readFileSync(f.captureJournal, "utf8")); if (kind === "source") e.lifetimeProvenance.observation.source = "foreign"; if (kind === "extra-origin") e.lifetimeProvenance.origin.trusted = true; if (kind === "extra-provenance") e.lifetimeProvenance.bypass = true; f.persist(f.captureJournal, e); }
  const before = inventory(f); await expect(f.offer()).rejects.toThrow(); expect(inventory(f)).toEqual(before); expect(f.calls.submission).toBe(0);
});
