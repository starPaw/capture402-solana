// Actual syscall EIO injection on the Linux CI filesystem tuple, not physical power loss.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
const strace = process.env.SAC006_TEST_STRACE;
test.skipIf(process.platform !== "linux" || !strace).each(["record-file-before", "record-directory-before", "reservation-file-before", "reservation-directory-before", "journal-file-before", "journal-directory-before", "response-file-before", "response-directory-before"])("Linux native fsync EIO %s: no second submission", boundary => {
  const traces = mkdtempSync(join(realpathSync(tmpdir()), "payer-native-fault-")), roots: string[] = [];
  function run(injection?: number) {
    const tracePath = join(traces, injection ? "injected.trace" : "calibration.trace"), args = ["-o", tracePath, "-e", "trace=fsync,write", "-s", "128"];
    if (injection) args.push("-e", `inject=fsync:error=EIO:when=${injection}`);
    args.push(process.execPath, "--experimental-strip-types", resolve("test/fixtures/payer-recovery-fault-worker.ts"), "native-fault", boundary);
    const child = spawnSync(strace!, args, { timeout: 10000, encoding: "utf8" });
    const lines = child.stdout.trim().split("\n").filter(Boolean).map(s => JSON.parse(s)); if (lines[0]?.root) roots.push(lines[0].root);
    expect(child.status, child.stderr).toBe(0); expect(lines).toHaveLength(2); return { result: lines[1], trace: readFileSync(tracePath, "utf8") };
  }
  try {
    const calibration = run(); expect(calibration.result).toMatchObject({ calibration: true, fired: true });
    const marker = calibration.trace.indexOf("NATIVE_FAULT_TARGET:" + boundary); expect(marker).toBeGreaterThan(0);
    const occurrence = (calibration.trace.slice(0, marker).match(/^fsync\(/gm) ?? []).length + 1, injected = run(occurrence);
    const errors = injected.trace.split("\n").filter(s => s.startsWith("fsync(") && s.includes("EIO") && s.includes("(INJECTED)")); expect(errors).toHaveLength(1);
    expect(injected.result).toMatchObject({ fired: true, code: "EIO", repeat: "refused", before: { originals: true }, after: { originals: true } });
    expect(injected.result.after.submissions).toBe(injected.result.before.submissions); expect(injected.result.after.submissions).toBe(boundary.startsWith("response") ? 1 : 0);
    console.log(JSON.stringify({ boundary, occurrence, syscall: errors[0], result: injected.result }));
  } finally { for (const root of roots) rmSync(root, { recursive: true, force: true }); rmSync(traces, { recursive: true, force: true }); }
});
test.skipIf(process.platform !== "linux" || !strace).each(["record-write-before", "reservation-write-before", "journal-write-before", "response-write-before"])("Linux native write EIO %s: partial state remains blocked, no second submission", boundary => {
  const traces = mkdtempSync(join(realpathSync(tmpdir()), "payer-native-write-")); let root: string | undefined;
  try {
    const tracePath = join(traces, "write.trace");
    const child = spawnSync(process.execPath, ["--experimental-strip-types", resolve("test/fixtures/payer-recovery-fault-worker.ts"), "native-write-fault", boundary, strace!, tracePath], { timeout: 10000, encoding: "utf8" });
    const lines = child.stdout.trim().split("\n").filter(Boolean).map(s => JSON.parse(s)); root = lines[0]?.root;
    expect(child.status, child.stderr).toBe(0); expect(lines).toHaveLength(2);
    const result = lines[1], trace = readFileSync(tracePath, "utf8"), errors = trace.split("\n").filter(s => s.startsWith("write(3<") && s.includes("EIO") && s.includes("(INJECTED)"));
    expect(errors).toHaveLength(1); expect(errors[0]).toContain(result.nativeWritePath);
    expect(result).toMatchObject({ fired: true, code: "EIO", repeat: "refused", before: { originals: true }, after: { originals: true } });
    expect(result.after.submissions).toBe(result.before.submissions); expect(result.after.submissions).toBe(boundary.startsWith("response") ? 1 : 0);
    console.log(JSON.stringify({ boundary, syscall: errors[0], result }));
  } finally { if (root) rmSync(root, { recursive: true, force: true }); rmSync(traces, { recursive: true, force: true }); }
});
