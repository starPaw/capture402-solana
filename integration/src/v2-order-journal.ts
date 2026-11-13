// Permanent per-order reservations, independent of payer, salt, expiry and PDA.
// No release/reset/TTL API. Runtime startup only opens an explicitly enrolled store.
// This is persistence infrastructure, not a transaction/receipt verifier: its
// authorization caller must verify the complete wire and pinned finalized evidence.
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, statfsSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isAddress, type Address } from "@solana/kit";
import { createDurableFile } from "./durable-file.ts";
import { validV2ErrorJson } from "./v2-order-evidence.ts";

export type V2OrderBinding = {
  namespace: string;
  network: string;
  genesisHash: Address;
  programId: Address;
  merchant: Address;
  providerId: string;
};
export type V2OrderEnrollment = { schema: 1; storeId: string; device: string; inode: string; binding: V2OrderBinding };

/** Private, canonical terms retained before accessing any signer. */
export type V2OrderRequest = {
  orderId: string;
  payer: Address;
  mint: Address;
  rentRefundRecipient: Address;
  feePayer: Address;
  payment: Address;
  salt: string;
  authorizeUntilSlot: string;
  maximum: string;
  captureDeadline: string;
  refundDeadline: string;
  blockhash: string;
  lastValidBlockHeight: string | null;
  messageBase64: string;
};
export type V2SignedAttempt = { signature: string; transactionBase64: string };
export type V2OrderEvidence = { slot: string; transactionBase64: string; errorJson: string | null };
export type V2OrderObservation = {
  status: "UNKNOWN" | "AUTHORIZED" | "FAILED";
  signature: string;
  commitment: "finalized" | null;
  evidence: V2OrderEvidence | null;
};
type Claim = { request: V2OrderRequest; requestHash: string };
type Envelope<T> = { schema: 1; storeId: string; orderId: string; stage: string; previous: string; body: T };
export type V2OrderSnapshot = {
  status: "UNKNOWN" | "AUTHORIZED" | "FAILED";
  reason: "reserved" | "signed" | "dispatch-uncertain" | "observation" | "incomplete-journal";
  requestHash?: string;
  signature?: string;
};
type LeaseState = { orderId: string; phase: "claim" | "signed" | "dispatch" | "done" | "blocked"; hash: string };
export type V2OrderLease = Readonly<{ orderId: string }>;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const hex32 = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function fail(): never { throw Error("v2 order journal unavailable or changed; retain UNKNOWN"); }
const exact = (value: unknown, keys: string): value is Record<string, any> => value !== null && typeof value === "object"
  && !Array.isArray(value) && Object.keys(value).sort().join(",") === keys.split(",").sort().join(",");
function unsigned(value: unknown, maximum = (1n << 64n) - 1n): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= maximum;
}
export function canonicalBase64(value: unknown, maxBytes = 1232): value is string {
  if (typeof value !== "string" || !value || value.length > maxBytes * 2) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.length > 0 && decoded.length <= maxBytes && decoded.toString("base64") === value;
}
function binding(value: V2OrderBinding): V2OrderBinding {
  if (!exact(value, "namespace,network,genesisHash,programId,merchant,providerId")
      || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value.namespace)
      || !/^solana:[a-zA-Z0-9_-]{1,80}$/.test(value.network)
      || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value.providerId)
      || ![value.genesisHash, value.programId, value.merchant].every(isAddress)) fail();
  return { namespace: value.namespace, network: value.network, genesisHash: value.genesisHash,
    programId: value.programId, merchant: value.merchant, providerId: value.providerId };
}
export function canonicalV2OrderRequest(value: V2OrderRequest): V2OrderRequest {
  if (!exact(value, "orderId,payer,mint,rentRefundRecipient,feePayer,payment,salt,authorizeUntilSlot,maximum,captureDeadline,refundDeadline,blockhash,lastValidBlockHeight,messageBase64")
      || !hex32(value.orderId) || !hex32(value.salt)
      || ![value.payer, value.mint, value.rentRefundRecipient, value.feePayer, value.payment, value.blockhash].every(isAddress)
      || !unsigned(value.authorizeUntilSlot, (1n << 64n) - 2n)
      || !unsigned(value.maximum) || value.maximum === "0"
      || !unsigned(value.captureDeadline, (1n << 63n) - 1n) || value.captureDeadline === "0"
      || !unsigned(value.refundDeadline, (1n << 63n) - 1n) || BigInt(value.refundDeadline) < BigInt(value.captureDeadline)
      || value.lastValidBlockHeight !== null && !unsigned(value.lastValidBlockHeight) || !canonicalBase64(value.messageBase64)) fail();
  return { orderId: value.orderId, payer: value.payer, mint: value.mint, rentRefundRecipient: value.rentRefundRecipient,
    feePayer: value.feePayer, payment: value.payment, salt: value.salt, authorizeUntilSlot: value.authorizeUntilSlot,
    maximum: value.maximum, captureDeadline: value.captureDeadline, refundDeadline: value.refundDeadline,
    blockhash: value.blockhash, lastValidBlockHeight: value.lastValidBlockHeight, messageBase64: value.messageBase64 };
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function directory(path: string) {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o777n) !== 0o700n) fail();
  return stat;
}
function localFilesystem(path: string) {
  const kind = statfsSync(path, { bigint: true }).type;
  if (!(process.platform === "darwin" && [0x1an, 0x11n].includes(kind)
      || process.platform === "linux" && [0xef53n, 0x58465342n, 0x9123683en].includes(kind))) fail();
}
function readSafe(path: string, durable = false): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true }), named = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.getuid!())
        || (before.mode & 0o777n) !== 0o600n || before.size > 16_384n || before.dev !== named.dev || before.ino !== named.ino || named.isSymbolicLink()) fail();
    const raw = readFileSync(fd, "utf8"), after = fstatSync(fd, { bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || BigInt(Buffer.byteLength(raw)) !== before.size) fail();
    if (durable) { fsyncSync(fd); syncDirectory(dirname(path)); }
    return raw;
  } finally { closeSync(fd); }
}

/** Explicit offline initialization only; existing/partial directories refuse. Save
 * the returned enrollment in trusted configuration, independently of this store. */
export function initializeV2OrderJournal(path: string, configured: V2OrderBinding): V2OrderEnrollment {
  const pinned = binding(configured);
  mkdirSync(path, { mode: 0o700 });
  const root = realpathSync(path), stat = directory(root);
  localFilesystem(root);
  const enrollment: V2OrderEnrollment = { schema: 1, storeId: randomBytes(32).toString("hex"),
    device: stat.dev.toString(), inode: stat.ino.toString(), binding: pinned };
  createDurableFile(join(root, "enrollment.json"), JSON.stringify(enrollment));
  // Persist every ancestor that might have been freshly created by an installer.
  for (let current = root;; current = dirname(current)) { syncDirectory(current); if (dirname(current) === current) break; }
  return enrollment;
}

export class V2OrderJournal {
  readonly root: string;
  readonly enrollment: Readonly<V2OrderEnrollment>;
  private readonly enrollmentRaw: string;
  private readonly leases = new WeakMap<V2OrderLease, LeaseState>();

  constructor(path: string, expected: V2OrderEnrollment) {
    if (!exact(expected, "schema,storeId,device,inode,binding") || expected.schema !== 1 || !hex32(expected.storeId)
        || !unsigned(expected.device) || !unsigned(expected.inode)) fail();
    directory(path); // A symlink as the selected store itself must not be followed.
    this.root = realpathSync(resolve(path));
    this.enrollment = Object.freeze({ schema: 1, storeId: expected.storeId, device: expected.device, inode: expected.inode,
      binding: Object.freeze(binding(expected.binding)) });
    this.enrollmentRaw = JSON.stringify(this.enrollment);
    this.assert();
  }

  assert(): void {
    const stat = directory(this.root);
    if (stat.dev.toString() !== this.enrollment.device || stat.ino.toString() !== this.enrollment.inode
        || realpathSync(this.root) !== this.root || readSafe(join(this.root, "enrollment.json")) !== this.enrollmentRaw) fail();
    localFilesystem(this.root);
  }
  orderPath(orderId: string): string {
    if (!hex32(orderId)) fail();
    // Deliberately excludes all mutable payment/chain/signature parameters.
    return join(this.root, sha(JSON.stringify(["capture402-v2-order", this.enrollment.binding.namespace, orderId])));
  }
  hasReservation(orderId: string): boolean {
    this.assert();
    try { lstatSync(this.orderPath(orderId)); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }
  private record<T>(orderId: string, stage: string, previous: string, body: T): string {
    return JSON.stringify({ schema: 1, storeId: this.enrollment.storeId, orderId, stage, previous, body } satisfies Envelope<T>);
  }
  private read<T>(orderId: string, stage: string, previous: string, durable = false): { raw: string; body: T } {
    const dir = this.orderPath(orderId); directory(dir);
    const raw = readSafe(join(dir, stage + ".json"), durable), e = JSON.parse(raw);
    if (!exact(e, "schema,storeId,orderId,stage,previous,body") || e.schema !== 1 || e.storeId !== this.enrollment.storeId
        || e.orderId !== orderId || e.stage !== stage || e.previous !== previous || JSON.stringify(e) !== raw) fail();
    return { raw, body: e.body as T };
  }
  private append(lease: V2OrderLease, phase: LeaseState["phase"], stage: string, body: unknown) {
    const held = this.leases.get(lease);
    if (!held || held.phase !== phase) fail();
    try {
      this.assert(); directory(this.orderPath(held.orderId));
      const raw = this.record(held.orderId, stage, held.hash, body);
      createDurableFile(join(this.orderPath(held.orderId), stage + ".json"), raw);
      this.assert(); held.hash = sha(raw);
    } catch (error) { held.phase = "blocked"; throw error; }
    return held;
  }

  /** Only this invocation receives an in-memory continuation capability. A crash
   * cannot recreate it. An existing or partial order directory permanently wins. */
  claim(input: V2OrderRequest): { kind: "claimed"; lease: V2OrderLease } | { kind: "existing"; conflict: boolean; snapshot: V2OrderSnapshot } {
    const request = canonicalV2OrderRequest(input), requestHash = sha(JSON.stringify(request));
    this.assert(); const path = this.orderPath(request.orderId);
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const snapshot = this.snapshot(request.orderId);
      return { kind: "existing", conflict: snapshot.requestHash !== requestHash, snapshot };
    }
    syncDirectory(this.root);
    const raw = this.record(request.orderId, "claim", "", { request, requestHash } satisfies Claim);
    createDurableFile(join(path, "claim.json"), raw);
    this.assert();
    const lease = Object.freeze({ orderId: request.orderId });
    this.leases.set(lease, { orderId: request.orderId, phase: "claim", hash: sha(raw) });
    return { kind: "claimed", lease };
  }
  signed(lease: V2OrderLease, attempt: V2SignedAttempt): void {
    if (!exact(attempt, "signature,transactionBase64") || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(attempt.signature) || !canonicalBase64(attempt.transactionBase64)) fail();
    const held = this.append(lease, "claim", "signed", { signature: attempt.signature, transactionBase64: attempt.transactionBase64 });
    held.phase = "signed";
  }
  assertSigning(lease: V2OrderLease): void {
    const held = this.leases.get(lease);
    if (!held || held.phase !== "claim") fail();
    try {
      this.assert();
      if (sha(this.read<Claim>(held.orderId, "claim", "").raw) !== held.hash) fail();
    } catch (error) { held.phase = "blocked"; throw error; }
  }
  dispatch(lease: V2OrderLease): void {
    const held = this.append(lease, "signed", "dispatch", { action: "submit-original-once" });
    held.phase = "dispatch";
  }
  assertDispatch(lease: V2OrderLease): void {
    const held = this.leases.get(lease);
    if (!held || held.phase !== "dispatch") fail();
    try {
      this.assert();
      const claim = this.read<Claim>(held.orderId, "claim", "");
      const signed = this.read<V2SignedAttempt>(held.orderId, "signed", sha(claim.raw));
      const dispatch = this.read(held.orderId, "dispatch", sha(signed.raw));
      if (sha(dispatch.raw) !== held.hash) fail();
      this.assert();
    } catch (error) { held.phase = "blocked"; throw error; }
  }
  observe(lease: V2OrderLease, observation: V2OrderObservation): void {
    if (!validObservation(observation)) fail();
    this.assertDispatch(lease);
    const claim = this.read<Claim>(lease.orderId, "claim", "");
    const signed = this.read<V2SignedAttempt>(lease.orderId, "signed", sha(claim.raw));
    if (observation.signature !== signed.body.signature || observation.evidence && observation.evidence.transactionBase64 !== signed.body.transactionBase64) fail();
    const held = this.append(lease, "dispatch", "observation", { ...observation });
    held.phase = "done";
  }
  block(lease: V2OrderLease): void { const held = this.leases.get(lease); if (held) held.phase = "blocked"; }

  /** Read original evidence only. Missing/incomplete records never authorize a
   * fresh attempt. Re-flush a complete terminal observation before exposing it. */
  snapshot(orderId: string): V2OrderSnapshot {
    this.assert();
    let requestHash: string | undefined, signature: string | undefined;
    let reason: V2OrderSnapshot["reason"] = "incomplete-journal";
    try {
      const claim = this.read<Claim>(orderId, "claim", "");
      if (!exact(claim.body, "request,requestHash")) fail();
      const request = canonicalV2OrderRequest(claim.body.request);
      if (request.orderId !== orderId || claim.body.requestHash !== sha(JSON.stringify(request))) fail();
      requestHash = claim.body.requestHash; reason = "reserved";
      const signed = this.read<V2SignedAttempt>(orderId, "signed", sha(claim.raw));
      if (!exact(signed.body, "signature,transactionBase64") || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signed.body.signature)
          || !canonicalBase64(signed.body.transactionBase64)) fail();
      signature = signed.body.signature; reason = "signed";
      const dispatch = this.read<{ action: string }>(orderId, "dispatch", sha(signed.raw));
      if (!exact(dispatch.body, "action") || dispatch.body.action !== "submit-original-once") fail();
      reason = "dispatch-uncertain";
      const observation = this.read<V2OrderObservation>(orderId, "observation", sha(dispatch.raw), true);
      if (!validObservation(observation.body) || observation.body.signature !== signature
          || observation.body.evidence && observation.body.evidence.transactionBase64 !== signed.body.transactionBase64) fail();
      this.assert();
      return { status: observation.body.status, reason: "observation", requestHash, signature };
    } catch { return { status: "UNKNOWN", reason, ...(requestHash ? { requestHash } : {}), ...(signature ? { signature } : {}) }; }
  }
}

function validObservation(value: V2OrderObservation): boolean {
  if (!exact(value, "status,signature,commitment,evidence") || typeof value.signature !== "string") return false;
  if (value.status === "UNKNOWN") return value.commitment === null && value.evidence === null;
  const proof = value.evidence;
  return ["AUTHORIZED", "FAILED"].includes(value.status) && value.commitment === "finalized"
    && exact(proof, "slot,transactionBase64,errorJson") && unsigned(proof.slot) && canonicalBase64(proof.transactionBase64)
    && (value.status === "AUTHORIZED" ? proof.errorJson === null
      : validV2ErrorJson(proof.errorJson));
}
