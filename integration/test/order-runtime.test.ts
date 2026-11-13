import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { LOCAL_PROGRAM_ID } from "../src/program.ts";
import { initializeV2OrderJournal } from "../src/v2-order-journal.ts";
import { orderProviderId, runtimeOrderConfig } from "../src/order-runtime.ts";

const directories:string[]=[];
afterEach(()=>{for(const dir of directories.splice(0))rmSync(dir,{recursive:true,force:true});});
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),"v2-runtime-"));directories.push(dir);
  const root=join(dir,"orders"),pin=join(dir,"external-pin.json"),endpoint="http://127.0.0.1:12345";
  const record={programId:LOCAL_PROGRAM_ID,network:{cluster:"localnet",caip2:"solana:synthetic",genesisHash:LOCAL_PROGRAM_ID}};
  const enrollment=initializeV2OrderJournal(root,{namespace:"test",network:record.network.caip2,genesisHash:LOCAL_PROGRAM_ID,
    programId:record.programId,merchant:LOCAL_PROGRAM_ID,providerId:orderProviderId(endpoint)});
  const bytes=JSON.stringify(enrollment);writeFileSync(pin,bytes,{mode:0o600});
  const env={SAC006_V2_ORDER_JOURNAL_DIR:root,SAC006_V2_ORDER_ENROLLMENT_PATH:pin,
    SAC006_V2_ORDER_ENROLLMENT_SHA256:createHash("sha256").update(bytes).digest("hex"),SOLANA_RPC_URL:endpoint,SAC006_BEARER_TOKEN:"synthetic-key"};
  return {root,pin,record,env,enrollment,open:()=>runtimeOrderConfig(record,LOCAL_PROGRAM_ID,undefined,env)};
}
test("restart opens the original enrollment without rewriting it",()=>{
  const f=fixture(),before=readFileSync(join(f.root,"enrollment.json"));
  expect(f.open().orderJournal.enrollment).toEqual(f.enrollment);expect(f.open().orderJournal.enrollment).toEqual(f.enrollment);
  expect(readFileSync(join(f.root,"enrollment.json"))).toEqual(before);
});
test("a dot-prefixed child cannot masquerade as an external enrollment pin",()=>{
  const f=fixture(),bytes=readFileSync(f.pin),inside=join(f.root,"..pin.json");
  writeFileSync(inside,bytes,{mode:0o600});
  f.env.SAC006_V2_ORDER_ENROLLMENT_PATH=inside;
  expect(f.open).toThrow("order enrollment pin must be outside the journal");
  expect(readFileSync(inside)).toEqual(bytes);
});
test.each(["missing-store","missing-pin","changed-pin","wrong-network","wrong-provider","pin-in-store"])("runtime refuses %s without recreating custody",fault=>{
  const f=fixture();
  if(fault==="missing-store")rmSync(f.root,{recursive:true});
  if(fault==="missing-pin")rmSync(f.pin);
  if(fault==="changed-pin")writeFileSync(f.pin,"{}");
  if(fault==="wrong-network")f.record.network.caip2="solana:another";
  if(fault==="wrong-provider")f.env.SOLANA_RPC_URL+="/another";
  if(fault==="pin-in-store")f.env.SAC006_V2_ORDER_ENROLLMENT_PATH=join(f.root,"enrollment.json");
  expect(f.open).toThrow();
});
