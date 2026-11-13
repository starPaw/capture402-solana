import type { CircleApproval } from '../../src/payment-profile.ts';
import type { Address } from '@solana/kit';
// Synthetic private-installation data for offline tests only. Never an accepted runtime policy.
export const E2E_MERCHANT_DEMO_POLICY = Object.freeze({schema:1,origin:'https://e2e.example.invalid',
  network:'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',programId:'3uWi9x2SRpmjztkpkr2WWeBoVq3exjXG2YfDWLvm8KsQ',
  sponsor:'3yS1JFVT284y8z1LC9MRoWxZjzFrdoD5axKsZiyMsfC7',merchant:'43MJSYxTcRNCH5FqdSgM6PjKz9U4Jrtu9MzXd71xczWp',
  mint:'47GbarRUCifRRAWM4k1GPGW6EJgFyvaihmfBgV4ZNKqX',budget:'100000000',maximumOrders:100,maximumRelayAttempts:600});

export const operationalFixture = {
 circleUsdcDemoProfile:undefined as CircleApproval|undefined,
 sponsorAddress:E2E_MERCHANT_DEMO_POLICY.sponsor,mintAddress:E2E_MERCHANT_DEMO_POLICY.mint,browserAddress:'2Z8oHviEbrqDD5kg2sW8h8kYceqdVTnrrPL6Lk2nBfRG',campaignReference:'synthetic-stock-campaign',
 schema:1, deploymentRecordSha256:'f'.repeat(64), b3RecoverySourceSha:'a'.repeat(40),
 merchantDemoPolicy:E2E_MERCHANT_DEMO_POLICY,e2eApplicationRelease:'e'.repeat(40),
 preSignerStop:{source:'d'.repeat(40),entry:'c'.repeat(64),manifest:'b'.repeat(64)},
};

export function circleApprovalFixture(sponsor:Address,merchant:Address,origin='https://circle.example.invalid'):CircleApproval {
  return {schema:1,reference:'synthetic-circle-approval',profileId:'circle-usdc-v1',network:'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',genesisHash:'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    programId:'992QmwmwCebawRJsTCgvc8qnzGivbFaD39ZQE7VhHp7o' as Address,mint:'4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' as Address,decimals:6,sponsor,treasury:sponsor,merchant,origin,budget:'100000',firstCapture:'40000',
    secondCapture:'25000',releaseRemainder:'35000',refundExample:'10000',faucetAmount:'500000',cooldownSeconds:86400,
    maximumClaims:100,tokenSpendLimit:'50000000',sponsorSpendLimit:'1000000000',maximumOrders:100,maximumRelayAttempts:600};
}
