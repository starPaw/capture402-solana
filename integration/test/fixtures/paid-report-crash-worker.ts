// Local-only hard crash after capture25's original receipt is durable, before its proof.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerHooks } from "node:module";
import { getCompiledTransactionMessageDecoder } from "@solana/kit";
import { getTokenDecoder } from "@solana-program/token";
import { OperationStore } from "../../src/operation-store.ts";
import { prepareReport, submitReport } from "../../src/paid-report-client.ts";
import { createPaidReportApp } from "../../src/paid-report.ts";
import type { FinalizedTransactionEvidence, TokenObservation } from "../../src/paid-report-proof.ts";
import { TOKEN_PROGRAM_ADDRESS } from "../../src/program.ts";
import { encodeTransaction } from "../../src/transactions.ts";

// The existing test harness has TS parameter properties and source .js specifiers.
// The child uses Node's transform-types flag; resolve only its relative TS imports.
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (specifier.startsWith(".") && specifier.endsWith(".js") && (error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") {
      return nextResolve(specifier.slice(0, -3) + ".ts", context);
    }
    throw error;
  }
} });
const { createHarness } = await import("../fixture.ts");

const dir = process.argv[2]!;
const h = await createHarness();
const originals = new Map<string, FinalizedTransactionEvidence>();
const originalSubmit = h.ledger.submit.bind(h.ledger);
h.ledger.submit = async tx => {
  const accounts = getCompiledTransactionMessageDecoder().decode(tx.messageBytes).staticAccounts;
  const balances = (): TokenObservation[] => accounts.flatMap((address, accountIndex) => {
    const account = h.svm.getAccount(address);
    if (!account.exists || account.programAddress !== TOKEN_PROGRAM_ADDRESS || account.data.length !== getTokenDecoder().fixedSize) return [];
    const token = getTokenDecoder().decode(account.data);
    return [{ accountIndex, mint: token.mint, owner: token.owner, amount: token.amount.toString() }];
  });
  const before = balances(); const result = await originalSubmit(tx);
  originals.set(h.ledger.submissions.at(-1)!.signature, { kind: "ok", slot: BigInt(h.ledger.submissions.length),
    transactionBase64: encodeTransaction(tx), accounts, before, after: balances() });
  return result;
};
const origin = "http://crash-report.test";
const config = { origin, store: new OperationStore(dir), network: h.ledger.network, programId: h.facilitator.programId,
  feePayer: h.facilitatorKey.address, server: h.server, asset: h.mint, amount: 100n,
  captureDeadlineSeconds: 120, refundDeadlineSeconds: 600, facilitatorUrl: h.url, bearerToken: "local-only",
  getLatestBlockhash: async () => h.lifetime(), now: () => h.svm.getClock().unixTimestamp,
  handler: async () => { throw new Error("unused"); },
  proofReader: {
    getSignatureStatus: async (signature: string) => {
      const evidence = originals.get(signature);
      if (evidence?.kind !== "ok") return { kind: "not-found" as const };
      return { kind: "found" as const, slot: evidence.slot, commitment: "finalized" as const, err: null };
    },
    getFinalizedTransaction: async (signature: string) => {
      if (h.ledger.submissions.length === 3) process.exit(73);
      return originals.get(signature) ?? { kind: "unavailable" as const };
    },
    getAccountAtLeast: async (address: Parameters<typeof h.ledger.getAccount>[0], slot: bigint) =>
      ({ kind: "ok" as const, slot, account: await h.ledger.getAccount(address) }),
  },
};
const app = createPaidReportApp(config);
const localFetch: typeof fetch = async (input, init) => app.request(String(input), init);
const quote = await prepareReport({ origin, payer: h.payer.address, request: { region: "eu" },
  idempotencyKey: "hard_crash_report_1234", fetchImpl: localFetch });
// Private test sidecar, excluded from OperationStore's *.json record enumeration.
writeFileSync(join(dir, "crash-prepared"), JSON.stringify(quote), { mode: 0o600 });
await submitReport(quote, { payer: h.payer, policy: { network: h.ledger.network, programId: config.programId,
  feePayer: config.feePayer, payTo: h.server.address, asset: h.mint, maxAmount: 100n, maxCaptureWindowSeconds: 300 },
  now: async () => h.svm.getClock().unixTimestamp, fetchImpl: localFetch });
throw new Error("hard crash checkpoint was not reached");
