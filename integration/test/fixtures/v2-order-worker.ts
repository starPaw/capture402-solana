// Disposable test instrumentation only. No production crash hooks or env overrides.
import { createRequire, syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { generateKeyPairSigner, getSignatureFromTransaction, getTransactionDecoder, partiallySignTransaction } from "@solana/kit";
import { V2OrderJournal, type V2OrderEnrollment } from "../../src/v2-order-journal.ts";
import { V2OrderAuthorizer } from "../../src/v2-order-authorizer.ts";
import { encodeTransaction } from "../../src/transactions.ts";
import { orderRequest } from "./v2-order-fixture.ts";
const fs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
const [root, enrollmentJson, mode, boundary, variant = "0", strace, tracePath] = process.argv.slice(2);
const enrollment: V2OrderEnrollment = JSON.parse(enrollmentJson!);
const journal = new V2OrderJournal(root!, enrollment);
const request = { ...orderRequest, salt: Number(variant).toString(16).padStart(64, "0"), authorizeUntilSlot: String(20 + Number(variant)) };
const orderPath = journal.orderPath(request.orderId);
const [payer, sponsor, funder] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner()]);
let release!: () => void;
const ready = new Promise<void>(r => { release = r; });
process.on("message", message => { if (message === "go") release(); });
if (process.send) { process.send("ready"); await ready; }
let active = mode === "kill" || mode === "fault" || mode === "native", fired = false;
const open = fs.openSync, close = fs.closeSync, write = fs.writeFileSync, sync = fs.fsyncSync;
const descriptors = new Map<number, string>();
let current = "reservation";
function hit(name: string) {
  if (!active || fired || boundary !== name) return;
  fired = true;
  if (mode === "native") { fs.writeSync(2, `NATIVE_ORDER_TARGET:${name}\n`); return; }
  if (mode === "kill") process.kill(process.pid, "SIGKILL");
  throw Error("synthetic " + name);
}
(fs as any).openSync = (...args: any[]) => { const fd = (open as any)(...args); descriptors.set(fd, String(args[0])); return fd; };
fs.closeSync = fd => { descriptors.delete(fd); close(fd); };
(fs as any).writeFileSync = (target: any, ...args: any[]) => {
  const path = typeof target === "number" ? descriptors.get(target) : String(target);
  const stage = ["claim", "signed", "dispatch", "observation"].find(s => path === join(orderPath, s + ".json"));
  if (mode === "native-write" && !fired && boundary === stage + "-write-before") {
    fired = true;
    // Inject into one write on the same inherited evidence fd. Filtering by the
    // open path avoids nondeterministic Node startup/async pipe write counts.
    const helper = "const fs=require('node:fs');try{fs.writeFileSync(3,fs.readFileSync(0));process.exitCode=2}catch(e){process.stdout.write(JSON.stringify({code:e.code}));process.exitCode=1}";
    const result = spawnSync(strace!, ["-o", tracePath!, "-yy", "-e", "trace=write", "-P", path!,
      "-e", "inject=write:error=EIO", process.execPath, "--input-type=commonjs", "-e", helper],
      { stdio: ["pipe", "pipe", "pipe", target], input: args[0], encoding: "utf8", timeout: 5000 });
    if (result.status !== 1 || JSON.parse(result.stdout).code !== "EIO") throw Error("native write did not qualify: " + result.stderr);
    throw Object.assign(Error("native original-fd write failure"), { code: "EIO" });
  }
  if (stage) { current = stage; hit(stage + "-write-before"); }
  (write as any)(target, ...args);
  if (stage) hit(stage + "-write-after");
};
fs.fsyncSync = fd => {
  const path = descriptors.get(fd), isDirectory = fs.fstatSync(fd).isDirectory();
  const stage = isDirectory ? path === journal.root ? "reservation" : path === orderPath ? current : undefined
    : ["claim", "signed", "dispatch", "observation"].find(s => path === join(orderPath, s + ".json"));
  const name = stage ? stage + (isDirectory ? "-directory" : "-file") : "other";
  hit(name + "-before"); sync(fd); hit(name + "-after");
};
syncBuiltinESMExports();
const call = (kind: string) => (write as any)(join(root!, `${kind}-${process.pid}.test`), "called", { flag: "wx", mode: 0o600 });
try {
  const service = new V2OrderAuthorizer({ journal, feePayer: sponsor.address, rentRefundRecipient: funder.address,
    sign: async wire => {
      hit("signer-before"); call("signer");
      const signed = encodeTransaction(await partiallySignTransaction([payer.keyPair, sponsor.keyPair, funder.keyPair],
        getTransactionDecoder().decode(Buffer.from(wire, "base64"))));
      hit("signer-after"); return signed;
    },
    transport: { network: enrollment.binding.network, providerId: enrollment.binding.providerId,
      getGenesisHash: async () => enrollment.binding.genesisHash,
      sendOnce: async wire => {
        hit("submit-before"); call("submit"); hit("submit-after");
        return getSignatureFromTransaction(getTransactionDecoder().decode(Buffer.from(wire, "base64")));
      }, finalizedReceipt: async () => null } });
  const result = await service.authorize({ orderId: request.orderId, payer: payer.address, mint: request.mint,
    salt: Buffer.from(request.salt, "hex"), authorizeUntilSlot: BigInt(request.authorizeUntilSlot), observedSlot: 10n,
    maximum: 100n, captureDeadline: 1100n, refundDeadline: 1200n,
    lifetime: { blockhash: request.blockhash as never, lastValidBlockHeight: 500n } });
  if (result.kind === "blocked") throw Error("synthetic blocked attempt");
  process.stdout.write(JSON.stringify({ ...result, kind: result.kind === "attempt" ? "winner" : "existing" }) + "\n");
} catch {
  active = false;
  const originalFiles = fs.readdirSync(orderPath).filter(f => f.endsWith(".json")).map(name => [name, fs.readFileSync(join(orderPath, name)).toString("base64")]);
  const restart = new V2OrderJournal(root!, enrollment);
  const repeat = restart.claim({ ...request, salt: "f".repeat(64), authorizeUntilSlot: "99" });
  const preserved = originalFiles.every(([name, bytes]) => fs.readFileSync(join(orderPath, name!)).toString("base64") === bytes);
  process.stdout.write(JSON.stringify({ fired, kind: repeat.kind, snapshot: restart.snapshot(request.orderId), preserved }) + "\n");
} finally { process.disconnect?.(); }
