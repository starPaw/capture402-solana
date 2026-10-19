// Synthetic filesystem metadata; never writes privileged installation policy or contacts RPC.
import { beforeEach, expect, test, vi } from 'vitest';
const io=vi.hoisted(()=>({raw:'',file:{} as any,dir:{} as any,swapFd:false,swapPath:false,swapParent:false,readCount:0,closed:[] as number[]}));
vi.mock('node:fs',async original=>{
 const actual=await original<typeof import('node:fs')>();
 return {...actual,
 realpathSync:()=>'/etc/capture402',
 lstatSync:(path:string)=>path.endsWith('operational-data.json')?{...io.file,ino:io.swapPath&&io.readCount?9n:2n}:{...io.dir,ino:io.swapParent&&io.readCount?9n:1n},
 fstatSync:()=>({...io.file,ino:io.swapFd&&io.readCount?9n:2n}),
 openSync:vi.fn(()=>7),readFileSync:()=>{io.readCount++;return io.raw;},closeSync:(fd:number)=>{io.closed.push(fd);},
 };
});
import { loadOperationalData, operationalValue, operationalSha256, operationalRevision, OPERATIONAL_DATA_PATH } from '../src/operational-data.ts';
beforeEach(()=>{
 Object.assign(io,{raw:'{"schema":1,"deploymentRecordSha256":"'+'a'.repeat(64)+'","release":"'+'b'.repeat(40)+'"}',swapFd:false,swapPath:false,swapParent:false,readCount:0,closed:[]});
 io.file={dev:1n,ino:2n,mode:0o100644n,uid:0n,gid:0n,nlink:1n,size:200n,mtimeNs:1n,ctimeNs:1n,isFile:()=>true,isDirectory:()=>false,isSymbolicLink:()=>false};
 io.dir={dev:1n,ino:1n,mode:0o40755n,uid:0n,gid:0n,nlink:2n,size:100n,mtimeNs:1n,ctimeNs:1n,isFile:()=>false,isDirectory:()=>true,isSymbolicLink:()=>false};
});
test('fixed root-installed policy supplies acceptance; requests/env/extra arguments cannot select another trust path',()=>{
 process.env.SAC006_OPERATIONAL_DATA_PATH='/tmp/untrusted-policy.json';
 try {expect(Reflect.apply(loadOperationalData,undefined,['/tmp/untrusted-policy.json'])).toMatchObject({schema:1});expect(OPERATIONAL_DATA_PATH).toBe('/etc/capture402/operational-data.json');expect(operationalSha256('deploymentRecordSha256')).toBe('a'.repeat(64));expect(operationalRevision('release')).toBe('b'.repeat(40));expect(io.closed).toEqual([7,7,7]);}
 finally {delete process.env.SAC006_OPERATIONAL_DATA_PATH;}
});
test.each(['owner','writable','link','symlink','directory','oversized','negative-size'])('unsafe policy %s refuses before reading',fault=>{
 if(fault==='owner')io.file.uid=1n;if(fault==='writable')io.file.mode|=0o020n;if(fault==='link')io.file.nlink=2n;if(fault==='symlink')io.file.isSymbolicLink=()=>true;if(fault==='directory')io.file.isFile=()=>false;if(fault==='oversized')io.file.size=1048577n;if(fault==='negative-size')io.file.size=-1n;
 expect(()=>loadOperationalData()).toThrow('trusted installation policy');expect(io.readCount).toBe(0);
});
test.each(['owner','writable','symlink','not-directory'])('unsafe ancestor %s refuses before reading',fault=>{
 if(fault==='owner')io.dir.uid=1n;if(fault==='writable')io.dir.mode|=0o002n;if(fault==='symlink')io.dir.isSymbolicLink=()=>true;if(fault==='not-directory')io.dir.isDirectory=()=>false;
 expect(()=>loadOperationalData()).toThrow('trusted installation policy');expect(io.readCount).toBe(0);
});
test.each(['swapFd','swapPath','swapParent'] as const)('metadata/bytes race %s refuses after read and closes fd',fault=>{
 io[fault]=true;expect(()=>loadOperationalData()).toThrow('trusted installation policy');expect(io.readCount).toBe(1);expect(io.closed).toEqual([7]);
});
test.each(['null','[]','{}','{"schema":2}','{"schema":1,"schema":1}','{bad','{"schema":1,"deploymentRecordSha256":"bad"}'])('malformed/missing trust %s refuses',raw=>{
 io.raw=raw;expect(()=>operationalSha256('deploymentRecordSha256')).toThrow();
});
test('missing field and malformed revisions never get an empty/default acceptance',()=>{
 io.raw='{"schema":1,"release":"bad"}';expect(()=>operationalValue('missing')).toThrow();expect(()=>operationalRevision('release')).toThrow();
});
