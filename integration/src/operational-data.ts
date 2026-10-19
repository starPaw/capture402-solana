// Installation authority is separate from requests, environment variables and deployment records.
// The fixed policy path is installed by an authorized root operator, never selected by callers.
import { constants, openSync, closeSync, fstatSync, lstatSync, readFileSync, realpathSync, type BigIntStats } from 'node:fs';
import { strictJson } from './quarantine-view.ts';
import { dirname } from 'node:path';
export const OPERATIONAL_DATA_PATH = '/etc/capture402/operational-data.json';
export const DEPLOYMENT_RECORD_PATH = '/etc/capture402/deployment-identity.v1.json';
const refuse = (): never => { throw Error('trusted installation policy unavailable or unsafe'); };
const identity = (s: BigIntStats) => [s.dev,s.ino,s.mode,s.uid,s.gid,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(':');
export function loadOperationalData(): Readonly<Record<string, unknown>> {
  const path = OPERATIONAL_DATA_PATH;
  let fd: number | undefined;
  try {
    const ancestry: {path:string; identity:string}[] = [];
    // Refuse aliases as well as writable ancestry; installation targets real local paths.
    const parent = dirname(path);
    if(realpathSync(parent)!==parent)refuse();
    for (let p=parent;;p=dirname(p)) {
      const s=lstatSync(p,{bigint:true});
      if(!s.isDirectory() || s.isSymbolicLink() || s.uid!==0n || (s.mode&0o022n)!==0n)refuse();
      ancestry.push({path:p,identity:identity(s)});
      if(dirname(p)===p)break;
    }
    const resolved = parent+'/operational-data.json';
    const before=lstatSync(resolved,{bigint:true});
    if(!before.isFile() || before.isSymbolicLink() || before.uid!==0n || before.nlink!==1n || (before.mode&0o022n)!==0n || before.size<0n || before.size>1048576n)refuse();
    fd=openSync(resolved,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    if(identity(fstatSync(fd,{bigint:true}))!==identity(before))refuse();
    const raw=readFileSync(fd,'utf8');
    if(identity(fstatSync(fd,{bigint:true}))!==identity(before) || identity(lstatSync(resolved,{bigint:true}))!==identity(before) || realpathSync(dirname(path))!==parent || ancestry.some(p=>identity(lstatSync(p.path,{bigint:true}))!==p.identity))refuse();
    const data:unknown=strictJson(raw);
    if(!data || typeof data!=='object' || Array.isArray(data) || (data as Record<string,unknown>).schema!==1)refuse();
    return Object.freeze(data as Record<string,unknown>);
  } catch {return refuse();} finally {if(fd!==undefined)closeSync(fd);}
}
export function operationalValue<T=unknown>(name:string):T {
  const value=loadOperationalData()[name];
  if(value===undefined || value===null || value==='')refuse();
  return value as T;
}
export function operationalSha256(name:string):string {
  const value=operationalValue(name);
  if(typeof value!=='string' || !/^[a-f0-9]{64}$/.test(value))return refuse();
  return value;
}
export function operationalRevision(name:string):string {
  const value=operationalValue(name);
  if(typeof value!=='string' || !/^[a-f0-9]{40}$/.test(value))return refuse();
  return value;
}
