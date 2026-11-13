// Real Linux syscall failures in the permanent order journal; synthetic signer/transport only.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { initializeV2OrderJournal, V2OrderJournal } from "../src/v2-order-journal.ts";
import { orderBinding, orderRequest } from "./fixtures/v2-order-fixture.ts";

const strace = process.env.SAC006_TEST_STRACE;
const worker = fileURLToPath(new URL("./fixtures/v2-order-worker.ts", import.meta.url));
const stages = ["claim", "signed", "dispatch", "observation"];
const boundaries = ["reservation-directory-before", ...stages.flatMap(stage =>
  [`${stage}-write-before`, `${stage}-file-before`, `${stage}-directory-before`])];

test.skipIf(process.platform !== "linux" || !strace).each(boundaries)(
  "native EIO at %s retains UNKNOWN and blocks new E/salt after process restart", boundary => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "v2-native-fault-"));
    const syscall = boundary.includes("write") ? "write" : "fsync";
    const calls = (dir: string, prefix: string) => readdirSync(dir).filter(name => name.startsWith(prefix + "-")).length;
    function run(name: string, occurrence?: number) {
      const dir = join(root, name), enrollment = initializeV2OrderJournal(dir, orderBinding);
      const tracePath = join(root, name + ".trace");
      const args = ["-o", tracePath, "-yy", "-e", "trace=fsync,write", "-s", "128"];
      if (occurrence) args.push("-e", `inject=${syscall}:error=EIO:when=${occurrence}`);
      args.push(process.execPath, "--experimental-strip-types", worker, dir, JSON.stringify(enrollment), "native", boundary);
      const child = syscall === "write"
        ? spawnSync(process.execPath, ["--experimental-strip-types", worker, dir, JSON.stringify(enrollment),
          "native-write", boundary, "0", strace!, tracePath], { encoding: "utf8", timeout: 15_000 })
        : spawnSync(strace!, args, { encoding: "utf8", timeout: 15_000 });
      expect(child.status, JSON.stringify({ stderr: child.stderr, signal: child.signal, error: child.error?.message })).toBe(0);
      return { dir, enrollment, result: JSON.parse(child.stdout), trace: readFileSync(tracePath, "utf8") };
    }
    try {
      let occurrence: number | undefined;
      if (syscall === "fsync") {
        const calibration = run("calibration");
        expect(calibration.result.kind).toBe("winner");
        const marker = calibration.trace.indexOf("NATIVE_ORDER_TARGET:" + boundary);
        expect(marker).toBeGreaterThan(0);
        occurrence = (calibration.trace.slice(0, marker).match(/^fsync\(/gm) ?? []).length + 1;
      }
      const injected = run("injected", occurrence);
      const failures = injected.trace.split("\n").filter(line => line.startsWith(syscall + "(") && line.includes("EIO") && line.includes("(INJECTED)"));
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain(injected.dir);
      expect(injected.result).toMatchObject({ fired: true, kind: "existing", snapshot: { status: "UNKNOWN" }, preserved: true });
      const submitted = calls(injected.dir, "submit"), signed = calls(injected.dir, "signer");
      expect(submitted).toBe(boundary.startsWith("observation") ? 1 : 0);
      const journal = new V2OrderJournal(injected.dir, injected.enrollment);
      const before = journal.snapshot(orderRequest.orderId);
      const child = spawnSync(process.execPath, ["--experimental-strip-types", worker, injected.dir,
        JSON.stringify(injected.enrollment), "restart", "", "99"], { encoding: "utf8", timeout: 15_000 });
      expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(child.stdout)).toMatchObject({ kind: "existing", snapshot: { status: "UNKNOWN" } });
      expect(journal.snapshot(orderRequest.orderId)).toEqual(before);
      expect(calls(injected.dir, "submit")).toBe(submitted);
      expect(calls(injected.dir, "signer")).toBe(signed);
    } finally { rmSync(root, { recursive: true, force: true }); }
  },
);
