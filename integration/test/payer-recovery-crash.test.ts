import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { expect, test } from "vitest";
import { RecoveryDomain } from "../src/coordination.ts";
import { reconcilePayerRecovery } from "../src/payer-recovery.ts";
import { FIXTURE_GENESIS, FIXTURE_NETWORK } from "../src/recovery-enrollment.ts";
import { LOCAL_PROGRAM_ID } from "../src/program.ts";
export const payerFaultBoundaries = ["record-write-before", "record-write-after", "record-file-before", "record-file-after", "record-directory-before", "record-directory-after", "reservation-write-before", "reservation-write-after", "reservation-file-before", "reservation-file-after", "reservation-directory-before", "reservation-directory-after", "journal-write-before", "journal-write-after", "journal-file-before", "journal-file-after", "journal-directory-before", "journal-directory-after", "backend-before", "backend-after", "response-write-before", "response-write-after", "response-file-before", "response-file-after", "response-directory-before", "response-directory-after"];
function run(kind: string, boundary: string) {
  const child = spawnSync(process.execPath, ["--experimental-strip-types", resolve("test/fixtures/payer-recovery-fault-worker.ts"), kind, boundary], { timeout: 10000, encoding: "utf8" });
  const lines = child.stdout.trim().split("\n").filter(Boolean).map(s => JSON.parse(s)); return { child, meta: lines[0], result: lines[1] };
}
function verify(meta: any) { for (const p of meta.originals) expect(readFileSync(p.path).toString("base64")).toBe(p.raw); }
test.each(payerFaultBoundaries)("SIGKILL %s: originals/reservations survive and fresh startup cannot submit", async boundary => {
  const { child, meta } = run("kill", boundary);
  try {
    expect(child.signal, child.stderr).toBe("SIGKILL"); verify(meta);
    const calls = existsSync(join(meta.root, "backend-calls")) ? Number(readFileSync(join(meta.root, "backend-calls"))) : 0;
    expect(calls).toBe(payerFaultBoundaries.indexOf(boundary) >= payerFaultBoundaries.indexOf("backend-after") ? 1 : 0);
    const domain = new RecoveryDomain(meta.paths); await domain.run("exclusive", async () => {}); // kernel releases process ownership
    await expect(reconcilePayerRecovery({ domain, identity: { network: FIXTURE_NETWORK, genesisHash: FIXTURE_GENESIS, programId: LOCAL_PROGRAM_ID }, orderId: meta.id, action: "beer", captureSignature: meta.captureSignature, reader: {} as never, reclaimSignature: meta.captureSignature })).rejects.toThrow(/enrollment verifier/);
    verify(meta);
  } finally { rmSync(meta.root, { recursive: true, force: true }); }
});
test.each(payerFaultBoundaries)("write/fsync/backend fault %s: explicit retry refuses, at most one backend call", boundary => {
  const { child, meta, result } = run("fault", boundary);
  try {
    expect(child.status, child.stderr).toBe(0); expect(result.fired).toBe(true); expect(result.repeat).toBe("refused");
    expect(result.before.originals).toBe(true); expect(result.after.originals).toBe(true); expect(result.after.submissions).toBeLessThanOrEqual(1);
    expect(result.after.submissions).toBe(result.before.submissions); verify(meta);
  } finally { rmSync(meta.root, { recursive: true, force: true }); }
});
