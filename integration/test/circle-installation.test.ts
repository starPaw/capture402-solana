// Independent installations retain their own authority, custody and durable quotas.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { address } from '@solana/kit';
import { circleApprovalFixture, E2E_MERCHANT_DEMO_POLICY } from './fixtures/operational-fixture.ts';
import { CIRCLE_PROFILE, LEGACY_PROFILE, circleApproval, circleInstallation, circleNamespacePrefix, profileHash, requireCircleNamespace, requireProfileForTreasury, selectedPaymentProfile, validateProfileRuntime } from '../src/payment-profile.ts';
import { CIRCLE_STORE_ROLES, circleCustodyGuard, type CircleCustody } from '../src/circle-custody.ts';
import { AdmissionJournal, loadAdmissionContract } from '../src/admission-journal.ts';

const state=vi.hoisted(()=>({root:'',data:{} as Record<string,unknown>}));
const roots={e2e:'/var/lib/capture402-e2e/circle-usdc-v1/',main:'/var/lib/capture402/circle-usdc-v1/'};
vi.mock('node:fs',async original=>{
  const fs=await original<typeof import('node:fs')>();
  const physical=(path:unknown)=>{
    if(typeof path!=='string')return path;
    for(const [name,prefix] of Object.entries(roots))if(path.startsWith(prefix))return join(state.root,name,path.slice(prefix.length));
    return path;
  };
  return {...fs,lstatSync:(path:unknown,options:unknown)=>Reflect.apply(fs.lstatSync,fs,[physical(path),options]),
    realpathSync:(path:unknown)=>{
      const actual=fs.realpathSync(physical(path) as string);
      for(const [name,prefix] of Object.entries(roots))if(actual.startsWith(state.root+'/'+name+'/'))return prefix+actual.slice((state.root+'/'+name+'/').length);
      return actual;
    }};
});
vi.mock('../src/operational-data.ts',async original=>({...await original<typeof import('../src/operational-data.ts')>(),
  loadOperationalData:()=>state.data,operationalValue:(key:string)=>{if(state.data[key]===undefined)throw Error('missing trusted policy');return state.data[key];}}));
const e2e=circleApprovalFixture(address(E2E_MERCHANT_DEMO_POLICY.sponsor),address(E2E_MERCHANT_DEMO_POLICY.merchant),'https://e2e.example.invalid');
const main=circleApprovalFixture(address('2Z8oHviEbrqDD5kg2sW8h8kYceqdVTnrrPL6Lk2nBfRG'),address(E2E_MERCHANT_DEMO_POLICY.mint),'https://main.example.invalid');
const key=(installation:'main'|'e2e',suffix:string)=>`circleUsdc${installation==='main'?'Main':''}${suffix}`;
const physical=(installation:'main'|'e2e',path:string)=>join(state.root,installation,path.slice(roots[installation].length));
beforeEach(()=>{
  state.root=realpathSync(mkdtempSync(join(tmpdir(),'circle-installations-')));
  state.data={circleUsdcDemoProfile:e2e,circleUsdcMainDemoProfile:main};
  for(const installation of ['e2e','main'] as const) {
    const locations={submissions:'facilitator/submissions',relayAdmission:'facilitator/relay-admission',campaignBudget:'facilitator/campaign-budget',faucet:'facilitator/faucet',
      resource:'restaurant/resource',orders:'restaurant/resource-restaurant',reclaims:'restaurant/reclaims',orderAdmission:'restaurant/order-admission'};
    const stores={} as CircleCustody['stores'];
    for(const role of CIRCLE_STORE_ROLES) {
      const path=roots[installation]+locations[role];mkdirSync(physical(installation,path),{recursive:true,mode:0o700});
      const s=lstatSync(path,{bigint:true});stores[role]={path,device:String(s.dev),inode:String(s.ino)};
    }
    state.data[key(installation,'Custody')]={schema:1,profileHash:profileHash(installation==='main'?main:e2e),stores};
    state.data[key(installation,'AdmissionContracts')]={orders:{reference:installation+'-orders',initialMaximum:100,migrations:[]},
      'relay-attempts':{reference:installation+'-relay',initialMaximum:600,migrations:[]}};
  }
});
afterEach(()=>{vi.unstubAllEnvs();rmSync(state.root,{recursive:true,force:true});});

test('unset selector preserves original E2E approval bytes, hash and namespace with main installed',()=>{
  expect(circleInstallation()).toBe('e2e');expect(circleApproval()).toEqual(e2e);expect(profileHash(circleApproval())).toBe(profileHash(e2e));
  expect(circleNamespacePrefix()).toBe(roots.e2e);expect(selectedPaymentProfile(CIRCLE_PROFILE.id)).toBe(CIRCLE_PROFILE);
  vi.stubEnv('SAC006_CIRCLE_INSTALLATION','main');expect(circleApproval()).toEqual(main);expect(circleNamespacePrefix()).toBe(roots.main);
  delete state.data.circleUsdcDemoProfile;expect(circleApproval()).toEqual(main);
});
test.each(['','MAIN','../main','legacy','main/'])('unknown installation %j cannot choose authority or fresh custody',selection=>{
  vi.stubEnv('SAC006_CIRCLE_INSTALLATION',selection);expect(()=>circleApproval()).toThrow();expect(()=>circleNamespacePrefix()).toThrow();
});
test('missing or malformed selected main approval never falls back to E2E',()=>{
  vi.stubEnv('SAC006_CIRCLE_INSTALLATION','main');delete state.data.circleUsdcMainDemoProfile;
  expect(()=>circleApproval()).toThrow('missing approved');expect(()=>selectedPaymentProfile(CIRCLE_PROFILE.id)).toThrow();
  state.data.circleUsdcMainDemoProfile={...main,tokenSpendLimit:'50000001'};expect(()=>circleApproval()).toThrow();
});
test.each(['treasury','merchant','origin'] as const)('installations reject shared %s identities before opening custody',field=>{
  state.data.circleUsdcMainDemoProfile={...main,[field]:e2e[field],...(field==='treasury'?{sponsor:e2e.treasury}:{})};
  expect(()=>circleApproval()).toThrow('distinct origins and custody keys');
  vi.stubEnv('SAC006_CIRCLE_INSTALLATION','main');expect(()=>circleApproval()).toThrow();
});
test.each(['e2e','main'] as const)('%s treasury cannot downgrade or cross installation even when its key is renamed',installation=>{
  const approval=installation==='main'?main:e2e;
  for(const selection of [undefined,'e2e','main']) {
    vi.stubEnv('SAC006_CIRCLE_INSTALLATION',selection);
    expect(()=>requireProfileForTreasury(LEGACY_PROFILE,approval.treasury)).toThrow('requires the Circle');
    if((selection??'e2e')===installation)expect(()=>requireProfileForTreasury(CIRCLE_PROFILE,approval.treasury)).not.toThrow();
    else expect(()=>requireProfileForTreasury(CIRCLE_PROFILE,approval.treasury)).toThrow('different installation');
  }
});
test.each(['e2e','main'] as const)('%s runtime refuses the other origin, sponsor and merchant',installation=>{
  vi.stubEnv('SAC006_CIRCLE_INSTALLATION',installation);const p=installation==='main'?main:e2e,other=installation==='main'?e2e:main;
  const runtime={network:p.network,programId:p.programId,asset:p.mint,feePayer:p.treasury,server:{address:p.merchant},origin:p.origin};
  expect(()=>validateProfileRuntime(CIRCLE_PROFILE,runtime)).not.toThrow();
  for(const changes of [{origin:other.origin},{feePayer:other.treasury},{server:{address:other.merchant}}])expect(()=>validateProfileRuntime(CIRCLE_PROFILE,{...runtime,...changes})).toThrow('identity mismatch');
});
test.each(CIRCLE_STORE_ROLES)('crossed %s path or entire manifest cannot substitute the other campaign',role=>{
  const a=state.data.circleUsdcCustody as CircleCustody,b=state.data.circleUsdcMainCustody as CircleCustody;
  const e2eGuard=circleCustodyGuard({[role]:a.stores[role].path});expect(e2eGuard).not.toThrow();
  expect(()=>circleCustodyGuard({[role]:b.stores[role].path})).toThrow();
  vi.stubEnv('SAC006_CIRCLE_INSTALLATION','main');expect(()=>circleCustodyGuard({[role]:b.stores[role].path})).not.toThrow();
  expect(e2eGuard).toThrow();expect(()=>requireCircleNamespace(a.stores[role].path)).toThrow();
  state.data.circleUsdcMainCustody={...a,profileHash:profileHash(main)};
  expect(()=>circleCustodyGuard({[role]:a.stores[role].path})).toThrow();
});
test.each(['orders','relay-attempts'] as const)('exhausted E2E %s remains unchanged while main consumes its own quota',kind=>{
  const role=kind==='orders'?'orderAdmission':'relayAdmission',maximum=kind==='orders'?100:600;
  const journals={} as Record<'e2e'|'main',AdmissionJournal>;let e2eDirectory='';
  for(const installation of ['e2e','main'] as const) {
    vi.stubEnv('SAC006_CIRCLE_INSTALLATION',installation);
    const c=loadAdmissionContract(kind,CIRCLE_PROFILE.id),custody=state.data[key(installation,'Custody')] as CircleCustody;
    const dir=physical(installation,custody.stores[role].path),used=installation==='e2e'?maximum:0;
    AdmissionJournal.initialize(dir,{schema:1,kind,reference:c.reference,maximum,carryForward:used,historicalActual:used,sourceSha256:'a'.repeat(64)});
    journals[installation]=new AdmissionJournal(dir,kind,maximum,c);if(installation==='e2e')e2eDirectory=dir;
  }
  const original=readFileSync(join(e2eDirectory,'state.json'),'utf8');
  expect(()=>journals.e2e.reserve()).toThrow('cap reached');journals.main.reserve();
  expect(journals.main.summary().used).toBe(1);expect(journals.e2e.summary().used).toBe(maximum);
  expect(readFileSync(join(e2eDirectory,'state.json'),'utf8')).toBe(original);
  delete state.data.circleUsdcMainAdmissionContracts;expect(()=>loadAdmissionContract(kind,CIRCLE_PROFILE.id)).toThrow();
});
