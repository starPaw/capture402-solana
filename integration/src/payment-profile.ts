// Profiles are source-defined behavior. Live Circle selection additionally requires
// a separately approved record at the fixed root-owned operational-data boundary.
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAddress, type Address } from '@solana/kit';
import { operationalValue } from './operational-data.ts';
export const DEVNET_NETWORK = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const CIRCLE_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' as Address;
export const DEVNET_PROGRAM = '992QmwmwCebawRJsTCgvc8qnzGivbFaD39ZQE7VhHp7o' as Address;
export const LEGACY_PROFILE = Object.freeze({ id:'legacy-test-v1', decimals:6, assetLabel:'test tokens',
  budget:'100000000', firstCapture:'40000000', secondCapture:'25000000', releaseRemainder:'35000000', refundExample:'10000000', faucetAmount:'1000000000' });
export const CIRCLE_PROFILE = Object.freeze({ id:'circle-usdc-v1', decimals:6, assetLabel:'USDC',
  budget:'100000', firstCapture:'40000', secondCapture:'25000', releaseRemainder:'35000', refundExample:'10000', faucetAmount:'500000' });
export type PaymentProfile = typeof LEGACY_PROFILE | typeof CIRCLE_PROFILE;
export type CircleApproval = { schema:1; reference:string; profileId:'circle-usdc-v1'; network:string; genesisHash:string;
  programId:Address; mint:Address; decimals:6; sponsor:Address; treasury:Address; merchant:Address; origin:string;
  budget:'100000'; firstCapture:'40000'; secondCapture:'25000'; releaseRemainder:'35000'; refundExample:'10000';
  faucetAmount:'500000'; cooldownSeconds:86400; maximumClaims:100; tokenSpendLimit:string; sponsorSpendLimit:'1000000000';
  maximumOrders:100; maximumRelayAttempts:600 };
export function profileHash(value:unknown):string {
  return createHash('sha256').update(JSON.stringify(value,Object.keys(value as object).sort())).digest('hex');
}
export function validateCircleApproval(value:unknown):Readonly<CircleApproval> {
  const p=value as CircleApproval;
  const fixed={schema:1,profileId:CIRCLE_PROFILE.id,network:DEVNET_NETWORK,genesisHash:DEVNET_GENESIS,programId:DEVNET_PROGRAM,mint:CIRCLE_MINT,
    decimals:6,budget:CIRCLE_PROFILE.budget,firstCapture:CIRCLE_PROFILE.firstCapture,secondCapture:CIRCLE_PROFILE.secondCapture,
    releaseRemainder:CIRCLE_PROFILE.releaseRemainder,refundExample:CIRCLE_PROFILE.refundExample,faucetAmount:CIRCLE_PROFILE.faucetAmount,
    cooldownSeconds:86400,maximumClaims:100,sponsorSpendLimit:'1000000000',maximumOrders:100,maximumRelayAttempts:600};
  if(!p || Object.keys(p).sort().join()!==[...Object.keys(fixed),'reference','sponsor','treasury','merchant','origin','tokenSpendLimit'].sort().join() ||
    Object.entries(fixed).some(([k,v])=>p[k as keyof CircleApproval]!==v) || typeof p.reference!=='string' || !p.reference.trim() ||
    ![p.sponsor,p.treasury,p.merchant].every(isAddress) || p.treasury!==p.sponsor || p.merchant===p.treasury ||
    typeof p.tokenSpendLimit!=='string' || !/^[1-9][0-9]{0,7}$/.test(p.tokenSpendLimit) || BigInt(p.tokenSpendLimit)<500000n || BigInt(p.tokenSpendLimit)>50000000n ||
    typeof p.origin!=='string' || !p.origin.startsWith('https://') || new URL(p.origin).origin!==p.origin)throw Error('invalid approved Circle USDC profile');
  return Object.freeze({...p});
}
export function selectedPaymentProfile(selection=process.env.SAC006_PAYMENT_PROFILE):PaymentProfile {
  if(selection===undefined || selection===LEGACY_PROFILE.id)return LEGACY_PROFILE;
  if(selection!==CIRCLE_PROFILE.id)throw Error('unknown payment profile');
  circleApproval();return CIRCLE_PROFILE;
}
export const circleApproval=()=>validateCircleApproval(operationalValue('circleUsdcDemoProfile'));
export function validateProfileRuntime(profile:PaymentProfile,runtime:{network:string;programId:Address;asset:Address;feePayer:Address;server:{address:Address};origin:string}) {
  if(profile.id!==CIRCLE_PROFILE.id) {if(profile!==LEGACY_PROFILE)throw Error('unsupported payment profile');return;}
  const p=circleApproval();
  if(profile!==CIRCLE_PROFILE || runtime.network!==p.network || runtime.programId!==p.programId || runtime.asset!==p.mint ||
    runtime.feePayer!==p.sponsor || runtime.server.address!==p.merchant || runtime.origin!==p.origin)throw Error('Circle profile/runtime identity mismatch');
}
export function requireCircleRpc(endpoint:string) {
  const url=new URL(endpoint);
  if(url.protocol!=='https:' || !url.hostname.endsWith('.quiknode.pro') || url.username || url.password || url.hash)throw Error('Circle demo requires its approved QuickNode HTTPS RPC');
}
export function requireCircleNamespace(path:string) {
  const prefix='/var/lib/capture402-e2e/circle-usdc-v1/';
  if(!path.startsWith(prefix) || path.split('/').some(v=>v==='.'||v==='..') || path.includes('//') || realpathSync(path)!==path)throw Error('Circle demo requires isolated circle-usdc-v1 custody');
}
