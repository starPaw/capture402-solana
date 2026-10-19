// Installation binds each mutable store to its original directory across restarts.
// Environment selection and a matching namespace alone cannot grant fresh custody.
import { lstatSync } from 'node:fs';
import { operationalValue } from './operational-data.ts';
import { circleApproval, profileHash, requireCircleNamespace } from './payment-profile.ts';

export const CIRCLE_STORE_ROLES = ['submissions','relayAdmission','campaignBudget','faucet','resource','orders','reclaims','orderAdmission'] as const;
export type CircleStoreRole = typeof CIRCLE_STORE_ROLES[number];
export type CircleCustody = {schema:1;profileHash:string;stores:Record<CircleStoreRole,{path:string;device:string;inode:string}>};
const prefix='/var/lib/capture402-e2e/circle-usdc-v1/';
const fail=():never=>{throw Error('Circle custody differs from trusted installation; preserve original stores and UNKNOWN records');};

export function circleCustodyGuard(paths:Partial<Record<CircleStoreRole,string>>):()=>void {
  const p=operationalValue<CircleCustody>('circleUsdcCustody');
  if(!p || Object.keys(p).sort().join()!=='profileHash,schema,stores' || p.schema!==1 || p.profileHash!==profileHash(circleApproval()) ||
    !p.stores || Object.keys(p.stores).sort().join()!==[...CIRCLE_STORE_ROLES].sort().join())fail();
  const seenPaths=new Set<string>(),seenIdentities=new Set<string>();
  for(const role of CIRCLE_STORE_ROLES) {
    const s=p.stores[role];
    if(!s || Object.keys(s).sort().join()!=='device,inode,path' || typeof s.path!=='string' || !s.path.startsWith(prefix) ||
      s.path.split('/').some(v=>v==='.'||v==='..') || s.path.includes('//') || s.path.endsWith('/') ||
      typeof s.device!=='string' || !/^(0|[1-9][0-9]*)$/.test(s.device) || typeof s.inode!=='string' || !/^[1-9][0-9]*$/.test(s.inode) ||
      seenPaths.has(s.path) || seenIdentities.has(`${s.device}:${s.inode}`))fail();
    // Nested roles would allow one store's records to become another's input.
    if([...seenPaths].some(path=>path.startsWith(s.path+'/') || s.path.startsWith(path+'/')))fail();
    seenPaths.add(s.path);seenIdentities.add(`${s.device}:${s.inode}`);
  }
  if(p.stores.campaignBudget.path!==prefix+'facilitator/campaign-budget' || p.stores.faucet.path!==prefix+'facilitator/faucet' ||
    p.stores.orders.path!==p.stores.resource.path+'-restaurant')fail();
  // Copy approved identities; callers cannot mutate the returned guard's bindings.
  const selected=Object.entries(paths).map(([role,path])=>{
    if(!CIRCLE_STORE_ROLES.includes(role as CircleStoreRole) || path!==p.stores[role as CircleStoreRole]?.path)fail();
    return {...p.stores[role as CircleStoreRole]};
  });
  if(!selected.length)fail();
  const guard=()=>{
    for(const s of selected) {
      requireCircleNamespace(s.path);
      const actual=lstatSync(s.path,{bigint:true});
      if(!actual.isDirectory() || actual.isSymbolicLink() || (actual.mode&0o777n)!==0o700n ||
        actual.uid!==BigInt(process.getuid!()) || actual.dev.toString()!==s.device || actual.ino.toString()!==s.inode)fail();
    }
  };
  guard();return guard;
}
