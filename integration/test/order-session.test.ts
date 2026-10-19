import { beforeAll, expect, test } from 'vitest';
import { generateKeyPairSigner, signBytes } from '@solana/kit';
import { OrderSessionAccess, type OrderSessionScope } from '../src/order-session.ts';

const key = 'local-session-fixture-secret-0123456789';
const access = new OrderSessionAccess(key), now = 1800000000;
let payer: Awaited<ReturnType<typeof generateKeyPairSigner>>, outsider: typeof payer, scope: OrderSessionScope;
beforeAll(async () => {
  [payer, outsider] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner()]);
  scope = { origin:'https://demo.test', network:'solana:devnet', programId:outsider.address,
    order:'a'.repeat(32), payer:payer.address, payment:outsider.address, capabilityHash:'b'.repeat(64) };
});
async function proof(signer = payer) {
  const challenge = access.challenge(scope, now);
  return { token:challenge.token, signature:Buffer.from(await signBytes(signer.keyPair.privateKey,new TextEncoder().encode(challenge.message))).toString('base64') };
}
test('only original payer consent restores an access cookie across restart, with fixed absolute expiry',async()=>{
  const consent=await proof(), restored=await access.restore(consent,scope,now+2);
  expect(restored.cookie.length).toBeLessThan(256);
  expect(access.accepts(restored.cookie,scope,now+2)).toBe(true);
  expect(new OrderSessionAccess(key).accepts(restored.cookie,scope,now+200)).toBe(true);
  expect(await access.restore(consent,scope,now+200)).toEqual(restored);
  expect(access.accepts(restored.cookie,scope,restored.expiresAt)).toBe(false);
  expect(access.accepts(restored.cookie,scope,now-1)).toBe(false);
  expect(new OrderSessionAccess(key+'changed').accepts(restored.cookie,scope,now+2)).toBe(false);
});
test('wrong wallet, expired challenge, future issue time, malformed and extended proofs cannot restore access',async()=>{
  const consent=await proof();
  await expect(access.restore(await proof(outsider),scope,now)).rejects.toThrow();
  for(const time of [now-1,now+300,now+86400]) await expect(access.restore(consent,scope,time)).rejects.toThrow();
  for(const bad of [null,{},[],{...consent,extra:true},{...consent,token:consent.token+'x'},
    {...consent,signature:Buffer.alloc(64).toString('base64')},{...consent,token:'x'.repeat(4097)}]) {
    await expect(access.restore(bad,scope,now)).rejects.toThrow();
  }
});
test.each(['origin','network','programId','order','payer','payment','capabilityHash'] as const)('proof and cookie cannot cross %s',async field=>{
  const consent=await proof(), restored=await access.restore(consent,scope,now);
  const changed={...scope,[field]:scope[field]+'changed'};
  await expect(access.restore(consent,changed,now)).rejects.toThrow();
  expect(access.accepts(restored.cookie,changed,now)).toBe(false);
});
test('modified, legacy, malformed and oversized cookies grant no recovered access',async()=>{
  const {cookie}=await access.restore(await proof(),scope,now);
  for(const bad of ['',scope.order+'.legacy','x'.repeat(257),cookie+'x',cookie.replace('.r1.','.r2.'),cookie.replace(String(now+86400),String(now+86401))]) {
    expect(access.accepts(bad,scope,now)).toBe(false);
  }
});
