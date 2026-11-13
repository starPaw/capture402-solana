// Two-phase disposable VM reboot fixture. No real RPC or economic submission.
import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeV2OrderJournal, V2OrderJournal, type V2OrderEnrollment } from "../../src/v2-order-journal.ts";
import { orderBinding, orderRequest } from "./v2-order-fixture.ts";

assert.equal(process.platform, "linux");
assert.equal(process.env.CAPTURE402_E2E_DISPOSABLE, "1");
assert.equal(readFileSync("/etc/capture402-e2e-disposable", "utf8").trim(), "DISPOSABLE_SYNTHETIC_E2E_TEST_ONLY");
const [phase, state] = process.argv.slice(2);
assert(state && ["prepare", "verify"].includes(phase!));
const metadata = lstatSync(state);
assert(metadata.isDirectory() && !metadata.isSymbolicLink() && metadata.uid === process.getuid!() && (metadata.mode & 0o777) === 0o700);
const root = join(state, "orders"), pin = join(state, "external-enrollment.json"), baselinePath = join(state, "baseline.json");
const worker = fileURLToPath(new URL("./v2-order-worker.ts", import.meta.url));
const bootId = () => readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
function save(path: string, data: unknown) {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(data)); fsyncSync(fd); } finally { closeSync(fd); }
  const directory = openSync(state!, "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
function inventory() {
  return Object.fromEntries(readdirSync(root, { recursive: true }).map(String).sort().flatMap(relative => {
    const path = join(root, relative), stat = lstatSync(path);
    assert(!stat.isSymbolicLink());
    return stat.isFile() ? [[relative, createHash("sha256").update(readFileSync(path)).digest("hex")]] : [];
  }));
}
const calls = (prefix: string) => readdirSync(root).filter(name => name.startsWith(prefix + "-")).length;
if (phase === "prepare") {
  const enrollment = initializeV2OrderJournal(root, orderBinding);
  save(pin, enrollment);
  const original = spawnSync(process.execPath, ["--experimental-strip-types", worker, root, JSON.stringify(enrollment), "prepare", ""], { encoding: "utf8", timeout: 15_000 });
  assert.equal(original.status, 0, original.stderr);
  assert.equal(JSON.parse(original.stdout).kind, "winner");
  assert.equal(calls("submit"), 1);
  const journal = new V2OrderJournal(root, enrollment), snapshot = journal.snapshot(orderRequest.orderId);
  assert.equal(snapshot.status, "UNKNOWN");
  save(baselinePath, { bootId: bootId(), files: inventory(), snapshot, signed: calls("signer"), submitted: calls("submit") });
  console.log(JSON.stringify({ phase, status: snapshot.status, syntheticSubmissions: 1, durable: true }));
} else {
  const enrollment = JSON.parse(readFileSync(pin, "utf8")) as V2OrderEnrollment;
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  assert.notEqual(bootId(), baseline.bootId, "the VM must actually reboot between phases");
  assert.deepEqual(inventory(), baseline.files);
  const children = Array.from({ length: 8 }, (_, i) => fork(worker,
    [root, JSON.stringify(enrollment), "restart", "", String(30 + i)],
    { execArgv: ["--experimental-strip-types"], stdio: ["ignore", "pipe", "pipe", "ipc"] }));
  const results = children.map(async child => {
    let stdout = "", stderr = "";
    child.stdout!.on("data", bytes => { stdout += bytes; });
    child.stderr!.on("data", bytes => { stderr += bytes; });
    const [code] = await once(child, "exit");
    assert.equal(code, 0, stderr);
    assert.equal(JSON.parse(stdout).kind, "existing");
  });
  try {
    await Promise.all(children.map(child => once(child, "message")));
    children.forEach(child => child.send("go"));
    await Promise.all(results);
    const journal = new V2OrderJournal(root, enrollment);
    assert.deepEqual(journal.snapshot(orderRequest.orderId), baseline.snapshot);
    assert.deepEqual(inventory(), baseline.files);
    assert.equal(calls("signer"), baseline.signed);
    assert.equal(calls("submit"), baseline.submitted);
    console.log(JSON.stringify({ phase, rebooted: true, parallelProcesses: 8, status: "UNKNOWN", originalsUnchanged: true, newSignatures: 0, newSubmissions: 0 }));
  } finally { children.forEach(child => { if (child.exitCode === null) child.kill("SIGKILL"); }); }
}
