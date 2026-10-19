import type { CircleApproval } from '../../src/payment-profile.ts';
import type { Address } from '@solana/kit';
// Synthetic private-installation data for offline tests only. Never an accepted runtime policy.
import type { AuthorizeAbandonPolicy } from '../../src/authorize-abandon.ts';
export const EXPIRED_A_POLICY:AuthorizeAbandonPolicy = Object.freeze({schema:1,sourceSha:'1111111111111111111111111111111111111111',
  order:'22222222222222222222222222222222',payment:'2VDW9dFE1ZXz4zWAbaBDQFynNVdRpQ73HyfSHMzBSL6Z',payer:'2Z8oHviEbrqDD5kg2sW8h8kYceqdVTnrrPL6Lk2nBfRG',
  orderSha256:'5555555555555555555555555555555555555555555555555555555555555555',consentSha256:'6666666666666666666666666666666666666666666666666666666666666666'});
export const UNRECORDED_A_POLICY:AuthorizeAbandonPolicy = Object.freeze({schema:1,sourceSha:'7777777777777777777777777777777777777777',
  order:'88888888888888888888888888888888',payment:'2tjH1S3HZMKLuY1DDN8j9WcMqStdrnDxeRfNdeFmvL2o',payer:'2Z8oHviEbrqDD5kg2sW8h8kYceqdVTnrrPL6Lk2nBfRG',
  orderSha256:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',consentSha256:'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'});
export const PENDING_A_ISOLATION = Object.freeze({schema:1,sourceSha:'cccccccccccccccccccccccccccccccccccccccc',
  order:'dddddddddddddddddddddddddddddddd',payment:'3EKkiwNLWqoUbzFkPrmKbtUB4EweE6f4STzevYUmezeL',payer:'2Z8oHviEbrqDD5kg2sW8h8kYceqdVTnrrPL6Lk2nBfRG',
  orderSha256:'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  consentSha256:'1111111111111111111111111111111111111111111111111111111111111111',
  busySha256:'2222222222222222222222222222222222222222222222222222222222222222',
  actionSha256:'3333333333333333333333333333333333333333333333333333333333333333',
  journalSha256:'4444444444444444444444444444444444444444444444444444444444444444',
  signature:'2222222222222222222222222222222222222222222222222222222222222222222222222222222222222222',
  messageHash:'6666666666666666666666666666666666666666666666666666666666666666',
  signedWireSha256:'7777777777777777777777777777777777777777777777777777777777777777'});
export const E2E_MERCHANT_DEMO_POLICY = Object.freeze({schema:1,origin:'https://e2e.example.invalid',
  network:'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',programId:'3uWi9x2SRpmjztkpkr2WWeBoVq3exjXG2YfDWLvm8KsQ',
  sponsor:'3yS1JFVT284y8z1LC9MRoWxZjzFrdoD5axKsZiyMsfC7',merchant:'43MJSYxTcRNCH5FqdSgM6PjKz9U4Jrtu9MzXd71xczWp',
  mint:'47GbarRUCifRRAWM4k1GPGW6EJgFyvaihmfBgV4ZNKqX',budget:'100000000',maximumOrders:100,maximumRelayAttempts:600});

export const operationalFixture = {
 circleUsdcDemoProfile:undefined as CircleApproval|undefined,
 sponsorAddress:E2E_MERCHANT_DEMO_POLICY.sponsor,mintAddress:E2E_MERCHANT_DEMO_POLICY.mint,browserAddress:'2Z8oHviEbrqDD5kg2sW8h8kYceqdVTnrrPL6Lk2nBfRG',campaignReference:'synthetic-stock-campaign',
 schema:1, deploymentRecordSha256:'f'.repeat(64), b3RecoverySourceSha:'a'.repeat(40),
 authorizeAbandonPolicies:[EXPIRED_A_POLICY,UNRECORDED_A_POLICY],authorizeIsolationPolicy:PENDING_A_ISOLATION,
 merchantDemoPolicy:E2E_MERCHANT_DEMO_POLICY,e2eApplicationRelease:'e'.repeat(40),
 preSignerStop:{source:'d'.repeat(40),entry:'c'.repeat(64),manifest:'b'.repeat(64)},
};

export function circleApprovalFixture(sponsor:Address,merchant:Address,origin='https://circle.example.invalid'):CircleApproval {
  return {schema:1,reference:'synthetic-circle-approval',profileId:'circle-usdc-v1',network:'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',genesisHash:'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    programId:'992QmwmwCebawRJsTCgvc8qnzGivbFaD39ZQE7VhHp7o' as Address,mint:'4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' as Address,decimals:6,sponsor,treasury:sponsor,merchant,origin,budget:'100000',firstCapture:'40000',
    secondCapture:'25000',releaseRemainder:'35000',refundExample:'10000',faucetAmount:'500000',cooldownSeconds:86400,
    maximumClaims:100,tokenSpendLimit:'50000000',sponsorSpendLimit:'1000000000',maximumOrders:100,maximumRelayAttempts:600};
}
