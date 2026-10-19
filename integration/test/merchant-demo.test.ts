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
