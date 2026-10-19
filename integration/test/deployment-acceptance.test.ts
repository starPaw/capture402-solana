// Root-installation trust is mocked only in tests; runtime API has no acceptance parameter.
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
const trusted=vi.hoisted(()=>({hash:''}));
vi.mock('../src/operational-data.ts',async original=>({...await original<typeof import('../src/operational-data.ts')>(),operationalSha256:()=>{if(!/^[a-f0-9]{64}$/.test(trusted.hash))throw Error('trusted installation policy unavailable');return trusted.hash;}}));
import {loadDeploymentRecord} from '../src/deployment-record.ts';
import {deploymentFixture} from './fixtures/deployment-fixture.ts';
const dirs:string[]=[];
afterEach(()=>{dirs.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true}));trusted.hash='';});
function record(raw:string){const dir=mkdtempSync(join(tmpdir(),'synthetic-accepted-record-'));dirs.push(dir);const path=join(dir,'record.json');writeFileSync(path,raw);return path;}
test('only byte-exact or CRLF normalized independently trusted synthetic acceptance loads',()=>{
 const raw=JSON.stringify(deploymentFixture(),null,2)+'\n';trusted.hash=createHash('sha256').update(raw).digest('hex');
 expect(loadDeploymentRecord(record(raw)).sha256).toBe(trusted.hash);expect(loadDeploymentRecord(record(raw.replace(/\n/g,'\r\n'))).sha256).toBe(trusted.hash);
 expect(()=>loadDeploymentRecord(record(raw+' '))).toThrow('not the pinned accepted record');
});
test('caller acceptance override, valid substitute and missing installation trust cannot change pin',()=>{
 const raw=JSON.stringify(deploymentFixture());const path=record(raw);trusted.hash='f'.repeat(64);
 expect(()=>Reflect.apply(loadDeploymentRecord,undefined,[path,{expectedSha256:createHash('sha256').update(raw).digest('hex')}])).toThrow('not the pinned accepted record');
 trusted.hash='';expect(()=>loadDeploymentRecord(path)).toThrow('trusted installation policy');
});
test('accepted malformed/schema-ineligible bytes still fail full parser',()=>{
 for(const raw of ['{not-json',JSON.stringify({...deploymentFixture(),record_status:'template'})]){
 trusted.hash=createHash('sha256').update(raw).digest('hex');expect(()=>loadDeploymentRecord(record(raw))).toThrow();}
});
