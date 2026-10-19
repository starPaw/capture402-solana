// Local invariant: admission consumed before signing survives concurrency, crash and restart.
// Separate from money, onchain authority and original operation journals. No automatic init.
import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createDurableFile, replaceDurableFile, ensureDurableDirectory } from './durable-file.ts';

import { operationalValue } from './operational-data.ts';
import { circleOperationalValue } from './payment-profile.ts';
type Migration={step:'expired-order'|'demo-runs';archive:string;reason:string;oldMaximum:number;oldUsed:number;carryForward:number;newMaximum:number};
export type AdmissionContract={reference:string;initialMaximum:number;migrations:Migration[]};
export function loadAdmissionContract(kind:AdmissionPolicy['kind'],profile?:'circle-usdc-v1'):AdmissionContract {
  const contracts=profile==='circle-usdc-v1'?circleOperationalValue<Partial<Record<AdmissionPolicy['kind'],AdmissionContract>>>('AdmissionContracts'):
    operationalValue<Partial<Record<AdmissionPolicy['kind'],AdmissionContract>>>('admissionContracts');
  const contract=contracts?.[kind];
  if(!contract)throw Error('missing trusted admission contract');
  if(profile && (contract.initialMaximum!==(kind==='orders'?100:600) || !Array.isArray(contract.migrations) || contract.migrations.length!==0))throw Error('Circle campaign requires separately approved fresh admission contracts');
  return contract;
}
function validateContract(c:AdmissionContract) {
  if(!c || Object.keys(c).sort().join()!=='initialMaximum,migrations,reference' || typeof c.reference!=='string' || !c.reference.trim() || !Number.isSafeInteger(c.initialMaximum) || c.initialMaximum<0 || !Array.isArray(c.migrations))throw Error('invalid trusted admission contract');
  let previous=c.initialMaximum,used=0;const archives=new Set<string>(),steps=new Set<string>();
  for(const m of c.migrations) {
    if(!m || Object.keys(m).sort().join()!=='archive,carryForward,newMaximum,oldMaximum,oldUsed,reason,step' || !['expired-order','demo-runs'].includes(m.step) || !/^[a-zA-Z0-9.-]+\.lock$/.test(m.archive) || m.archive.includes('..') || archives.has(m.archive) || steps.has(m.step) || typeof m.reason!=='string' || !m.reason.trim() || ![m.oldMaximum,m.oldUsed,m.carryForward,m.newMaximum].every(Number.isSafeInteger) || m.carryForward<0 || m.oldUsed<m.carryForward || m.oldUsed<used || m.oldUsed>m.oldMaximum || m.newMaximum<=m.oldMaximum || m.oldMaximum!==previous)throw Error('invalid trusted admission migrations');
    archives.add(m.archive);steps.add(m.step);previous=m.newMaximum;used=m.oldUsed;
  }
}
export type AdmissionPolicy = { schema: 1; kind: 'orders' | 'relay-attempts'; reference: string;
  maximum: number; carryForward: number; historicalActual: number | null; sourceSha256: string };
const encode = (value: unknown) => JSON.stringify(value, null, 2);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function validate(p: AdmissionPolicy) {
  if (p.schema !== 1 || !['orders','relay-attempts'].includes(p.kind) || !p.reference?.trim() ||
    !Number.isSafeInteger(p.maximum) || !Number.isSafeInteger(p.carryForward) || p.carryForward < 0 ||
    p.maximum < p.carryForward || p.historicalActual !== null && (!Number.isSafeInteger(p.historicalActual) ||
    p.historicalActual < 0 || p.historicalActual > p.carryForward) || !/^[a-f0-9]{64}$/.test(p.sourceSha256)) throw Error('invalid admission policy');
}
export class AdmissionJournal {
  readonly policy: AdmissionPolicy;
  private readonly contract: AdmissionContract;
  private readonly directory: string;
  private readonly directoryIdentity: string;
  private readonly lockIdentity: string;
  private readonly owner: number;
  private readonly flock = (createRequire(import.meta.url)('fs-ext') as typeof import('fs-ext')).flockSync;
  static initialize(directory: string, policy: AdmissionPolicy) {
    validate(policy);
    const s = lstatSync(directory);
    if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o777) !== 0o700) throw Error('pre-created private admission directory required');
    if (['policy.json','state.json','.lock'].some(name=>existsSync(join(directory,name)))) throw Error('existing/partial admission: never initialize again');
    ensureDurableDirectory(directory);
    // Partial initialization blocks reinitialization, including a crash before the lock write.
    createDurableFile(join(directory,'policy.json'), encode(policy));
    createDurableFile(join(directory,'state.json'), encode({schema:1,policyHash:hash(encode(policy)),used:policy.carryForward}));
    createDurableFile(join(directory,'.lock'), 'ADMISSION_LOCK_V1\n');
  }
  constructor(directory: string, kind: AdmissionPolicy['kind'], maximum: number, contract: AdmissionContract) {
    validateContract(contract);
    this.contract=JSON.parse(encode(contract));
    this.directory = directory;
    const s = lstatSync(directory);
    if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o777) !== 0o700) throw Error('unsafe admission directory');
    this.owner = s.uid; this.directoryIdentity = `${s.dev}:${s.ino}`;
    const lock = this.file('.lock'); this.lockIdentity = `${lock.dev}:${lock.ino}`;
    this.policy = Object.freeze(JSON.parse(readFileSync(join(directory,'policy.json'),'utf8')) as AdmissionPolicy);
    validate(this.policy);
    if (this.policy.kind !== kind || this.policy.maximum !== maximum || this.policy.reference !== this.contract.reference) throw Error('admission runtime/policy mismatch');
    this.withLock(() => this.state());
  }
  private file(name: string) {
    const s = lstatSync(join(this.directory,name));
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.uid !== this.owner || (s.mode & 0o777) !== 0o600) throw Error('unsafe admission record');
    return s;
  }
  private withLock<T>(fn: () => T): T {
    const d = lstatSync(this.directory), s = this.file('.lock');
    if (!d.isDirectory() || d.isSymbolicLink() || (d.mode & 0o777) !== 0o700 || d.uid !== this.owner || `${d.dev}:${d.ino}` !== this.directoryIdentity || `${s.dev}:${s.ino}` !== this.lockIdentity) throw Error('admission custody drift');
    const fd = openSync(join(this.directory,'.lock'), constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      if (`${opened.dev}:${opened.ino}` !== this.lockIdentity) throw Error('admission lock race');
      this.flock(fd,'exnb');
      try { return fn(); } finally { this.flock(fd,'un'); }
    } finally { closeSync(fd); }
  }
  private state(): {schema:1;policyHash:string;used:number} {
    this.file('policy.json'); this.file('state.json');
    if (readFileSync(join(this.directory,'policy.json'),'utf8') !== encode(this.policy)) throw Error('admission policy drift');
    const s = JSON.parse(readFileSync(join(this.directory,'state.json'),'utf8'));
    if (Object.keys(s).sort().join() !== 'policyHash,schema,used' || s.schema !== 1 || s.policyHash !== hash(encode(this.policy)) ||
      !Number.isSafeInteger(s.used) || s.used < this.policy.carryForward || s.used > this.policy.maximum) throw Error('admission state mismatch');
    const archives=readdirSync(this.directory).filter(n=>n!=='.lock' && n.endsWith('.lock'));
    const steps=this.contract.migrations,stage=[this.contract.initialMaximum,...steps.map(m=>m.newMaximum)].indexOf(this.policy.maximum);
    if(stage<0)throw Error('unrecognized admission migration cap');
    const required=steps.slice(0,stage);
    if(archives.some(name=>!required.some(m=>m.archive===name)))throw Error('unknown or partial admission migration archive');
    let previous:AdmissionPolicy|undefined;
    for(const m of required) {
      if(!existsSync(join(this.directory,m.archive)))throw Error('missing admission extension remains blocked');
      this.file(m.archive);const a=JSON.parse(readFileSync(join(this.directory,m.archive),'utf8'));
      validate(a.oldPolicy);validate(a.newPolicy);
      if(Object.keys(a).sort().join()!=='newPolicy,newState,oldPolicy,oldState,reason,schema' || a.schema!==1 || a.reason!==m.reason || a.oldPolicy.kind!==this.policy.kind || a.oldPolicy.reference!==this.contract.reference || a.oldPolicy.maximum!==m.oldMaximum || a.oldPolicy.carryForward!==m.carryForward ||
        previous && encode(a.oldPolicy)!==encode(previous) || !a.oldState || Object.keys(a.oldState).sort().join()!=='policyHash,schema,used' || a.oldState.schema!==1 || a.oldState.used!==m.oldUsed || a.oldState.policyHash!==hash(encode(a.oldPolicy)) ||
        encode(a.newPolicy)!==encode({...a.oldPolicy,maximum:m.newMaximum}) || !a.newState || Object.keys(a.newState).sort().join()!=='policyHash,schema,used' || a.newState.schema!==1 || a.newState.used!==m.oldUsed || a.newState.policyHash!==hash(encode(a.newPolicy)) || s.used<m.oldUsed)throw Error('partial admission extension remains blocked');
      previous=a.newPolicy;
    }
    if(previous && encode(previous)!==encode(this.policy))throw Error('partial admission extension remains blocked');
    return s;
  }
  summary() { return this.withLock(() => ({...this.policy,used:this.state().used})); }
  reserve(): void {
    this.withLock(() => {
      const s = this.state();
      if (s.used >= this.policy.maximum) throw Error('durable admission cap reached');
      s.used++;
      replaceDurableFile(join(this.directory,'state.json'),encode(s));
      // No rollback for any subsequent refusal, crash, failed read or lost response.
    });
  }
  /** Explicit operator-only migration. Trusted installation data selects the exact
   * prior snapshot and immutable archive. Used slots and lock custody never reset. */
  private extend(step:Migration['step']):void {
    this.withLock(()=>{
      const state=this.state(),matches=this.contract.migrations.filter(m=>m.step===step);
      if(matches.length!==1)throw Error('admission extension exceeds reviewed scope/snapshot');
      const m=matches[0]!;
      if(this.policy.maximum!==m.oldMaximum || this.policy.carryForward!==m.carryForward || state.used!==m.oldUsed)throw Error('admission extension exceeds reviewed scope/snapshot');
      const next={...this.policy,maximum:m.newMaximum},nextState={...state,policyHash:hash(encode(next))};
      createDurableFile(join(this.directory,m.archive),encode({schema:1,reason:m.reason,oldPolicy:this.policy,oldState:state,newPolicy:next,newState:nextState}));
      replaceDurableFile(join(this.directory,'policy.json'),encode(next));
      replaceDurableFile(join(this.directory,'state.json'),encode(nextState));
    });
  }
  extendExpiredAOrderLimit():void {this.extend('expired-order');}
  extendDemoRuns100():void {this.extend('demo-runs');}
}
