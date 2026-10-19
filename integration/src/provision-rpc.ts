// Configured-provider adapter shared by runtime and provisioning tools.
// Importing this module performs no network, key loading or provisioning action.
import { createSolanaRpc, getBase64Decoder, getBase64Encoder, isSignature, type Signature } from '@solana/kit';
import type { DeploymentRecord } from './deployment-record.ts';
import { RpcLedger } from './rpc-ledger.ts';
import type { ProvisionBackend } from '../operators/e2e-provisioning.ts';

export function rpcBackend(record: DeploymentRecord, endpoint = process.env.SOLANA_RPC_URL): ProvisionBackend {
  if (!endpoint?.trim()) throw Error('configured SOLANA_RPC_URL or explicit RPC endpoint is required');
  const rpc = createSolanaRpc(endpoint);
  const ledger = new RpcLedger({ deployment: record, network: record.network.caip2, genesisHash: record.network.genesisHash, rpcUrl: endpoint, confirmTimeoutMs: 90_000 });
  // Every quote, account and finality read belongs to this verified network/program.
  // Operator calls use the configured provider; application runtime supplies its approved endpoint.
  let verified: Promise<void> | undefined;
  const ready = () => verified ??= ledger.verifyGenesis();
  const sendOptions = () => ({ abortSignal: AbortSignal.timeout(15_000) });
  return {
    async genesis() { return await rpc.getGenesisHash().send(sendOptions()); },
    async snapshot(addresses, minSlot = 0n) {
      await ready();
      const result = await rpc.getMultipleAccounts(addresses, { encoding: 'base64', commitment: 'finalized', minContextSlot: minSlot }).send(sendOptions());
      if (typeof result.context.slot !== 'bigint' || result.context.slot < minSlot || result.value.length !== addresses.length) throw Error('finalized snapshot mismatch');
      return { slot: result.context.slot, accounts: result.value.map(a => a ? { owner: a.owner, lamports: a.lamports, executable: a.executable, data: new Uint8Array(getBase64Encoder().encode(a.data[0])) } : null) };
    },
    async rent(size) { await ready(); return await rpc.getMinimumBalanceForRentExemption(BigInt(size), { commitment: 'finalized' }).send(sendOptions()); },
    async latest() { await ready(); return (await rpc.getLatestBlockhash({commitment:'finalized'}).send(sendOptions())).value; },
    async fee(transaction) {
      await ready();
      const message = getBase64Decoder().decode(transaction.messageBytes);
      const result = await rpc.getFeeForMessage(message as Parameters<typeof rpc.getFeeForMessage>[0], { commitment: 'finalized' }).send(sendOptions());
      if (result.value === null) throw Error('fee quote unavailable');
      return result.value;
    },
    async submit(tx) { await ready(); return await ledger.submit(tx); },
    async finalized(signature) {
      await ready();
      if (!isSignature(signature)) throw Error('invalid original signature');
      const result = await rpc.getTransaction(signature as Signature, { commitment: 'finalized', encoding: 'base64', maxSupportedTransactionVersion: 0 }).send(sendOptions());
      if (!result || !result.meta) return null;
      if (typeof result.slot !== 'bigint' || result.slot < 0n || !Array.isArray(result.transaction) || result.transaction[1] !== 'base64' || !('err' in result.meta)) throw Error('malformed finalized transaction response');
      return { slot: result.slot, wire: result.transaction[0], error: result.meta.err, fee: result.meta.fee, preBalances: [...result.meta.preBalances], postBalances: [...result.meta.postBalances] };
    },
  };
}
