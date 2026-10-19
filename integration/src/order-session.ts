// Restore application access to one existing order. This never changes its
// original capability, economic state, deadlines, signatures or merchant grant.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getPublicKeyFromAddress, verifySignature, type Address, type SignatureBytes } from '@solana/kit';

export type OrderSessionScope = { origin: string; network: string; programId: Address;
  order: string; payer: Address; payment: Address; capabilityHash: string };
type Intent = OrderSessionScope & { nonce: string; issuedAt: number; expiresAt: number };
const lifetime = 86400;
export function orderSessionMessage(i: Intent) {
  return `Capture402 Devnet restore original order\nOrigin: ${i.origin}\nNetwork: ${i.network}\nProgram: ${i.programId}\nPayer: ${i.payer}\nOrder: ${i.order}\nPayment: ${i.payment}\nRequest: ${i.nonce}\nIssued: ${i.issuedAt}\nExpires: ${i.expiresAt}\nRestore browser access to this existing order only. No payment, token claim, merchant consent or transaction authority is granted.`;
}
export class OrderSessionAccess {
  private readonly key: string;
  constructor(key: string) { if (key.length < 32) throw Error('private session key required'); this.key = key; }
  private mac(kind: string, payload: string) {
    return createHmac('sha256', this.key).update(`capture402-order-session-${kind}-v1\0`).update(payload).digest('base64url');
  }
  private matches(actual: string, expected: string) {
    const a = Buffer.from(actual), b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  challenge(scope: OrderSessionScope, now = Math.floor(Date.now() / 1000)) {
    const intent: Intent = { ...scope, nonce: randomBytes(16).toString('hex'), issuedAt: now, expiresAt: now + 300 };
    const payload = Buffer.from(JSON.stringify(intent)).toString('base64url');
    return { ...intent, message: orderSessionMessage(intent), token: `${payload}.${this.mac('challenge', payload)}` };
  }
  async restore(proof: unknown, scope: OrderSessionScope, now = Math.floor(Date.now() / 1000)) {
    const p = proof as { token: string; signature: string };
    if (!p || Object.keys(p).sort().join() !== 'signature,token' || typeof p.token !== 'string' || p.token.length > 4096 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(p.token) || typeof p.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(p.signature)) throw Error('invalid session proof');
    const [payload, mac] = p.token.split('.') as [string, string];
    if (!this.matches(mac, this.mac('challenge', payload))) throw Error('untrusted session challenge');
    const bytes = Buffer.from(payload, 'base64url');
    const intent = JSON.parse(bytes.toString('utf8')) as Intent;
    const { nonce, issuedAt, expiresAt, ...bound } = intent;
    if (bytes.toString('base64url') !== payload || JSON.stringify(intent) !== bytes.toString('utf8') ||
      JSON.stringify(bound) !== JSON.stringify(scope) || !/^[a-f0-9]{32}$/.test(nonce) || !Number.isSafeInteger(issuedAt) ||
      expiresAt !== issuedAt + 300 || now < issuedAt || now >= expiresAt) throw Error('session challenge expired or scope differs');
    const signature = Buffer.from(p.signature, 'base64');
    if (signature.toString('base64') !== p.signature || !await verifySignature(await getPublicKeyFromAddress(scope.payer),
      signature as unknown as SignatureBytes, new TextEncoder().encode(orderSessionMessage(intent)))) throw Error('original payer signature required');
    // Replaying this access-only consent cannot extend its absolute session life.
    const sessionExpiry = issuedAt + lifetime;
    const prefix = `${scope.order}.r1.${sessionExpiry}.${nonce}`;
    return { cookie: `${prefix}.${this.mac('cookie', JSON.stringify(scope) + '\0' + prefix)}`, expiresAt: sessionExpiry };
  }
  accepts(cookie: string, scope: OrderSessionScope, now = Math.floor(Date.now() / 1000)) {
    if (cookie.length > 256) return false;
    const parts = cookie.split('.');
    if (parts.length !== 5 || parts[0] !== scope.order || parts[1] !== 'r1' || !/^[0-9]{1,12}$/.test(parts[2]!) ||
      !/^[a-f0-9]{32}$/.test(parts[3]!) || !/^[A-Za-z0-9_-]{43}$/.test(parts[4]!)) return false;
    const expiresAt = Number(parts[2]);
    return expiresAt > now && expiresAt <= now + lifetime && this.matches(parts[4]!, this.mac('cookie', JSON.stringify(scope) + '\0' + parts.slice(0, 4).join('.')));
  }
}
