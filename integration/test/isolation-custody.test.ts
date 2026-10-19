// Custody-only synthetic fixtures. Proof functions are explicit mocks here;
// restaurant.test.ts separately exercises the real SBF/reconciliation proof.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { PENDING_A_ISOLATION } from './fixtures/operational-fixture.ts';
import { approvedRestaurantCustody,prepareUnknownAuthorizeIsolation,persistUnknownAuthorizeIsolation,authorizeIsolationEvidence,type RestaurantCustody } from '../src/unknown-authorize-isolation.ts';
import { reconcileRestaurantOrder } from '../src/restaurant-reconciliation.ts';
import { proveExpiredUnfundedAuthorize } from '../src/authorize-abandon.ts';
const trusted=vi.hoisted(()=>({value:undefined as unknown}));
vi.mock('node:fs',async original=>({...await original<typeof import('node:fs')>()}));
vi.mock('../src/operational-data.ts',()=>({operationalValue:(key:string)=>{if(key!=='restaurantCustody')throw Error('unexpected field');return trusted.value;}}));
vi.mock('../src/restaurant-reconciliation.ts',()=>({reconcileRestaurantOrder:vi.fn()}));
vi.mock('../src/authorize-abandon.ts',async original=>({...await original<typeof import('../src/authorize-abandon.ts')>(),proveExpiredUnfundedAuthorize:vi.fn()}));
const roots:string[]=[];
const sha=(raw:string)=>createHash('sha256').update(raw).digest('hex');
const rootLinux=process.platform==='linux' && process.geteuid?.()===0;
function fixture() {
 const base=fs.mkdtempSync(join(tmpdir(),'isolation-custody-'));roots.push(base);
 const orders=join(base,'orders'),journals=join(base,'journals');fs.mkdirSync(orders,0o700);fs.mkdirSync(journals,0o700);
 const custody:RestaurantCustody=rootLinux?{uid:12345,gid:12346}:{uid:process.getuid!(),gid:process.getgid!()};
 const path=join(orders,`${PENDING_A_ISOLATION.order}.json`),archive=`${path}.authorize-isolation.lock`;
 const order={id:PENDING_A_ISOLATION.order,payment:PENDING_A_ISOLATION.payment,payer:PENDING_A_ISOLATION.payer,status:'pending',unsigned:'synthetic unsigned bytes',authorizeLifetime:{contextSlot:'1'},events:[{action:'authorize',status:'pending',transaction:PENDING_A_ISOLATION.signature}],required:{accepts:[{amount:'100000000',asset:PENDING_A_ISOLATION.payer,payTo:PENDING_A_ISOLATION.payment,extra:{feePayer:PENDING_A_ISOLATION.payer,programId:PENDING_A_ISOLATION.payment,captureDeadline:100,refundDeadline:120}}]}};
 const records={order:JSON.stringify(order),consent:JSON.stringify({order:order.id,unsignedSha256:sha(order.unsigned)}),busy:'authorize',action:'original action',journal:'original unresolved journal'};
 for(const [name,raw] of [[path,records.order],[`${path}.wallet-consent.lock`,records.consent],[`${path}.busy`,records.busy],[`${path}.authorize.lock`,records.action],[join(journals,`${PENDING_A_ISOLATION.signature}.json`),records.journal]])fs.writeFileSync(name!,raw!,{mode:0o600});
 if(rootLinux){for(const name of fs.readdirSync(orders))fs.chownSync(join(orders,name),custody.uid,custody.gid);fs.chownSync(orders,custody.uid,custody.gid);fs.chmodSync(base,0o711);}
 const policy={...PENDING_A_ISOLATION,orderSha256:sha(records.order),consentSha256:sha(records.consent),busySha256:sha(records.busy),actionSha256:sha(records.action),journalSha256:sha(records.journal)};
 const report={issues:[],actions:[{action:'authorize',issues:[],verdict:'unknown',signature:policy.signature,signatureSource:'submission-journal',messageHash:policy.messageHash,journals:[{sha256:policy.journalSha256,wireSha256:policy.signedWireSha256,attempts:1,latestOutcome:'unresolved'}]}],reclaimReservations:[],busy:{present:true,action:'authorize'},payment:{kind:'ok',exists:false}};
 vi.mocked(reconcileRestaurantOrder).mockResolvedValue(report as never);
 vi.mocked(proveExpiredUnfundedAuthorize).mockResolvedValue({payment:order.payment,unsignedSha256:sha(order.unsigned),originSlot:'1',expirySlot:'2',paymentSlot:'3',clockSlot:'4',clockUnixTimestamp:'120'} as never);
 const args={policy,ordersDir:orders,journalDirs:[journals],programId:order.payment,server:order.payment,mint:order.payer,funder:order.payer,network:'synthetic-local-network',reader:{} as never,custody} as unknown as Parameters<typeof prepareUnknownAuthorizeIsolation>[0];
 const before=()=>Object.fromEntries([path,`${path}.wallet-consent.lock`,`${path}.busy`,`${path}.authorize.lock`,join(journals,`${policy.signature}.json`)].map(p=>[p,{raw:fs.readFileSync(p,'utf8'),ino:fs.lstatSync(p).ino,uid:fs.lstatSync(p).uid,gid:fs.lstatSync(p).gid,mode:fs.lstatSync(p).mode}]));
 return{base,orders,path,archive,custody,policy,order,args,before,prepare:()=>prepareUnknownAuthorizeIsolation(args)};
}
beforeEach(()=>{vi.clearAllMocks();trusted.value=undefined;});
afterEach(()=>{vi.restoreAllMocks();for(const dir of roots.splice(0))fs.rmSync(dir,{recursive:true,force:true});});
test.each([undefined,null,{}, {uid:0,gid:20},{uid:501,gid:0},{uid:-1,gid:20},{uid:1.5,gid:20},{uid:501,gid:Number.MAX_SAFE_INTEGER+1},{uid:4294967295,gid:20},{uid:501,gid:20,extra:true}])('trusted restaurant custody refuses invalid value %#',value=>{
 trusted.value=value;expect(approvedRestaurantCustody).toThrow();
});
test('custody uses the fixed trusted field; mutable environment cannot choose UID/GID',()=>{
 trusted.value={uid:12345,gid:12346};vi.stubEnv('RESTAURANT_UID','988');vi.stubEnv('RESTAURANT_GID','986');
 try{expect(approvedRestaurantCustody()).toEqual(trusted.value);}finally{vi.unstubAllEnvs();}
});
test('issued writer preserves actual parent custody and immutable originals; reader accepts archive',async()=>{
 const f=fixture(),originals=f.before(),record=await f.prepare();
 const digest=persistUnknownAuthorizeIsolation(f.policy,f.path,record),s=fs.lstatSync(f.archive);
 expect({uid:s.uid,gid:s.gid,mode:s.mode&0o777,nlink:s.nlink}).toEqual({...f.custody,mode:0o400,nlink:1});
 expect(sha(fs.readFileSync(f.archive,'utf8'))).toBe(digest);
 expect(authorizeIsolationEvidence({...f.policy,archiveSha256:digest},f.order as never,f.path)).toMatchObject({originalOutcome:'unknown',reserveRetained:true});
 expect(f.before()).toEqual(originals);expect(()=>persistUnknownAuthorizeIsolation(f.policy,f.path,record)).toThrow();
});
test.each(['owner','group','mode','symlink'] as const)('unapproved parent %s refuses before proof or persistence',async fault=>{
 const f=fixture(),originals=f.before();
 if(fault==='owner')f.args.custody={...f.custody,uid:f.custody.uid+1};
 if(fault==='group')f.args.custody={...f.custody,gid:f.custody.gid+1};
 if(fault==='mode')fs.chmodSync(f.orders,0o755);
 if(fault==='symlink'){fs.renameSync(f.orders,`${f.orders}.original`);fs.symlinkSync(`${f.orders}.original`,f.orders);}
 await expect(f.prepare()).rejects.toThrow();expect(reconcileRestaurantOrder).not.toHaveBeenCalled();expect(fs.existsSync(f.archive)).toBe(false);expect(f.before()).toEqual(originals);
});
function replaceDirectory(f:ReturnType<typeof fixture>) {
 const retained=`${f.orders}.retained`;fs.renameSync(f.orders,retained);fs.mkdirSync(f.orders,0o700);
 for(const name of fs.readdirSync(retained))fs.copyFileSync(join(retained,name),join(f.orders,name));
 if(rootLinux){for(const name of fs.readdirSync(f.orders))fs.chownSync(join(f.orders,name),f.custody.uid,f.custody.gid);fs.chownSync(f.orders,f.custody.uid,f.custody.gid);}
 return retained;
}
test('parent inode swap during async proof consumes no originals and issues no writer capability',async()=>{
 const f=fixture(),proof=await vi.mocked(proveExpiredUnfundedAuthorize).getMockImplementation()!({} as never);
 vi.mocked(proveExpiredUnfundedAuthorize).mockImplementation(async()=>{replaceDirectory(f);return proof;});
 await expect(f.prepare()).rejects.toThrow();expect(fs.existsSync(f.archive)).toBe(false);
});
test.each(['inode','mode','owner','group'] as const)('parent %s drift after proof refuses before archive creation',async fault=>{
 const f=fixture(),record=await f.prepare();
 if(fault==='inode')replaceDirectory(f);
 if(fault==='mode')fs.chmodSync(f.orders,0o755);
 if(fault==='owner' || fault==='group') {
  const real=fs.lstatSync;
  vi.spyOn(fs,'lstatSync').mockImplementation(((p:any,...rest:any[])=>{
   const stat=(real as any)(p,...rest);
   return p===f.orders?Object.assign(Object.create(Object.getPrototypeOf(stat)),stat,{[fault==='owner'?'uid':'gid']:f.custody[fault==='owner'?'uid':'gid']+1}):stat;
  }) as typeof fs.lstatSync);
 }
 expect(()=>persistUnknownAuthorizeIsolation(f.policy,f.path,record)).toThrow();expect(fs.existsSync(f.archive)).toBe(false);
});
test('mutating the caller custody object cannot change the issued parent binding',async()=>{
 const f=fixture(),record=await f.prepare(),expected={...f.custody};f.args.custody.gid++;
 persistUnknownAuthorizeIsolation(f.policy,f.path,record);const archive=fs.statSync(f.archive);expect({uid:archive.uid,gid:archive.gid}).toEqual(expected);
});
test('setgid parent is not the exact approved private directory mode',async()=>{
 const f=fixture();fs.chmodSync(f.orders,0o2700);
 // Some macOS filesystems strip setgid; still exercise the exact metadata check.
 if((fs.lstatSync(f.orders).mode&0o2000)===0) {
  const real=fs.lstatSync;vi.spyOn(fs,'lstatSync').mockImplementation(((p:any,...rest:any[])=>{const stat=(real as any)(p,...rest);return p===f.orders?Object.assign(Object.create(Object.getPrototypeOf(stat)),stat,{mode:stat.mode|0o2000}):stat;}) as typeof fs.lstatSync);
 }
 await expect(f.prepare()).rejects.toThrow();expect(fs.existsSync(f.archive)).toBe(false);
});
test('existing symlink archive is never followed or overwritten',async()=>{
 const f=fixture(),originals=f.before(),record=await f.prepare(),target=join(f.base,'untouched');fs.writeFileSync(target,'untouched',{mode:0o600});fs.symlinkSync(target,f.archive);
 expect(()=>persistUnknownAuthorizeIsolation(f.policy,f.path,record)).toThrow();expect(fs.readFileSync(target,'utf8')).toBe('untouched');expect(fs.lstatSync(f.archive).isSymbolicLink()).toBe(true);expect(f.before()).toEqual(originals);
});
test.each(['write','chown','chmod','sync'] as const)('partial %s failure leaves an unusable blocking archive and consumes capability',async fault=>{
 const f=fixture(),originals=f.before(),record=await f.prepare();
 const target=({write:'writeFileSync',chown:'fchownSync',chmod:'fchmodSync',sync:'fsyncSync'} as const)[fault];
 const real=fs[target] as (...args:any[])=>unknown;let once=true;
 const spy=vi.spyOn(fs as unknown as Record<string,(...args:any[])=>unknown>,target).mockImplementation(((...args:any[])=>{if(once){once=false;throw Error('synthetic custody failure');}return real(...args);}));
 expect(()=>persistUnknownAuthorizeIsolation(f.policy,f.path,record)).toThrow();spy.mockRestore();
 expect(fs.existsSync(f.archive)).toBe(true);expect(fs.lstatSync(f.archive).mode&0o777).toBe(0);
 expect(()=>persistUnknownAuthorizeIsolation(f.policy,f.path,record)).toThrow();
 expect(()=>authorizeIsolationEvidence({...f.policy,archiveSha256:'a'.repeat(64)},f.order as never,f.path)).toThrow();expect(f.before()).toEqual(originals);
});
test.each(['create','write'] as const)('directory replacement during archive %s fails closed on the issued descriptor',async stage=>{
 const f=fixture(),record=await f.prepare(),originals=f.before(),retained=`${f.orders}.retained`;
 const swap=()=>{fs.renameSync(f.orders,retained);fs.mkdirSync(f.orders,0o700);if(rootLinux)fs.chownSync(f.orders,f.custody.uid,f.custody.gid);};
 let once=true;
 if(stage==='create') {
  const real=fs.openSync;vi.spyOn(fs,'openSync').mockImplementation(((...args:any[])=>{const fd=(real as any)(...args);if(once && String(args[0]).endsWith('.authorize-isolation.lock')){once=false;swap();}return fd;}) as typeof fs.openSync);
 } else {
  const real=fs.writeFileSync;vi.spyOn(fs,'writeFileSync').mockImplementation(((...args:any[])=>{const result=(real as any)(...args);if(once && typeof args[0]==='number'){once=false;swap();}return result;}) as typeof fs.writeFileSync);
 }
 expect(()=>persistUnknownAuthorizeIsolation(f.policy,f.path,record)).toThrow();
 expect(fs.existsSync(f.archive)).toBe(false);expect(fs.lstatSync(join(retained,`${f.policy.order}.json.authorize-isolation.lock`)).mode&0o777).toBe(0);
 for(const [path,state] of Object.entries(originals)){const actual=path.startsWith(f.orders)?path.replace(f.orders,retained):path;expect(fs.readFileSync(actual,'utf8')).toBe(state.raw);expect(fs.lstatSync(actual).ino).toBe(state.ino);}
});
test.skipIf(!rootLinux)('ROOT_LINUX: actual non-default UID/GID owns and can read the immutable archive',async()=>{
 const f=fixture(),record=await f.prepare(),digest=persistUnknownAuthorizeIsolation(f.policy,f.path,record);
 expect(f.custody).toEqual({uid:12345,gid:12346});
 const script="const fs=require('node:fs'),crypto=require('node:crypto');process.setgroups([]);process.setgid(12346);process.setuid(12345);const p=process.argv[1],raw=fs.readFileSync(p);process.stdout.write(JSON.stringify({uid:process.getuid(),gid:process.getgid(),sha256:crypto.createHash('sha256').update(raw).digest('hex')}));";
 const child=spawnSync(process.execPath,['-e',script,f.archive],{encoding:'utf8',timeout:5000});
 expect(child.status,child.stderr).toBe(0);expect(JSON.parse(child.stdout)).toEqual({uid:12345,gid:12346,sha256:digest});
});
