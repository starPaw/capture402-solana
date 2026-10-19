import { CIRCLE_PROFILE, validateCircleApproval, profileHash, selectedPaymentProfile, requireCircleRpc, requireCircleNamespace } from '../src/payment-profile.ts';
import { circleApprovalFixture } from './fixtures/operational-fixture.ts';
import { address } from '@solana/kit';
import { operationalFixture } from './fixtures/operational-fixture.ts';
import {vi,test,expect} from 'vitest';
import {validateMerchantDemoPolicy} from '../src/merchant-demo.ts';
import {E2E_MERCHANT_DEMO_POLICY} from './fixtures/operational-fixture.ts';
const policy={...E2E_MERCHANT_DEMO_POLICY,reference:'explicit-owner-e2e-demo'};
test('only the fixed bounded E2E campaign can enable public merchant delegation',()=>{
  expect(()=>validateMerchantDemoPolicy(policy)).not.toThrow();
  for(const [key,value] of Object.entries(policy)) {
    expect(()=>validateMerchantDemoPolicy({...policy,[key]:typeof value==='number'?value+1:key==='reference'?'':value+'changed'})).toThrow();
    const missing={...policy} as Record<string,unknown>;delete missing[key];
    expect(()=>validateMerchantDemoPolicy(missing)).toThrow();
  }
  for(const bad of [null,[],{},true,{...policy,enableProduction:true}])expect(()=>validateMerchantDemoPolicy(bad)).toThrow();
});

// Only the test module replaces the installation reader; production exposes no override.
vi.mock('../src/operational-data.ts',async(importOriginal)=>{
 const actual=await importOriginal<typeof import('../src/operational-data.ts')>();
 const {operationalFixture}=await import('./fixtures/operational-fixture.ts');
 return {...actual,loadOperationalData:()=>operationalFixture,
 operationalValue:(key:string)=>{const value=(operationalFixture as Record<string,unknown>)[key];if(value===undefined)throw Error('synthetic field unavailable');return value;},
 operationalRevision:(key:string)=>{const value=(operationalFixture as Record<string,unknown>)[key];if(typeof value!=='string'||!/^[a-f0-9]{40}$/.test(value))throw Error('synthetic revision unavailable');return value;}};
});

test('Circle profile requires a distinct explicit approval; legacy approval and hashes stay unchanged',()=>{
  const original=JSON.stringify(policy);
  const approval=circleApprovalFixture(address(E2E_MERCHANT_DEMO_POLICY.sponsor),address(E2E_MERCHANT_DEMO_POLICY.merchant));
  operationalFixture.circleUsdcDemoProfile=approval;
  expect(selectedPaymentProfile('circle-usdc-v1')).toBe(CIRCLE_PROFILE);
  const circlePolicy={schema:2,origin:approval.origin,network:approval.network,programId:approval.programId,sponsor:approval.sponsor,
    merchant:approval.merchant,mint:approval.mint,budget:approval.budget,maximumOrders:100,maximumRelayAttempts:600,profileHash:profileHash(approval),reference:'synthetic-circle-delegation'};
  expect(()=>validateMerchantDemoPolicy(circlePolicy,CIRCLE_PROFILE)).not.toThrow();
  expect(()=>validateMerchantDemoPolicy(policy,CIRCLE_PROFILE)).toThrow();
  expect(()=>validateMerchantDemoPolicy({...circlePolicy,profileHash:'f'.repeat(64)},CIRCLE_PROFILE)).toThrow();
  for(const change of [{mint:E2E_MERCHANT_DEMO_POLICY.mint},{budget:'100000000'},{firstCapture:'40001'},{decimals:9},{tokenSpendLimit:'50000001'},{treasury:approval.merchant},{maximumClaims:101},{genesisHash:'wrong'}])expect(()=>validateCircleApproval({...approval,...change})).toThrow();
  expect(JSON.stringify(policy)).toBe(original);
  operationalFixture.circleUsdcDemoProfile=undefined;
  expect(()=>selectedPaymentProfile('circle-usdc-v1')).toThrow();
  expect(()=>selectedPaymentProfile('unrecognized')).toThrow();
});
test('QuickNode uses approved HTTPS configuration and Circle custody cannot point at a legacy directory',()=>{
  expect(()=>requireCircleRpc('https://synthetic-devnet.quiknode.pro/REDACTED/')).not.toThrow();
  for(const endpoint of ['http://synthetic.quiknode.pro/','https://quiknode.pro.attacker.invalid/','https://api.devnet.solana.com/'])expect(()=>requireCircleRpc(endpoint)).toThrow();
  for(const path of ['/var/lib/capture402-e2e/facilitator/faucet','/var/lib/capture402-e2e/circle-usdc-v1/../faucet'])expect(()=>requireCircleNamespace(path)).toThrow();
});

test('Circle admission contracts are separately selected without replacing legacy approvals',async()=>{
  const {loadAdmissionContract}=await import('../src/admission-journal.ts');
  const root=operationalFixture as Record<string,unknown>,old=root.admissionContracts;
  const legacy={orders:{reference:'synthetic-legacy-contract',initialMaximum:11,migrations:[]}};
  const circle={orders:{reference:'synthetic-circle-orders',initialMaximum:100,migrations:[]},'relay-attempts':{reference:'synthetic-circle-relays',initialMaximum:600,migrations:[]}};
  root.admissionContracts=legacy;root.circleUsdcAdmissionContracts=circle;
  try {
    expect(loadAdmissionContract('orders')).toEqual(legacy.orders);
    expect(loadAdmissionContract('orders','circle-usdc-v1')).toEqual(circle.orders);
    expect(loadAdmissionContract('relay-attempts','circle-usdc-v1')).toEqual(circle['relay-attempts']);
    root.circleUsdcAdmissionContracts={orders:{...circle.orders,initialMaximum:101}};
    expect(()=>loadAdmissionContract('orders','circle-usdc-v1')).toThrow();
    expect(loadAdmissionContract('orders')).toEqual(legacy.orders);
  } finally {if(old===undefined)delete root.admissionContracts;else root.admissionContracts=old;delete root.circleUsdcAdmissionContracts;}
});
test('Circle faucet policy binds the approved mint, treasury, token ceiling and approval digest',async()=>{
  const {validateProfileFaucet}=await import('../src/devnet-faucet-store.ts'),{ata}=await import('../src/program.ts');
  const approval=circleApprovalFixture(address(E2E_MERCHANT_DEMO_POLICY.sponsor),address(E2E_MERCHANT_DEMO_POLICY.merchant));
  operationalFixture.circleUsdcDemoProfile=approval;
  const p={schema:2 as const,reference:'synthetic-circle-faucet',network:approval.network,genesisHash:approval.genesisHash,mint:approval.mint,sponsor:approval.sponsor,
    pool:await ata(approval.sponsor,approval.mint),origin:approval.origin,maximumClaims:100 as const,amount:'500000' as const,cooldownSeconds:86400 as const,
    profileHash:profileHash(approval),tokenSpendLimit:approval.tokenSpendLimit};
  try {
    expect(()=>validateProfileFaucet(CIRCLE_PROFILE,p)).not.toThrow();
    for(const change of [{mint:address(E2E_MERCHANT_DEMO_POLICY.mint)},{sponsor:approval.merchant},{profileHash:'a'.repeat(64)},{tokenSpendLimit:'500000'}])expect(()=>validateProfileFaucet(CIRCLE_PROFILE,{...p,...change})).toThrow();
    const reordered=Object.fromEntries(Object.entries(approval).reverse());expect(profileHash(reordered)).toBe(profileHash(approval));
  } finally {operationalFixture.circleUsdcDemoProfile=undefined;}
});
