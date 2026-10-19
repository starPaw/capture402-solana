// Standard Solana JSON-RPC wire compatibility through the existing @solana/kit
// adapter. The only endpoint is this loopback server; no provider or chain calls.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, test } from 'vitest';
import { generateKeyPairSigner, getSignatureFromTransaction, lamports } from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import { RpcLedger } from '../src/rpc-ledger.ts';
import { buildTransaction, encodeTransaction } from '../src/transactions.ts';
import { DEVNET_GENESIS, DEVNET_NETWORK, CIRCLE_MINT } from '../src/payment-profile.ts';

test('QuickNode-compatible standard RPC verifies Devnet, reads accounts and submits one exact wire with finalized status',async()=>{
  const payer=await generateKeyPairSigner(),recipient=await generateKeyPairSigner();
  const tx=await buildTransaction({feePayer:payer.address,signers:[payer],lifetime:{blockhash:DEVNET_GENESIS as never,lastValidBlockHeight:100n},instructions:[getTransferSolInstruction({source:payer,destination:recipient.address,amount:lamports(1n)})]});
  const signature=getSignatureFromTransaction(tx),requests:{method:string;params:any[]}[]=[];
  let wrongGenesis=false;
  const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw);requests.push(body);
    const result=body.method==='getGenesisHash'?wrongGenesis?'wrong-genesis':DEVNET_GENESIS:
      body.method==='getAccountInfo'?{context:{slot:9},value:null}:
      body.method==='sendTransaction'?signature:
      body.method==='getSignatureStatuses'?{context:{slot:10},value:[{slot:10,confirmations:null,err:null,confirmationStatus:'finalized'}]}:null;
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:body.id,result}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try {
    const location=server.address();if(!location||typeof location==='string')throw Error('loopback unavailable');
    const ledger=new RpcLedger({network:DEVNET_NETWORK,genesisHash:DEVNET_GENESIS,rpcUrl:`http://127.0.0.1:${location.port}`,confirmTimeoutMs:1000,pollIntervalMs:1});
    await ledger.verifyGenesis();expect(await ledger.getAccount(CIRCLE_MINT)).toBeNull();
    expect(await ledger.submit(tx)).toMatchObject({kind:'submitted',outcome:{status:'succeeded',commitment:'finalized'}});
    const sends=requests.filter(r=>r.method==='sendTransaction');expect(sends).toHaveLength(1);
    expect(sends[0]!.params).toEqual([encodeTransaction(tx),{encoding:'base64',skipPreflight:false,preflightCommitment:'processed',maxRetries:0}]);
    expect(requests.find(r=>r.method==='getAccountInfo')!.params).toEqual([CIRCLE_MINT,{encoding:'base64',commitment:'confirmed'}]);
    wrongGenesis=true;await expect(ledger.verifyGenesis()).rejects.toThrow(/genesis mismatch/);
    expect(requests.filter(r=>r.method==='sendTransaction')).toHaveLength(1);
  } finally {await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});

test('Circle gateway rejects substituted terms before identity checks, admission or facilitator signing',async()=>{
  const {createGatewayApp}=await import('../src/gateway.ts');
  const {SponsorshipGuard}=await import('../src/sponsorship.ts');
  const {CIRCLE_PROFILE,DEVNET_PROGRAM}=await import('../src/payment-profile.ts');
  const {vi}=await import('vitest');
  const payer=await generateKeyPairSigner(),verifyEconomicIdentity=vi.fn(async()=>{throw Error('private-endpoint-secret');});
  const sponsorship=new SponsorshipGuard({feePayer:payer.address,maxAttempts:600,minLamportsBalance:1n,ledger:{getAccount:async()=>{throw Error('must not read');}} as any});
  const facilitator={network:DEVNET_NETWORK,programId:DEVNET_PROGRAM,verify:vi.fn(),settle:vi.fn(),supported:()=>({})};
  const app=createGatewayApp(facilitator as any,{bearerToken:'synthetic-gateway-secret-0123456789',sponsorship,verifyEconomicIdentity,
    paymentTerms:{budget:CIRCLE_PROFILE.budget,network:DEVNET_NETWORK,programId:DEVNET_PROGRAM},allowlist:{merchant:payer.address,mint:CIRCLE_MINT}});
  const terms={amount:'100000',network:DEVNET_NETWORK,payTo:payer.address,asset:CIRCLE_MINT,extra:{programId:DEVNET_PROGRAM}};
  const post=(r:unknown)=>app.request('/settle',{method:'POST',headers:{Authorization:'Bearer synthetic-gateway-secret-0123456789','Content-Type':'application/json'},body:JSON.stringify({paymentRequirements:r})});
  for(const change of [{amount:'100000000'},{network:'solana:mainnet'},{asset:payer.address},{extra:{programId:payer.address}}])expect((await post({...terms,...change})).status).toBe(403);
  expect(verifyEconomicIdentity).not.toHaveBeenCalled();expect(sponsorship.attemptCount).toBe(0);
  const response=await post(terms);expect(response.status).toBe(503);expect(await response.text()).not.toContain('private-endpoint-secret');
  expect(sponsorship.attemptCount).toBe(0);expect(facilitator.settle).not.toHaveBeenCalled();
});
