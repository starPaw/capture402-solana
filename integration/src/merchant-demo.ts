// E2E-only application delegation. Existing merchant remains the onchain signer.
import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {isAddress,getPublicKeyFromAddress,verifySignature,type Address,type SignatureBytes} from '@solana/kit';
import { operationalValue } from './operational-data.ts';
export function merchantDemoPolicy():Record<string,unknown> {
  const p=operationalValue<Record<string,unknown>>('merchantDemoPolicy');
  if(!p || ['programId','sponsor','merchant','mint'].some(k=>typeof p[k]!=='string'||!isAddress(p[k] as string)) || typeof p.network!=='string' || !/^solana:[-_a-zA-Z0-9]{1,32}$/.test(p.network) || p.schema!==1 || p.budget!=='100000000' || p.maximumOrders!==100 || p.maximumRelayAttempts!==600 || typeof p.origin!=='string' || new URL(p.origin).origin!==p.origin || !p.origin.startsWith('https://'))throw Error('invalid trusted merchant demo policy');
  return p;
}
export function validateMerchantDemoPolicy(value:unknown) {
  const E2E_MERCHANT_DEMO_POLICY=merchantDemoPolicy();
  const p=value as Record<string,unknown>;
  if(!p || Object.keys(p).sort().join()!==[...Object.keys(E2E_MERCHANT_DEMO_POLICY),'reference'].sort().join() ||
    Object.entries(E2E_MERCHANT_DEMO_POLICY).some(([k,v])=>p[k]!==v) || typeof p.reference!=='string' || !p.reference.trim())throw Error('fixed E2E merchant demo policy required');
}
export type MerchantDemoScope={schema:1;origin:string;network:string;programId:Address;sponsor:Address;merchant:Address;mint:Address;
  budget:'100000000';order:string;payment:Address;payer:Address;scenario:string;captureDeadline:number;refundDeadline:number;capabilityHash:string};
type Intent=MerchantDemoScope & {nonce:string;expiresAt:number};
const canonical=(v:unknown)=>JSON.stringify(v);
export function merchantDemoMessage(i:Intent) {
  return `Capture402 Devnet merchant demo controls\nOrigin: ${i.origin}\nPayer: ${i.payer}\nOrder: ${i.order}\nPayment: ${i.payment}\nScenario: ${i.scenario}\nMerchant: ${i.merchant}\nSponsor: ${i.sponsor}\nMint: ${i.mint}\nProgram: ${i.programId}\nBudget: 100 test tokens\nCapture deadline: ${i.captureDeadline}\nRefund deadline: ${i.refundDeadline}\nRequest: ${i.nonce}\nExpires: ${i.expiresAt}\nI allow fixed capture, release and merchant-funded refund actions for this test order only. No other order or wallet transaction authority is granted.`;
}
export class MerchantDemoConsent {
  private readonly key:string;
  constructor(key:string) {if(key.length<32)throw Error('private merchant consent key required');this.key=key;}
  private mac(payload:string) {return createHmac('sha256',this.key).update('capture402-e2e-merchant-demo-v1\0').update(payload).digest();}
  challenge(scope:MerchantDemoScope,now:bigint) {
    if(!Number.isSafeInteger(scope.refundDeadline) || now>=BigInt(scope.refundDeadline))throw Error('original merchant demo deadline expired');
    const i:Intent={...scope,nonce:randomBytes(32).toString('hex'),expiresAt:scope.refundDeadline};
    const payload=Buffer.from(canonical(i)).toString('base64url');
    return {...i,message:merchantDemoMessage(i),token:`${payload}.${this.mac(payload).toString('base64url')}`};
  }
  async verify(header:string,scope:MerchantDemoScope):Promise<number> {
    if(!header.startsWith('Demo ') || header.length>4096)throw Error('order-scoped wallet consent required');
    const encoded=header.slice(5);
    if(!/^[A-Za-z0-9_-]+$/.test(encoded))throw Error('invalid demo consent');
    const raw=Buffer.from(encoded,'base64url');if(raw.toString('base64url')!==encoded)throw Error('noncanonical demo consent');
    const proof=JSON.parse(raw.toString('utf8'));
    if(!proof || Object.keys(proof).sort().join()!=='signature,token' || typeof proof.token!=='string' ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(proof.token) || typeof proof.signature!=='string' || !/^[A-Za-z0-9+/]{86}==$/.test(proof.signature))throw Error('invalid demo consent');
    const [payload,mac]=proof.token.split('.') as [string,string];
    const bytes=Buffer.from(mac,'base64url'),expected=this.mac(payload);
    if(bytes.toString('base64url')!==mac || bytes.length!==expected.length || !timingSafeEqual(bytes,expected))throw Error('untrusted demo request');
    const data=Buffer.from(payload,'base64url');const i=JSON.parse(data.toString('utf8')) as Intent;
    if(data.toString('base64url')!==payload || canonical(i)!==data.toString('utf8'))throw Error('noncanonical demo request');
    const {nonce,expiresAt,...bound}=i;
    if(!/^[a-f0-9]{64}$/.test(nonce) || !Number.isSafeInteger(expiresAt) || expiresAt!==scope.refundDeadline || canonical(bound)!==canonical(scope))throw Error('demo consent scope differs');
    const signature=Buffer.from(proof.signature,'base64');
    if(signature.toString('base64')!==proof.signature || !await verifySignature(await getPublicKeyFromAddress(scope.payer),signature as unknown as SignatureBytes,new TextEncoder().encode(merchantDemoMessage(i))))throw Error('original payer message signature required');
    return expiresAt;
  }
}
