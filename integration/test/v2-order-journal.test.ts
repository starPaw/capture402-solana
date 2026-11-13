import { fork, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { initializeV2OrderJournal, V2OrderJournal, type V2OrderRequest } from "../src/v2-order-journal.ts";
import { orderBinding, orderRequest, signedAttempt } from "./fixtures/v2-order-fixture.ts";

const roots: string[] = [];
const worker = fileURLToPath(new URL("./fixtures/v2-order-worker.ts", import.meta.url));
function fixture() {
  const parent = mkdtempSync(join(tmpdir(), "capture402-v2-orders-")); roots.push(parent);
  const root = join(parent, "store"), enrollment = initializeV2OrderJournal(root, orderBinding);
  return { root, enrollment, store: new V2OrderJournal(root, enrollment) };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const calls = (root: string, kind: string) => readdirSync(root).filter(n => n.startsWith(kind + "-")).length;
function reserve(store: V2OrderJournal, request: V2OrderRequest = orderRequest) {
  const claim = store.claim(request); if (claim.kind !== "claimed") throw Error("fixture order already reserved"); return claim.lease;
}

test.each(["salt", "authorizeUntilSlot", "payer", "payment", "feePayer", "blockhash"] as const)("changing %s cannot reserve an order twice", field => {
  const f = fixture(); reserve(f.store);
  const changed = { ...orderRequest, [field]: field === "salt" ? "c".repeat(64) : field === "authorizeUntilSlot" ? "30" : orderBinding.merchant };
  const duplicate = new V2OrderJournal(f.root, f.enrollment).claim(changed);
  expect(duplicate.kind).toBe("existing");
  if (duplicate.kind === "existing") { expect(duplicate.conflict).toBe(true); expect(duplicate.snapshot.status).toBe("UNKNOWN"); }
});

test.each(["UNKNOWN", "AUTHORIZED", "FAILED"] as const)("%s keeps the permanent order reservation and original wire", status => {
  const f = fixture(), lease = reserve(f.store);
  f.store.signed(lease, signedAttempt); f.store.dispatch(lease); f.store.assertDispatch(lease);
  f.store.observe(lease, { status, signature: signedAttempt.signature, commitment: status === "UNKNOWN" ? null : "finalized",
    evidence: status === "UNKNOWN" ? null : { slot: "10", transactionBase64: signedAttempt.transactionBase64, errorJson: status === "FAILED" ? '"AccountNotFound"' : null } });
  const paths = readdirSync(f.store.orderPath(orderRequest.orderId));
  const before = paths.map(p => readFileSync(join(f.store.orderPath(orderRequest.orderId), p)).toString("base64"));
  const restarted = new V2OrderJournal(f.root, f.enrollment);
  expect(restarted.snapshot(orderRequest.orderId).status).toBe(status);
  expect(restarted.claim({ ...orderRequest, salt: "d".repeat(64), authorizeUntilSlot: "999" }).kind).toBe("existing");
  expect(paths.map(p => readFileSync(join(f.store.orderPath(orderRequest.orderId), p)).toString("base64"))).toEqual(before);
  expect(() => restarted.dispatch(lease)).toThrow(); expect(() => f.store.dispatch(lease)).toThrow();
});

test("missing, replaced, partial and symlinked stores never initialize on restart", () => {
  const f = fixture();
  expect(() => new V2OrderJournal(f.root + "-missing", f.enrollment)).toThrow();
  expect(() => initializeV2OrderJournal(f.root, orderBinding)).toThrow();
  const other = f.root + "-other"; mkdirSync(other, { mode: 0o700 });
  writeFileSync(join(other, "enrollment.json"), JSON.stringify(f.enrollment), { mode: 0o600 });
  expect(() => new V2OrderJournal(other, f.enrollment)).toThrow();
  const link = f.root + "-link"; symlinkSync(f.root, link); expect(() => new V2OrderJournal(link, f.enrollment)).toThrow();
  rmSync(join(f.root, "enrollment.json")); expect(() => new V2OrderJournal(f.root, f.enrollment)).toThrow();
});

test.each(["network", "genesisHash", "programId", "merchant", "providerId", "namespace"] as const)("restart cannot silently switch the %s pin", field => {
  const f = fixture(); reserve(f.store);
  const value = field === "network" ? "solana:another-network" : field === "providerId" ? "another-provider"
    : field === "namespace" ? "another-namespace" : orderRequest.payer;
  expect(() => new V2OrderJournal(f.root, { ...f.enrollment, binding: { ...f.enrollment.binding, [field]: value } })).toThrow();
  expect(f.store.claim(orderRequest).kind).toBe("existing");
});

test("corrupt or partial order state remains UNKNOWN and cannot obtain a continuation lease", () => {
  const f = fixture(), lease = reserve(f.store);
  f.store.signed(lease, signedAttempt); f.store.dispatch(lease);
  writeFileSync(join(f.store.orderPath(orderRequest.orderId), "signed.json"), "partial");
  expect(() => f.store.assertDispatch(lease)).toThrow();
  expect(f.store.snapshot(orderRequest.orderId).status).toBe("UNKNOWN");
  expect(f.store.claim(orderRequest).kind).toBe("existing");
});

test("separate orders can be reserved without a global process lock", () => {
  const f = fixture(); reserve(f.store);
  expect(f.store.claim({ ...orderRequest, orderId: "b".repeat(64) }).kind).toBe("claimed");
});

test("eight real processes with different E and salt produce one signer and one submission", async () => {
  const f = fixture();
  const children = Array.from({ length: 8 }, (_, i) => fork(worker, [f.root, JSON.stringify(f.enrollment), "race", "", String(i)],
    { execArgv: ["--experimental-strip-types"], stdio: ["ignore", "pipe", "pipe", "ipc"] }));
  try {
    const outputs = children.map(child => { let text = ""; child.stdout!.on("data", chunk => { text += chunk; }); return () => text; });
    const done = children.map(child => once(child, "exit"));
    await Promise.all(children.map(child => once(child, "message"))); children.forEach(child => child.send("go"));
    const exits = await Promise.all(done); expect(exits.every(([code]) => code === 0)).toBe(true);
    const results = outputs.map(read => JSON.parse(read().trim()));
    expect(results.filter(r => r.kind === "winner")).toHaveLength(1);
    expect(results.filter(r => r.kind === "existing")).toHaveLength(7);
    expect(calls(f.root, "signer")).toBe(1); expect(calls(f.root, "submit")).toBe(1);
    expect(new V2OrderJournal(f.root, f.enrollment).claim({ ...orderRequest, authorizeUntilSlot: "999" }).kind).toBe("existing");
  } finally { children.forEach(child => { if (child.exitCode === null) child.kill("SIGKILL"); }); }
});

const boundaries = ["reservation-directory-before", "reservation-directory-after", "signer-before", "signer-after",
  ...["claim", "signed", "dispatch", "observation"].flatMap(stage => ["write-before", "write-after", "file-before", "file-after", "directory-before", "directory-after"].map(suffix => stage + "-" + suffix)),
  "submit-before", "submit-after"];
test.each(boundaries)("SIGKILL at %s: restart preserves UNKNOWN and cannot sign/submit again", boundary => {
  const f = fixture();
  const child = spawnSync(process.execPath, ["--experimental-strip-types", worker, f.root, JSON.stringify(f.enrollment), "kill", boundary], { encoding: "utf8", timeout: 10_000 });
  expect(child.signal, child.stderr).toBe("SIGKILL");
  const before = calls(f.root, "submit"); expect(before).toBeLessThanOrEqual(1);
  const restarted = new V2OrderJournal(f.root, f.enrollment);
  expect(restarted.snapshot(orderRequest.orderId).status).toBe("UNKNOWN");
  expect(restarted.claim({ ...orderRequest, authorizeUntilSlot: "999", salt: "e".repeat(64) }).kind).toBe("existing");
  expect(calls(f.root, "submit")).toBe(before);
  const signers = calls(f.root, "signer");
  const freshProcess = spawnSync(process.execPath, ["--experimental-strip-types", worker, f.root, JSON.stringify(f.enrollment), "restart", "", "99"],
    { encoding: "utf8", timeout: 10_000 });
  expect(freshProcess.status, freshProcess.stderr).toBe(0);
  expect(JSON.parse(freshProcess.stdout)).toMatchObject({ kind: "existing", snapshot: { status: "UNKNOWN" } });
  expect(calls(f.root, "signer")).toBe(signers); expect(calls(f.root, "submit")).toBe(before);
});
test.each(boundaries)("I/O fault at %s: original journal survives and repeat cannot submit", boundary => {
  const f = fixture();
  const child = spawnSync(process.execPath, ["--experimental-strip-types", worker, f.root, JSON.stringify(f.enrollment), "fault", boundary], { encoding: "utf8", timeout: 10_000 });
  expect(child.status, child.stderr).toBe(0);
  expect(JSON.parse(child.stdout)).toMatchObject({ fired: true, kind: "existing", snapshot: { status: "UNKNOWN" }, preserved: true });
  expect(calls(f.root, "submit")).toBeLessThanOrEqual(1);
});
