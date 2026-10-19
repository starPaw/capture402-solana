// Exercise the real entry points; no sockets, RPC, keys or operational files are opened.
import { afterEach, expect, test, vi } from 'vitest';
import { circleApprovalFixture, E2E_MERCHANT_DEMO_POLICY } from './fixtures/operational-fixture.ts';
import { address } from '@solana/kit';
import { CIRCLE_MINT, CIRCLE_PROFILE, DEVNET_GENESIS, DEVNET_NETWORK, DEVNET_PROGRAM, LEGACY_PROFILE } from '../src/payment-profile.ts';
import { startFacilitator } from '../src/devnet-server.ts';
import { startRestaurant } from '../src/restaurant-server.ts';

const state=vi.hoisted(()=>({data:{} as Record<string,unknown>,treasury:'',serve:vi.fn(),rpc:vi.fn(),custody:vi.fn()}));
vi.mock('../src/operational-data.ts',async original=>({...await original<typeof import('../src/operational-data.ts')>(),
  loadOperationalData:()=>state.data,operationalValue:(key:string)=>{if(state.data[key]===undefined)throw Error('synthetic policy missing');return state.data[key];}}));
vi.mock('node:fs',async original=>({...await original<typeof import('node:fs')>(),
  existsSync:(path:string)=>{if(path==='/synthetic/renamed-treasury.json' || path==='/synthetic/merchant.json')return true;throw Error('unexpected filesystem probe');},
  readFileSync:(path:string)=>{if(path==='/synthetic/renamed-treasury.json')return JSON.stringify(Array(64).fill(0));throw Error('unexpected file read');}}));
vi.mock('@solana/kit',async original=>({...await original<typeof import('@solana/kit')>(),createKeyPairSignerFromBytes:async()=>({address:state.treasury})}));
vi.mock('@hono/node-server',()=>({serve:state.serve}));
vi.mock('../src/deployment-record.ts',()=>({ACCEPTED_DEPLOYMENT_RECORD:{},loadDeploymentRecord:()=>({programId:DEVNET_PROGRAM,network:{caip2:DEVNET_NETWORK,genesisHash:DEVNET_GENESIS}})}));
vi.mock('../src/rpc-ledger.ts',async original=>({...await original<typeof import('../src/rpc-ledger.ts')>(),RpcLedger:class {constructor(){state.rpc();throw Error('RPC construction must not be reached');}}}));
vi.mock('../src/e2e-runtime-policy.ts',async original=>({...await original<typeof import('../src/e2e-runtime-policy.ts')>(),requireE2eRuntimeRpc:()=>{}}));
vi.mock('../src/circle-custody.ts',()=>({circleCustodyGuard:(paths:unknown)=>{state.custody(paths);throw Error('synthetic custody mismatch');}}));

function configure(selection:string|undefined) {
  const treasury=address(E2E_MERCHANT_DEMO_POLICY.sponsor),merchant=address(E2E_MERCHANT_DEMO_POLICY.merchant);
  state.treasury=treasury;state.data={circleUsdcDemoProfile:circleApprovalFixture(treasury,merchant)};
  const env={SOLANA_RPC_URL:'https://synthetic.quiknode.pro/fixture/',SAC006_DEPLOYMENT_RECORD_PATH:'/synthetic/deployment.json',
    SAC006_FACILITATOR_KEYPAIR_PATH:'/synthetic/renamed-treasury.json',SAC006_SERVER_KEYPAIR_PATH:'/synthetic/merchant.json',
    SAC006_ALLOWLIST_MINT:CIRCLE_MINT,SAC006_ALLOWLIST_MERCHANT:merchant,SAC006_FEE_PAYER:treasury,SAC006_ASSET_MINT:CIRCLE_MINT,
    SAC006_BEARER_TOKEN:'synthetic-test-bearer',SAC006_FACILITATOR_URL:'http://synthetic.invalid/',SAC006_STORE_DIR:'/var/lib/capture402-e2e/circle-usdc-v1/resource-empty',
    SAC006_FACILITATOR_JOURNAL_DIR:'/var/lib/capture402-e2e/circle-usdc-v1/submissions-empty',SAC006_E2E_RELAY_ADMISSION_DIR:'/var/lib/capture402-e2e/circle-usdc-v1/relay-empty',
    SAC006_RECLAIM_JOURNAL_DIR:'/var/lib/capture402-e2e/circle-usdc-v1/reclaims-empty',SAC006_E2E_ORDER_ADMISSION_DIR:'/var/lib/capture402-e2e/circle-usdc-v1/orders-empty'};
  for(const [key,value] of Object.entries(env))vi.stubEnv(key,value);
  vi.stubEnv('SAC006_PAYMENT_PROFILE',selection);
}
afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks();});
test.each([undefined,LEGACY_PROFILE.id])('both entry points reject Circle treasury in profile %s before RPC, journals or serving',async selection=>{
  configure(selection);
  await expect(startFacilitator()).rejects.toThrow('requires the Circle');
  await expect(startRestaurant()).rejects.toThrow('requires the Circle');
  expect(state.rpc).not.toHaveBeenCalled();expect(state.serve).not.toHaveBeenCalled();expect(state.custody).not.toHaveBeenCalled();
});
test('both Circle entry points check selected stores before constructing RPC or opening journals',async()=>{
  configure(CIRCLE_PROFILE.id);
  await expect(startFacilitator()).rejects.toThrow('synthetic custody mismatch');
  expect(state.custody).toHaveBeenCalledWith(expect.objectContaining({submissions:process.env.SAC006_FACILITATOR_JOURNAL_DIR,relayAdmission:process.env.SAC006_E2E_RELAY_ADMISSION_DIR}));
  await expect(startRestaurant()).rejects.toThrow('synthetic custody mismatch');
  expect(state.custody).toHaveBeenCalledWith(expect.objectContaining({resource:process.env.SAC006_STORE_DIR,orders:process.env.SAC006_STORE_DIR+'-restaurant',reclaims:process.env.SAC006_RECLAIM_JOURNAL_DIR,orderAdmission:process.env.SAC006_E2E_ORDER_ADMISSION_DIR}));
  expect(state.rpc).not.toHaveBeenCalled();expect(state.serve).not.toHaveBeenCalled();
});
