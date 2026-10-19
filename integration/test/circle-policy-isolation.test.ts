import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { address } from '@solana/kit';
import { CIRCLE_STORE_ROLES, circleCustodyGuard, type CircleCustody } from '../src/circle-custody.ts';
import { CIRCLE_PROFILE, LEGACY_PROFILE, profileHash, requireProfileForTreasury } from '../src/payment-profile.ts';
import { AdmissionJournal, type AdmissionPolicy } from '../src/admission-journal.ts';
import { createRestaurantApp, RestaurantOrders, type RestaurantConfig } from '../src/restaurant.ts';
import { circleApprovalFixture, E2E_MERCHANT_DEMO_POLICY } from './fixtures/operational-fixture.ts';

const fixture=vi.hoisted(()=>({root:'' as string,data:{} as Record<string,unknown>,unavailable:false}));
const prefix='/var/lib/capture402-e2e/circle-usdc-v1/';
// Model the production mount with real private temporary directories; no /var/lib writes.
vi.mock('node:fs',async original=>{
  const fs=await original<typeof import('node:fs')>();
  const physical=(path:unknown)=>typeof path==='string' && path.startsWith('/var/lib/capture402-e2e/circle-usdc-v1/')
    ?join(fixture.root,path.slice('/var/lib/capture402-e2e/circle-usdc-v1/'.length)):path;
  return {...fs,lstatSync:(path:unknown,options:unknown)=>Reflect.apply(fs.lstatSync,fs,[physical(path),options]),
    realpathSync:(path:unknown)=>{
      const actual=fs.realpathSync(physical(path) as string);
      return physical(path)!==path && actual.startsWith(fixture.root+'/')?'/var/lib/capture402-e2e/circle-usdc-v1/'+actual.slice(fixture.root.length+1):actual;
    }};
});
vi.mock('../src/operational-data.ts',async original=>({...await original<typeof import('../src/operational-data.ts')>(),
  loadOperationalData:()=>{if(fixture.unavailable)throw Error('unsafe trusted policy');return fixture.data;},
  operationalValue:(key:string)=>{if(fixture.unavailable || fixture.data[key]===undefined)throw Error('missing trusted policy');return fixture.data[key];},
}));

const treasury=address(E2E_MERCHANT_DEMO_POLICY.sponsor),merchant=address(E2E_MERCHANT_DEMO_POLICY.merchant);
const approval=circleApprovalFixture(treasury,merchant);
const physical=(path:string)=>join(fixture.root,path.slice(prefix.length));
let custody:CircleCustody;
beforeEach(()=>{
  fixture.root=realpathSync(mkdtempSync(join(tmpdir(),'circle-custody-')));
  fixture.unavailable=false;
  const locations={submissions:'facilitator/submissions',relayAdmission:'facilitator/relay-admission',campaignBudget:'facilitator/campaign-budget',
    faucet:'facilitator/faucet',resource:'restaurant/resource',orders:'restaurant/resource-restaurant',reclaims:'restaurant/reclaims',orderAdmission:'restaurant/order-admission'};
  const stores={} as CircleCustody['stores'];
  for(const role of CIRCLE_STORE_ROLES) {
    const path=prefix+locations[role];mkdirSync(physical(path),{recursive:true,mode:0o700});
    const s=lstatSync(path,{bigint:true});stores[role]={path,device:s.dev.toString(),inode:s.ino.toString()};
  }
  custody={schema:1,profileHash:profileHash(approval),stores};
  fixture.data={circleUsdcDemoProfile:approval,circleUsdcCustody:custody};
});
afterEach(()=>{rmSync(fixture.root,{recursive:true,force:true});fixture.data={};});

test.each([LEGACY_PROFILE,{...LEGACY_PROFILE}])('approved Circle treasury cannot downgrade through legacy selection or renamed keys (%j)',profile=>{
  expect(()=>requireProfileForTreasury(profile,treasury)).toThrow('requires the Circle');
  expect(()=>requireProfileForTreasury(CIRCLE_PROFILE,treasury)).not.toThrow();
  expect(()=>requireProfileForTreasury(LEGACY_PROFILE,merchant)).not.toThrow();
});
test('legacy installation works without Circle approval; malformed/unavailable authority refuses',()=>{
  delete fixture.data.circleUsdcDemoProfile;
  expect(()=>requireProfileForTreasury(LEGACY_PROFILE,treasury)).not.toThrow();
  for(const value of [null,{}, {...approval,treasury:merchant}]) {
    fixture.data.circleUsdcDemoProfile=value;expect(()=>requireProfileForTreasury(LEGACY_PROFILE,treasury)).toThrow();
  }
  fixture.unavailable=true;expect(()=>requireProfileForTreasury(LEGACY_PROFILE,merchant)).toThrow();
});
test('all approved roles open with the original profile hash and filesystem identities',()=>{
  const paths=Object.fromEntries(CIRCLE_STORE_ROLES.map(role=>[role,custody.stores[role].path]));
  const guard=circleCustodyGuard(paths);expect(guard).not.toThrow();
  fixture.data.circleUsdcCustody={...custody,profileHash:'0'.repeat(64)};
  expect(()=>circleCustodyGuard(paths)).toThrow();
});
test.each(CIRCLE_STORE_ROLES)('fresh sibling %s cannot replace approved custody across restart',role=>{
  const original=custody.stores[role].path,replacement=original+'-fresh';mkdirSync(physical(replacement),{mode:0o700});
  expect(()=>circleCustodyGuard({[role]:replacement})).toThrow();
  expect(()=>circleCustodyGuard({[role]:original})).not.toThrow();
});
test.each(CIRCLE_STORE_ROLES)('replacement at the same %s pathname is rejected at startup and by an existing guard',role=>{
  const path=custody.stores[role].path,guard=circleCustodyGuard({[role]:path});
  renameSync(physical(path),physical(path)+'-retained');mkdirSync(physical(path),{mode:0o700});
  expect(guard).toThrow();expect(()=>circleCustodyGuard({[role]:path})).toThrow();
});
test('aliases, wrong modes, incomplete manifests and crossed role bindings refuse',()=>{
  const path=custody.stores.orders.path;
  renameSync(physical(path),physical(path)+'-retained');symlinkSync(physical(path)+'-retained',physical(path));
  expect(()=>circleCustodyGuard({orders:path})).toThrow();
  rmSync(physical(path));renameSync(physical(path)+'-retained',physical(path));chmodSync(physical(path),0o755);
  expect(()=>circleCustodyGuard({orders:path})).toThrow();chmodSync(physical(path),0o700);
  expect(()=>circleCustodyGuard({orders:custody.stores.resource.path})).toThrow();
  fixture.data.circleUsdcCustody={...custody,stores:{...custody.stores,resource:custody.stores.orders}};
  expect(()=>circleCustodyGuard({orders:path})).toThrow();
  fixture.data.circleUsdcCustody={...custody,stores:{orders:custody.stores.orders}};
  expect(()=>circleCustodyGuard({orders:path})).toThrow();
  delete fixture.data.circleUsdcCustody;expect(()=>circleCustodyGuard({orders:path})).toThrow();
});
test.each([['relayAdmission','relay-attempts',600],['orderAdmission','orders',100]] as const)('exhausted %s cannot be reopened through a fresh sibling; original count is retained',(role,kind,maximum)=>{
  const path=custody.stores[role].path,contract={reference:'synthetic-circle-'+kind,initialMaximum:maximum,migrations:[]};
  const policy:AdmissionPolicy={schema:1,kind,reference:contract.reference,maximum,carryForward:maximum,historicalActual:maximum,sourceSha256:'a'.repeat(64)};
  AdmissionJournal.initialize(physical(path),policy);
  circleCustodyGuard({[role]:path})();
  const original=new AdmissionJournal(physical(path),kind,maximum,contract);
  expect(()=>original.reserve()).toThrow('cap reached');
  const before=readFileSync(join(physical(path),'state.json'),'utf8');
  const replacement=path+'-fresh';mkdirSync(physical(replacement),{mode:0o700});
  AdmissionJournal.initialize(physical(replacement),{...policy,carryForward:0,historicalActual:0});
  expect(()=>circleCustodyGuard({[role]:replacement})).toThrow();
  expect(readFileSync(join(physical(path),'state.json'),'utf8')).toBe(before);expect(original.summary().used).toBe(maximum);
});
test('original UNKNOWN still blocks orders after rejected substitution, with all bytes and locks retained',async()=>{
  const path=custody.stores.orders.path,orders=new RestaurantOrders(physical(path)),id='a'.repeat(32);
  orders.create({id,capabilityHash:'b'.repeat(64),payer:treasury,payment:treasury,scenario:'normal',required:{accepts:[{amount:approval.budget,asset:approval.mint}]},
    unsigned:'SYNTHETIC_NEVER_SIGNED',createdAt:1000,status:'draft',events:[]} as unknown as Parameters<RestaurantOrders['create']>[0]);
  orders.reserve(id,'authorize');
  const retained=Object.fromEntries(readdirSync(physical(path)).map(name=>[name,readFileSync(join(physical(path),name),'utf8')]));
  const config={paymentProfile:CIRCLE_PROFILE,network:approval.network,programId:approval.programId,asset:approval.mint,feePayer:treasury,server:{address:merchant},origin:approval.origin,
    amount:100000n,merchantToken:'synthetic-merchant-token-0123456789',bearerToken:'synthetic-bearer-token-0123456789',publicMerchantDemo:true,
    verifyEconomicIdentity:async()=>{},reclaimJournal:{},orders,faucet:{request:async()=>new Response('{"blocked":false}')},
    ledger:{getAccount:async()=>{throw Error('no RPC allowed');}}} as unknown as RestaurantConfig;
  const request=()=>new Request(approval.origin+'/api/orders',{method:'POST',headers:{Origin:approval.origin,'Content-Type':'application/json'},body:'{}'});
  const app=createRestaurantApp(config);
  circleCustodyGuard({orders:path})();
  const before=await app.fetch(request());expect(before.status).toBe(409);expect(await before.text()).toContain('pending or unknown');
  const replacement=path+'-empty';mkdirSync(physical(replacement),{mode:0o700});
  expect(()=>circleCustodyGuard({orders:replacement})).toThrow();
  circleCustodyGuard({orders:path})();
  const after=await app.fetch(request());expect(after.status).toBe(409);expect(await after.text()).toContain('pending or unknown');
  expect(orders.busy(id)).toBe(true);
  expect(readdirSync(physical(path)).sort()).toEqual(Object.keys(retained).sort());
  for(const [name,bytes] of Object.entries(retained))expect(readFileSync(join(physical(path),name),'utf8')).toBe(bytes);
});
