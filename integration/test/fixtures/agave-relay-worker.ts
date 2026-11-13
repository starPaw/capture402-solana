// Disposable local-validator fixture. The generated key never leaves the temporary directory.
import { readFileSync, appendFileSync } from "node:fs";
import { getPublicKeyFromAddress, type KeyPairSigner } from "@solana/kit";
import { Facilitator } from "../../src/facilitator.ts";
import { RpcLedger } from "../../src/rpc-ledger.ts";
import { V2OrderJournal } from "../../src/v2-order-journal.ts";
import { FileSubmissionJournal } from "../../src/submission-journal.ts";

const [path,index]=process.argv.slice(2),input=JSON.parse(readFileSync(path!,"utf8"));
const url=new URL(input.url);
if(url.protocol!=="http:" || url.hostname!=="127.0.0.1")throw Error("local fixture only");
const feePayer={address:input.sponsor,keyPair:{publicKey:await getPublicKeyFromAddress(input.sponsor),
  privateKey:await crypto.subtle.importKey("pkcs8",Buffer.from(input.privateKey,"base64"),{name:"Ed25519"},false,["sign"])}} as KeyPairSigner;
const ledger=new RpcLedger({network:input.enrollment.binding.network,genesisHash:input.enrollment.binding.genesisHash,
  rpcUrl:input.url,pollIntervalMs:100,confirmTimeoutMs:45_000});
await ledger.verifyGenesis();
const submit=ledger.submit.bind(ledger);
ledger.submit=async tx=>{appendFileSync(input.dispatches,"dispatch\n",{mode:0o600});const result=await submit(tx);
  if(input.lost)throw Error("synthetic lost response");return result;};
const service=new Facilitator({network:ledger.network,programId:input.enrollment.binding.programId,feePayer,ledger,
  orderKey:input.orderKey,orderJournal:new V2OrderJournal(input.orders,input.enrollment),journal:new FileSubmissionJournal(input.submissions)});
try {
  const result=await service.settle(input.requests[Number(index)]);
  process.stdout.write(JSON.stringify({success:result.success,signature:result.transaction,reason:result.errorReason}));
} catch {process.stdout.write(JSON.stringify({success:false,unknown:true}));}
