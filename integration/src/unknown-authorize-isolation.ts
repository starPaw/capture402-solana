// A distinct, owner-scoped disposition of one expired UNKNOWN authorization.
// Excludes successful authorization effect, not execution/fees. No original is
// repaired, unlocked, retried, signed, submitted or classified as not-submitted.
import { constants, openSync, closeSync, fstatSync, readFileSync, existsSync, lstatSync, fchmodSync, fchownSync, writeFileSync, fsyncSync, type Stats } from 'node:fs';
import { join,dirname,basename } from 'node:path';
import { sha256, proveExpiredUnfundedAuthorize } from './authorize-abandon.ts';
import { reconcileRestaurantOrder } from './restaurant-reconciliation.ts';
import type { RestaurantOrders } from './restaurant.ts';
import type { RpcLedger } from './rpc-ledger.ts';
import type { ChainReader } from './reconciliation.ts';
import { isAddress, isSignature, type Address } from '@solana/kit';

import { operationalValue } from './operational-data.ts';
export type IsolationPolicy = {schema:number;sourceSha:string;order:string;payment:string;payer:string;orderSha256:string;consentSha256:string;busySha256:string;actionSha256:string;journalSha256:string;signature:string;messageHash:string;signedWireSha256:string};
export const ISOLATION_POLICY_KEYS = ['schema','sourceSha','order','payment','payer','orderSha256','consentSha256','busySha256','actionSha256','journalSha256','signature','messageHash','signedWireSha256'] as const;
export function selectedIsolationPolicy():IsolationPolicy {
  const value=operationalValue<IsolationPolicy>('authorizeIsolationPolicy');
  if(!value || Object.keys(value).sort().join()!==[...ISOLATION_POLICY_KEYS].sort().join() || value.schema!==1 || !/^[a-f0-9]{40}$/.test(value.sourceSha) || !/^[a-f0-9]{32}$/.test(value.order) || !isAddress(value.payment) || !isAddress(value.payer) || !isSignature(value.signature) || !['orderSha256','consentSha256','busySha256','actionSha256','journalSha256','messageHash','signedWireSha256'].every(k=>/^[a-f0-9]{64}$/.test(String(value[k as keyof IsolationPolicy]))))throw Error('invalid trusted isolation policy');
  return value;
}
export type InstalledIsolationPolicy=IsolationPolicy & {archiveSha256:string};
type Order=ReturnType<RestaurantOrders['read']>;
type Reader=ChainReader & Pick<RpcLedger,'getFinalizedBlockhashStatus'|'getClockAtLeast'>;
function fail():never {throw Error('Unknown authorization isolation proof/custody unavailable; originals remain stopped.');}
const policyHash=(p:IsolationPolicy)=>sha256(JSON.stringify(Object.fromEntries(Object.entries(p).sort(([a],[b])=>a<b?-1:a>b?1:0))));
export type RestaurantCustody={uid:number;gid:number};
function validateRestaurantCustody(value:RestaurantCustody) {
  if(!value || Object.keys(value).sort().join()!=='gid,uid' || ![value.uid,value.gid].every(n=>Number.isSafeInteger(n) && n>0 && n<=0xfffffffe))fail();
}
export function approvedRestaurantCustody():RestaurantCustody {
  const custody=operationalValue<RestaurantCustody>('restaurantCustody');
  validateRestaurantCustody(custody);return {...custody};
}
type DirectoryPin={device:number;inode:number;uid:number;gid:number;mode:number};
function directoryIdentity(s:Stats):DirectoryPin {
  return {device:Number(s.dev),inode:Number(s.ino),uid:Number(s.uid),gid:Number(s.gid),mode:Number(s.mode)&0o7777};
}
function ordersDirectory(path:string,custody:RestaurantCustody,expected?:DirectoryPin):DirectoryPin {
  const s=lstatSync(path),actual=directoryIdentity(s);
  if(!s.isDirectory() || s.isSymbolicLink() || actual.mode!==0o700 || actual.uid!==custody.uid || actual.gid!==custody.gid || expected && JSON.stringify(actual)!==JSON.stringify(expected))fail();
  return actual;
}
const prepared=new WeakMap<object,{path:string;policyHash:string;raw:string;deadline:number;journalPath:string;journalRaw:string;journalPin:ReturnType<typeof pin>;custody:RestaurantCustody;directoryPin:DirectoryPin}>();
function rawFile(path:string,mode=0o600) {
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const s=fstatSync(fd);
    if(!s.isFile() || s.nlink!==1 || s.size>1048576 || (s.mode&0o7777)!==mode || s.uid!==lstatSync(dirname(path)).uid || mode===0o400 && s.gid!==lstatSync(dirname(path)).gid)fail();
    return readFileSync(fd,'utf8');
  }finally{closeSync(fd);}
}
function pin(path:string) {const s=lstatSync(path);return {inode:s.ino,device:s.dev,uid:s.uid,gid:s.gid,mode:s.mode&0o777,nlink:s.nlink,size:s.size};}
function originalPins(path:string) {return {order:pin(path),consent:pin(`${path}.wallet-consent.lock`),busy:pin(`${path}.busy`),action:pin(`${path}.authorize.lock`)};}
function originals(policy:IsolationPolicy,order:Order,path:string) {
  if(policy.schema!==1 || !/^[a-f0-9]{40}$/.test(policy.sourceSha) || Object.keys(policy).sort().join()!==[...ISOLATION_POLICY_KEYS].sort().join() ||
    !['orderSha256','consentSha256','busySha256','actionSha256','journalSha256','messageHash','signedWireSha256'].every(k=>/^[a-f0-9]{64}$/.test(String(policy[k as keyof IsolationPolicy]))))fail();
  if(order.id!==policy.order || order.payment!==policy.payment || order.payer!==policy.payer || order.status!=='pending' || order.events.length!==1 ||
    order.events[0]?.action!=='authorize' || order.events[0].status!=='pending' || order.events[0].transaction!==policy.signature)fail();
  const r={order:rawFile(path),consent:rawFile(`${path}.wallet-consent.lock`),busy:rawFile(`${path}.busy`),action:rawFile(`${path}.authorize.lock`)};
  if(sha256(r.order)!==policy.orderSha256 || sha256(r.consent)!==policy.consentSha256 || sha256(r.busy)!==policy.busySha256 || sha256(r.action)!==policy.actionSha256 || r.busy!=='authorize')fail();
  const consent=JSON.parse(r.consent);
  if(Object.keys(consent).sort().join()!=='order,unsignedSha256' || consent.order!==order.id || consent.unsignedSha256!==sha256(order.unsigned))fail();
  return r;
}
/** Operator preparation only. Caller uses the pinned accepted RpcLedger and
 * complete stopped-E2E inventory. This function reads evidence and returns a
 * proposed immutable record and short-lived publication capability. It grants no
 * economic writer enrollment, signature or outcome repair authority. */
export async function prepareUnknownAuthorizeIsolation(a:{policy:IsolationPolicy;ordersDir:string;journalDirs:readonly string[];
  programId:Address;server:Address;mint:Address;funder:Address;network:string;reader:Reader;custody:RestaurantCustody}) {
  validateRestaurantCustody(a.custody);
  const custody={...a.custody},directoryPin=ordersDirectory(a.ordersDir,custody);
  const deadline=Date.now()+30_000;
  const path=join(a.ordersDir,`${a.policy.order}.json`),order=JSON.parse(rawFile(path)) as Order;
  const before=originals(a.policy,order,path),pins=originalPins(path);
  if(existsSync(`${path}.authorize-isolation.lock`) || existsSync(`${path}.authorize-successor.lock`))fail();
  const report=await reconcileRestaurantOrder({ordersDir:a.ordersDir,orderId:order.id,journalDirs:a.journalDirs,programId:a.programId,network:a.network,reader:a.reader});
  const target=report.actions[0];
  if(report.issues.length || report.actions.length!==1 || report.reclaimReservations.length || !report.busy.present || report.busy.action!=='authorize' ||
    !target || target.action!=='authorize' || target.issues.length || target.verdict!=='unknown' || target.signature!==a.policy.signature ||
    target.signatureSource!=='submission-journal' || target.messageHash!==a.policy.messageHash || target.journals.length!==1 ||
    target.journals[0]?.sha256!==a.policy.journalSha256 || target.journals[0].wireSha256!==a.policy.signedWireSha256 ||
    target.journals[0].attempts!==1 || target.journals[0].latestOutcome!=='unresolved' || report.payment.kind!=='ok' || report.payment.exists)fail();
  let journal:string|undefined,journalPin:ReturnType<typeof pin>|undefined,journalPath:string|undefined;
  for(const directory of a.journalDirs) {
    const file=join(directory,`${a.policy.signature}.json`);
    if(existsSync(file)){if(journal!==undefined)fail();journal=rawFile(file);journalPin=pin(file);journalPath=file;}
  }
  if(!journal || !journalPin || !journalPath || sha256(journal)!==a.policy.journalSha256)fail();
  const offer=order.required.accepts[0]!;
  if(offer.amount!=='100000000' || offer.asset!==a.mint || offer.payTo!==a.server || offer.extra?.feePayer!==a.funder || offer.extra.programId!==a.programId)fail();
  // The canonical unsigned representation authenticates the same message as the
  // fully signed journal above. Permanent v1 PDA absence excludes success only.
  const unsignedProof=await proveExpiredUnfundedAuthorize({order,programId:a.programId,server:a.server,mint:a.mint,funder:a.funder,network:a.network,
    maximum:100000000n,captureDeadline:BigInt(offer.extra.captureDeadline as number),refundDeadline:BigInt(offer.extra.refundDeadline as number),reader:a.reader});
  if(JSON.stringify(originals(a.policy,order,path))!==JSON.stringify(before) || JSON.stringify(originalPins(path))!==JSON.stringify(pins))fail();
  for(const directory of a.journalDirs) {const file=join(directory,`${a.policy.signature}.json`);if(existsSync(file)&&(rawFile(file)!==journal || JSON.stringify(pin(file))!==JSON.stringify(journalPin)))fail();}
  const record={schema:1,kind:'expired-no-successful-authorize-effect' as const,policySha256:policyHash(a.policy),originalOutcome:'unknown' as const,
    reserveDisposition:'retained' as const,originals:before,originalPins:pins,originalJournal:journal,originalJournalPin:journalPin,report,
    proof:{...unsignedProof,kind:'expired-no-successful-authorize-effect' as const}};
  ordersDirectory(a.ordersDir,custody,directoryPin);
  if(Date.now()>=deadline)fail();
  prepared.set(record,{path,policyHash:policyHash(a.policy),raw:JSON.stringify(record),deadline,journalPath,journalRaw:journal,journalPin,custody,directoryPin});
  return record;
}
export type IsolationRecord=Awaited<ReturnType<typeof prepareUnknownAuthorizeIsolation>>;
/** Only the separately authorized stopped-E2E operator calls this writer. */
export function persistUnknownAuthorizeIsolation(policy:IsolationPolicy,path:string,record:IsolationRecord) {
  const issued=prepared.get(record);
  if(!issued || issued.path!==path || issued.policyHash!==policyHash(policy) || issued.raw!==JSON.stringify(record) || Date.now()>=issued.deadline)fail();
  prepared.delete(record);
  ordersDirectory(dirname(path),issued.custody,issued.directoryPin);
  if(rawFile(issued.journalPath)!==issued.journalRaw || JSON.stringify(pin(issued.journalPath))!==JSON.stringify(issued.journalPin))fail();
  const order=JSON.parse(rawFile(path)) as Order;
  if(JSON.stringify(originals(policy,order,path))!==JSON.stringify(record.originals) || JSON.stringify(originalPins(path))!==JSON.stringify(record.originalPins) || record.policySha256!==policyHash(policy))fail();
  const file=`${path}.authorize-isolation.lock`,raw=JSON.stringify(record);
  // Keep one verified directory descriptor and one exclusive archive descriptor.
  // Linux anchors creation to the pinned parent even if its pathname is replaced.
  const parent=openSync(dirname(file),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  let fd:number|undefined;
  const checkParent=()=>{
    const s=fstatSync(parent);
    if(!s.isDirectory() || JSON.stringify(directoryIdentity(s))!==JSON.stringify(issued.directoryPin))fail();
    ordersDirectory(dirname(file),issued.custody,issued.directoryPin);
  };
  try {
    checkParent();
    const creationPath=process.platform==='linux'?`/proc/self/fd/${parent}/${basename(file)}`:file;
    fd=openSync(creationPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o000);
    const created=fstatSync(fd);
    const checkArchive=()=>{
      const opened=fstatSync(fd!),entry=lstatSync(file);
      if(!opened.isFile() || opened.nlink!==1 || !entry.isFile() || entry.isSymbolicLink() || opened.dev!==created.dev || opened.ino!==created.ino || entry.dev!==opened.dev || entry.ino!==opened.ino)fail();
      checkParent();return opened;
    };
    checkArchive();writeFileSync(fd,raw);fsyncSync(fd);checkArchive();
    fchownSync(fd,issued.custody.uid,issued.custody.gid);
    fchmodSync(fd,0o400);fsyncSync(fd);
    const owned=checkArchive();
    if(owned.uid!==issued.custody.uid || owned.gid!==issued.custody.gid || (owned.mode&0o7777)!==0o400 || owned.size!==Buffer.byteLength(raw))fail();
    fsyncSync(parent);checkArchive();
  } catch {
    // Never delete or reuse a partial archive. Leave it unusable and consume the
    // issued capability, retaining all original UNKNOWN journals/reservations.
    if(fd!==undefined)try{fchmodSync(fd,0o000);fsyncSync(fd);}catch{/* remains a blocking partial entry */}
    try{fsyncSync(parent);}catch{/* caller still receives no acceptance digest */}
    fail();
  } finally {if(fd!==undefined)closeSync(fd);closeSync(parent);}
  return sha256(raw);
}
export function authorizeIsolationEvidence(policy:InstalledIsolationPolicy|undefined,order:Order,path:string) {
  const file=`${path}.authorize-isolation.lock`;
  if(!existsSync(file)){if(policy?.order===order.id)fail();return undefined;}
  if(!policy || !/^[a-f0-9]{64}$/.test(policy.archiveSha256))fail();
  const {archiveSha256,...scope}=policy,raw=rawFile(file,0o400),record=JSON.parse(raw) as IsolationRecord;
  const p=record.proof,numeric=(v:unknown)=>typeof v==='string'&&/^(0|[1-9][0-9]*)$/.test(v);
  if(sha256(raw)!==archiveSha256 || record.schema!==1 || record.kind!=='expired-no-successful-authorize-effect' || record.policySha256!==policyHash(scope) ||
    record.originalOutcome!=='unknown' || record.reserveDisposition!=='retained' || JSON.stringify(record.originals)!==JSON.stringify(originals(scope,order,path)) || JSON.stringify(record.originalPins)!==JSON.stringify(originalPins(path)) ||
    sha256(record.originalJournal)!==scope.journalSha256 || p?.kind!==record.kind || p.payment!==order.payment || p.unsignedSha256!==sha256(order.unsigned) ||
    !['originSlot','expirySlot','paymentSlot','clockSlot','clockUnixTimestamp'].every(k=>numeric(p[k as keyof typeof p])) ||
    p.originSlot!==order.authorizeLifetime?.contextSlot || BigInt(p.expirySlot)<=BigInt(p.originSlot) || BigInt(p.paymentSlot)<BigInt(p.expirySlot) || BigInt(p.clockSlot)<BigInt(p.paymentSlot) ||
    BigInt(p.clockUnixTimestamp)<BigInt(order.required.accepts[0]!.extra!.refundDeadline as number))fail();
  return {kind:record.kind,originalOutcome:record.originalOutcome,originalSignature:scope.signature,reserveRetained:true,proof:p};
}
