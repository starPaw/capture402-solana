// Explicitly configured RPC only. No URL/default endpoint discovery, provider
// fallback, blockhash refresh or resend. Read polling cannot submit a transaction.
import { setTimeout as delay } from "node:timers/promises";
import { signature as asSignature, type Base64EncodedWireTransaction, type Rpc, type SolanaRpcApi } from "@solana/kit";
import type { V2FinalizedReceipt, V2OrderTransport } from "./v2-order-authorizer.ts";
import { validV2ErrorJson } from "./v2-order-evidence.ts";

export class V2OrderRpcTransport implements V2OrderTransport {
  readonly network: string;
  readonly providerId: string;
  private readonly rpc: Rpc<SolanaRpcApi>;
  private readonly requestTimeoutMs: number;
  private readonly observeTimeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(config: { network: string; providerId: string; rpc: Rpc<SolanaRpcApi>;
    requestTimeoutMs?: number; observeTimeoutMs?: number; pollIntervalMs?: number }) {
    this.network = config.network; this.providerId = config.providerId; this.rpc = config.rpc;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 10_000;
    this.observeTimeoutMs = config.observeTimeoutMs ?? 45_000;
    this.pollIntervalMs = config.pollIntervalMs ?? 500;
    for (const value of [this.requestTimeoutMs, this.observeTimeoutMs, this.pollIntervalMs]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) throw Error("invalid v2 RPC timeout");
    }
  }
  getGenesisHash(): Promise<string> {
    return this.rpc.getGenesisHash().send({ abortSignal: AbortSignal.timeout(this.requestTimeoutMs) });
  }
  async sendOnce(wire: string): Promise<string> {
    return this.rpc.sendTransaction(wire as Base64EncodedWireTransaction, {
      encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 0n,
    }).send({ abortSignal: AbortSignal.timeout(this.requestTimeoutMs) });
  }
  async finalizedReceipt(signature: string): Promise<V2FinalizedReceipt | null> {
    const deadline = Date.now() + this.observeTimeoutMs;
    const signal = () => AbortSignal.timeout(Math.max(1, Math.min(this.requestTimeoutMs, deadline - Date.now())));
    // Only reads repeat. Every exception leaves the caller's permanent reservation.
    do {
      const statuses = (await this.rpc.getSignatureStatuses([asSignature(signature)], { searchTransactionHistory: true })
        .send({ abortSignal: signal() })).value;
      if (!Array.isArray(statuses) || statuses.length !== 1) return null;
      const status = statuses[0];
      if (status?.confirmationStatus === "finalized") {
        const tx = await this.rpc.getTransaction(asSignature(signature), {
          commitment: "finalized", encoding: "base64", maxSupportedTransactionVersion: 0,
        }).send({ abortSignal: signal() });
        const errorJson = (value: unknown) => value === null ? null : JSON.stringify(value, (_key, item) => {
          if (typeof item !== "bigint") return item;
          if (item < 0n || item > BigInt(Number.MAX_SAFE_INTEGER)) throw Error("malformed v2 transaction error");
          return Number(item);
        });
        const failure = tx?.meta && errorJson(tx.meta.err);
        if (tx?.meta && tx.slot === status.slot && tx.transaction[1] === "base64"
            && failure === errorJson(status.err) && (failure === null || validV2ErrorJson(failure))) {
          return { signature, commitment: "finalized", slot: tx.slot, transactionBase64: tx.transaction[0], errorJson: failure };
        }
      }
      if (Date.now() >= deadline) break;
      await delay(Math.min(this.pollIntervalMs, deadline - Date.now()));
    } while (Date.now() < deadline);
    return null;
  }
}
