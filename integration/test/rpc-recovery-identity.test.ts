import { getAddressEncoder, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { expect, test } from "vitest";
import { parsedDeploymentFixture, fixtureExecutable } from "./fixtures/deployment-fixture.ts";
import { RpcLedger } from "../src/rpc-ledger.ts";

const record = parsedDeploymentFixture();
function fixture() {
  const p = new Uint8Array(36), d = new Uint8Array(45 + record.deployment.executableSize), addresses = getAddressEncoder();
  new DataView(p.buffer).setUint32(0, 2, true); p.set(addresses.encode(record.deployment.programData), 4);
  const v = new DataView(d.buffer); v.setUint32(0, 3, true); v.setBigUint64(4, record.deployment.slot, true);
  if (record.deployment.upgradeAuthority) { d[12] = 1; d.set(addresses.encode(record.deployment.upgradeAuthority), 13); }
  d.set(fixtureExecutable, 45);
  const accounts = { context: { slot: record.deployment.slot }, value: [
    { owner: record.deployment.loader, executable: true, data: [Buffer.from(p).toString("base64"), "base64"] },
    { owner: record.deployment.loader, executable: false, data: [Buffer.from(d).toString("base64"), "base64"] },
  ] };
  const calls = { genesis: 0, loader: 0 };
  const rpc = {
    getGenesisHash: () => ({ send: async () => { calls.genesis++; return record.network.genesisHash; } }),
    getMultipleAccounts: () => ({ send: async () => { calls.loader++; return accounts; } }),
  };
  const ledger = new RpcLedger({ rpc: rpc as unknown as Rpc<SolanaRpcApi>, rpcUrl: "https://fixture.invalid", deployment: record, network: record.network.caip2, genesisHash: record.network.genesisHash });
  return { p, d, accounts, calls, rpc, ledger };
}
test("reclaim identity verifies a synthetic pinned loader tuple and executable bytes", async () => {
  const f = fixture();
  await expect(f.ledger.recoveryReader(Date.now() + 1000).verifyIdentity()).resolves.toEqual({ network: record.network.caip2, genesisHash: record.network.genesisHash, programId: record.programId });
  expect(f.calls).toEqual({ genesis: 1, loader: 1 });
});
test.each(["owner", "executable", "program-data", "binary", "slot"])("changed %s deployment refuses identity", async fault => {
  const f = fixture();
  if (fault === "owner") f.accounts.value[0]!.owner = record.programId;
  if (fault === "executable") f.accounts.value[0]!.executable = false;
  if (fault === "program-data") { f.p[4] = f.p[4]! ^ 1; f.accounts.value[0]!.data[0] = Buffer.from(f.p).toString("base64"); }
  if (fault === "binary") { f.d[45] = f.d[45]! ^ 1; f.accounts.value[1]!.data[0] = Buffer.from(f.d).toString("base64"); }
  if (fault === "slot") f.accounts.context.slot = record.deployment.slot - 1n;
  await expect(f.ledger.verifyRecoveryIdentity(Date.now() + 1000)).rejects.toThrow(/deployment differs/);
});
test("identity cannot be inferred from a network label without a deployment pin", async () => {
  const ledger = new RpcLedger({ network: record.network.caip2, genesisHash: record.network.genesisHash, rpcUrl: "https://fixture.invalid" });
  await expect(ledger.verifyRecoveryIdentity(Date.now() + 1000)).rejects.toThrow(/pinned deployment/);
});
test("identity phases share the operator deadline and abort a stalled loader read", async () => {
  const f = fixture(); let aborted = false;
  f.rpc.getMultipleAccounts = () => ({ send: async ({ abortSignal }: { abortSignal: AbortSignal } = {} as never) => {
    f.calls.loader++;
    abortSignal.addEventListener("abort", () => { aborted = true; }, { once: true });
    return await new Promise<typeof f.accounts>(() => {});
  } });
  await expect(f.ledger.recoveryReader(Date.now() + 20).verifyIdentity(Date.now() + 1000)).rejects.toThrow(/deadline/);
  expect(aborted).toBe(true); expect(f.calls).toEqual({ genesis: 1, loader: 1 });
});
