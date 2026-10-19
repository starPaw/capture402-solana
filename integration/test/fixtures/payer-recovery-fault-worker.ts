// Instrumentation belongs exclusively to this disposable child; production has no hooks.
import { spawnSync } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
const require = createRequire(import.meta.url), fs = require("node:fs") as typeof import("node:fs");
const { payerFixture } = await import("./payer-recovery-fixture.ts");
const { submitPayerRecovery, reconcilePayerRecovery } = await import("../../src/payer-recovery.ts");
const { getSignatureFromTransaction } = await import("@solana/kit");
const [kind, boundary, strace, tracePath] = process.argv.slice(2), f = await payerFixture(), req = await f.request();
const originals = Object.values(f.paths).flatMap(dir => fs.readdirSync(dir).map(name => ({ path: dir + "/" + name, raw: fs.readFileSync(dir + "/" + name).toString("base64") })));
fs.writeSync(1, JSON.stringify({ root: f.root, paths: f.paths, id: f.id, captureSignature: f.signature, originals }) + "\n");
const callsPath = f.root + "/backend-calls";
let nativeWritePath: string | undefined;
let active = true, fired = false, record = false, reservation = false, journal = false, submitted = false;
const fds = new Map<number, string>();
function hit(name: string) {
  if (!active || fired || boundary !== name) return;
  fired = true;
  if (kind === "kill") process.kill(process.pid, "SIGKILL");
  if (kind === "native-fault") { fs.writeSync(2, "NATIVE_FAULT_TARGET:" + name + "\n"); return; }
  throw new Error("injected " + name);
}
const open = fs.openSync, close = fs.closeSync, write = fs.writeFileSync, sync = fs.fsyncSync;
(fs as any).openSync = (...args: any[]) => { const fd = (open as any)(...args); fds.set(fd, String(args[0])); return fd; };
fs.closeSync = fd => { fds.delete(fd); close(fd); };
(fs as any).writeFileSync = (fd: any, ...args: any[]) => {
  const path = typeof fd === "number" ? fds.get(fd) : String(fd);
  const name = path?.endsWith(".record") ? "record-write" : path?.startsWith(f.paths.reclaim) && path.endsWith(".lock") ? "reservation-write" : path?.startsWith(f.paths.reclaim) && path.includes(".json") ? submitted ? "response-write" : "journal-write" : "other-write";
  if (active && !fired && kind === "native-write-fault" && boundary === name + "-before") {
    fired = true; nativeWritePath = path;
    // Trace a helper's one native write to the SAME inherited open evidence fd. Path
    // filtering targets only that file, avoiding nondeterministic Node startup writes.
    // strace's primary manual supports combining syscall injection and -P filtering:
    // https://github.com/strace/strace/blob/master/doc/strace.1.in
    const helper = "const fs=require('node:fs');try{fs.writeFileSync(3,fs.readFileSync(0));process.exitCode=2}catch(e){process.stdout.write(JSON.stringify({code:e.code}));process.exitCode=1}";
    const native = spawnSync(strace!, ["-o", tracePath!, "-y", "-e", "trace=write", "-P", path!, "-e", "inject=write:error=EIO", process.execPath, "--input-type=commonjs", "-e", helper], { stdio: ["pipe", "pipe", "pipe", fd], input: args[0], encoding: "utf8", timeout: 5000 });
    if (native.status !== 1 || JSON.parse(native.stdout).code !== "EIO") throw new Error("native write injection did not qualify: " + native.stderr);
    throw Object.assign(new Error("native original-fd write failure"), { code: "EIO" });
  }
  hit(name + "-before"); (write as any)(fd, ...args);
  if (name === "record-write") record = true; if (name === "reservation-write") reservation = true; if (name === "journal-write") journal = true;
  hit(name + "-after");
};
fs.fsyncSync = fd => {
  const path = fds.get(fd) ?? "", dir = fs.fstatSync(fd).isDirectory();
  const name = dir ? path === f.paths.orders && record ? "record-directory" : path === f.paths.reclaim ? submitted ? "response-directory" : journal ? "journal-directory" : reservation ? "reservation-directory" : "other-directory" : "other-directory" :
    path.endsWith(".record") ? "record-file" : path.startsWith(f.paths.reclaim) && path.endsWith(".lock") ? "reservation-file" : path.startsWith(f.paths.reclaim) && path.includes(".json") ? submitted ? "response-file" : "journal-file" : "other-file";
  hit(name + "-before"); sync(fd); hit(name + "-after");
};
f.backend.submit = async tx => {
  hit("backend-before"); f.calls.submission++;
  (write as any)(callsPath, String(f.calls.submission), { mode: 0o600 }); submitted = true;
  hit("backend-after"); return { kind: "submitted" };
};
syncBuiltinESMExports();
try {
  await submitPayerRecovery(req);
  if (kind !== "native-fault") fs.writeSync(1, JSON.stringify({ unexpectedSuccess: true }) + "\n");
  else fs.writeSync(1, JSON.stringify({ calibration: true, fired }) + "\n");
} catch (error) {
  active = false; syncBuiltinESMExports();
  const kept = () => originals.every(p => fs.readFileSync(p.path).toString("base64") === p.raw);
  const before = { originals: kept(), submissions: f.calls.submission };
  let repeat = "refused";
  try { await submitPayerRecovery(req); repeat = "unexpected-submit"; } catch { /* reservation is permanent */ }
  const reservationPath = f.paths.reclaim + `/reclaim-${f.order.payment}.lock`;
  let reconcile = "refused";
  if (fs.existsSync(reservationPath)) {
    try { reconcile = (await reconcilePayerRecovery({ ...f.options, reclaimSignature: fs.readFileSync(reservationPath, "utf8") })).kind; } catch { /* incomplete evidence stays blocked */ }
  }
  fs.writeSync(1, JSON.stringify({ fired, nativeWritePath, code: (error as NodeJS.ErrnoException).code, before, repeat, reconcile, after: { originals: kept(), submissions: f.calls.submission } }) + "\n");
}
