// Explicit payer tool; no application startup import and no private-key loading.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getBase64Encoder, getSignatureFromTransaction, getTransactionDecoder, isAddress, isSignature, type Address } from "@solana/kit";
import { ACCEPTED_DEPLOYMENT_RECORD, loadDeploymentRecord } from "./deployment-record.ts";
import { createDurableFile } from "./durable-file.ts";
import { createReclaimOffer, reclaimOfferDigest, submitReclaimOffer, type ReclaimOffer } from "./reclaim-offer.ts";
import { strictJson } from "./quarantine-view.ts";
import { RpcLedger } from "./rpc-ledger.ts";
import { FileSubmissionJournal } from "./submission-journal.ts";

type Command = { verb: "offer"; payment: Address; payer: Address; output: string }
  | { verb: "submit"; offer: string; signed: string; digest: string }
  | { verb: "status"; signature: string };
const usage = "usage: reclaim-offer-cli.ts offer <payment> <payer> <new-offer.json> | submit <offer.json> <signed-wire.json> <reviewed-sha256> | status <original-signature>";
export function parseReclaimOfferCommand(argv: readonly string[]): Command {
  if (argv[0] === "offer" && argv.length === 4 && isAddress(argv[1] ?? "") && isAddress(argv[2] ?? "") && argv[3]) return { verb: "offer", payment: argv[1] as Address, payer: argv[2] as Address, output: argv[3] };
  if (argv[0] === "submit" && argv.length === 4 && argv[1] && argv[2] && /^[a-f0-9]{64}$/.test(argv[3] ?? "")) return { verb: "submit", offer: argv[1], signed: argv[2], digest: argv[3]! };
  if (argv[0] === "status" && argv.length === 2 && isSignature(argv[1] ?? "")) return { verb: "status", signature: argv[1]! };
  throw new Error(usage);
}
function required(name: string) {
  const value = process.env[name]; if (!value) throw new Error(`missing ${name}`); return value;
}
function journalDirectory() { return required("SAC006_RECLAIM_JOURNAL_DIR"); }
export async function reclaimOfferMain(argv = process.argv.slice(2)): Promise<void> {
  const command = parseReclaimOfferCommand(argv);
  // Submission consent is checked before any RPC or writable journal is opened.
  let offer: ReclaimOffer | undefined, wire: string | undefined;
  if (command.verb === "submit") {
    const parsed = strictJson(readFileSync(command.offer, "utf8"));
    if (JSON.stringify(parsed).length > 32768 || reclaimOfferDigest(parsed as ReclaimOffer) !== command.digest) throw new Error("reviewed reclaim offer digest mismatch");
    const signed = strictJson(readFileSync(command.signed, "utf8")) as { transactionBase64?: unknown };
    if (!signed || Object.keys(signed).join() !== "transactionBase64" || typeof signed.transactionBase64 !== "string") throw new Error("signed-wire JSON requires transactionBase64 only");
    offer = parsed as ReclaimOffer; wire = signed.transactionBase64;
    journalDirectory();
  }
  if (command.verb === "status") journalDirectory();
  const recordPath = process.env.SAC006_DEPLOYMENT_RECORD_PATH ?? ACCEPTED_DEPLOYMENT_RECORD.path;
  const record = loadDeploymentRecord(recordPath);
  if (record.network.cluster !== "devnet") throw new Error("this operator tool requires the accepted Devnet deployment");
  const ledger = new RpcLedger({ deployment: record, network: record.network.caip2, genesisHash: record.network.genesisHash, rpcUrl: required("SOLANA_RPC_URL") });
  const identity = { network: record.network.caip2, genesisHash: record.network.genesisHash, programId: record.programId };
  const deadline = Date.now() + 60_000, reader = ledger.recoveryReader(deadline);
  if (command.verb === "offer") {
    const value = await createReclaimOffer({ identity, reader, payment: command.payment, payer: command.payer, lifetime: await ledger.latestBlockhash(), timeoutMs: Math.max(1, deadline - Date.now()) });
    createDurableFile(command.output, JSON.stringify(value));
    console.log(JSON.stringify({ payment: value.payment, payer: value.payer, held: value.held, refundable: value.refundable, captureDeadline: value.captureDeadline, offerSha256: reclaimOfferDigest(value) }));
    return;
  }
  if (command.verb === "submit") {
    const result = await submitReclaimOffer({ identity, reader, offer: offer!, transactionBase64: wire!,
      consent: { accept: true, offerSha256: command.digest, payer: offer!.payer, payment: offer!.payment },
      journal: new FileSubmissionJournal(journalDirectory()), timeoutMs: Math.max(1, deadline - Date.now()), backend: ledger });
    console.log(JSON.stringify(result));
    return;
  }
  const entry = new FileSubmissionJournal(journalDirectory(), { create: false }).read(command.signature);
  if (!entry || entry.signature !== command.signature || entry.operation !== "reclaim" || getSignatureFromTransaction(getTransactionDecoder().decode(getBase64Encoder().encode(entry.transactionBase64))) !== command.signature) throw new Error("original reclaim journal is missing or inconsistent");
  await ledger.verifyRecoveryIdentity(deadline);
  const status = await reader.getSignatureStatus(command.signature);
  console.log(JSON.stringify({ signature: command.signature, status }, (_key, value) => typeof value === "bigint" ? value.toString() : value));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  reclaimOfferMain().catch(() => { console.error("Payer reclaim stopped; check command, consent, journal and pinned Devnet evidence. No automatic retry."); process.exitCode = 1; });
}
