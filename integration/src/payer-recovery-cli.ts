// Explicit operator entry only. Startup never imports or executes this module.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
export async function payerRecoveryMain(argv: readonly string[] = process.argv.slice(2)): Promise<never> {
  if (!["offer", "submit", "reconcile"].includes(argv[0] ?? "")) throw new Error("usage: payer-recovery-cli.ts <offer|submit|reconcile>");
  // No flags, key loading, drafts, private-store reads, RPC or test capability can activate it.
  throw new Error("Payer recovery refused: no trusted live enrollment verifier is installed (one UID only; multi-UID unsupported).");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  payerRecoveryMain().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
}
