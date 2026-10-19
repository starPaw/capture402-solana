// Public profile data is supplied by the trusted server. Wallet checks repeat the
// source-defined amounts and Circle identities before requesting any signature.
const legacy=Object.freeze({id:'legacy-test-v1',decimals:6,assetLabel:'test tokens',budget:'100000000',firstCapture:'40000000',secondCapture:'25000000',releaseRemainder:'35000000',refundExample:'10000000',faucetAmount:'1000000000'});
const circle=Object.freeze({id:'circle-usdc-v1',decimals:6,assetLabel:'USDC',budget:'100000',firstCapture:'40000',secondCapture:'25000',releaseRemainder:'35000',refundExample:'10000',faucetAmount:'500000'});
export function browserProfile(policy) {
  const p=policy?.paymentProfile??legacy,expected=p.id===circle.id?circle:legacy;
  if(Object.keys(p).sort().join()!==Object.keys(expected).sort().join() || Object.entries(expected).some(([k,v])=>p[k]!==v))throw new Error('Unrecognized trusted payment profile.');
  if(p.id===circle.id && (policy.mint!=='4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' || policy.programId!=='992QmwmwCebawRJsTCgvc8qnzGivbFaD39ZQE7VhHp7o' || !/^[a-f0-9]{64}$/.test(policy.profileHash??'')))throw new Error('Circle payment profile identity mismatch.');
  return expected;
}
export const profileAmount=(policy,key)=>Number(browserProfile(policy)[key])/1_000_000;
export const profileLabel=(policy,key)=>`${profileAmount(policy,key).toLocaleString('en-US',{minimumFractionDigits:browserProfile(policy).id===circle.id?2:0,maximumFractionDigits:6})} ${browserProfile(policy).assetLabel}`;
