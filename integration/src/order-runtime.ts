// Open the same externally pinned order store on every service/operator restart.
// This function never enrolls, creates, replaces or clears a journal.
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { relative, isAbsolute, sep } from "node:path";
import type { Address } from "@solana/kit";
import type { DeploymentRecord } from "./deployment-record.ts";
import { V2OrderJournal, type V2OrderEnrollment } from "./v2-order-journal.ts";

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw Error(`missing required ${name}; preserve order journals`);
  return value;
}
export const orderProviderId = (endpoint: string) => `rpc-${createHash("sha256").update(endpoint).digest("hex")}`;

export function runtimeOrderConfig(record: Pick<DeploymentRecord, "programId" | "network">, merchant: Address,
  orderKey?: string, env: NodeJS.ProcessEnv = process.env) {
  const root = realpathSync(required(env, "SAC006_V2_ORDER_JOURNAL_DIR"));
  const pin = realpathSync(required(env, "SAC006_V2_ORDER_ENROLLMENT_PATH"));
  const within = relative(root, pin);
  if (!within || (within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within))) {
    throw Error("order enrollment pin must be outside the journal");
  }
  const bytes = readFileSync(pin);
  if (createHash("sha256").update(bytes).digest("hex") !== required(env, "SAC006_V2_ORDER_ENROLLMENT_SHA256")) {
    throw Error("order enrollment pin changed; preserve UNKNOWN");
  }
  const enrollment = JSON.parse(bytes.toString("utf8")) as V2OrderEnrollment;
  const b = enrollment.binding;
  if (b.network !== record.network.caip2 || b.genesisHash !== record.network.genesisHash || b.programId !== record.programId
      || b.merchant !== merchant || b.providerId !== orderProviderId(required(env, "SOLANA_RPC_URL"))) {
    throw Error("order journal runtime identity changed; preserve UNKNOWN");
  }
  return { orderJournal: new V2OrderJournal(root, enrollment), orderKey: orderKey ?? required(env, "SAC006_BEARER_TOKEN") };
}
