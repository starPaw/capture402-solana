import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { digest, MAXIMUM, MINT, normalizeRows, paymentClient, PRICE, Store, tool } from './common.mjs';

const activeStores = new WeakSet();

export async function buy({ payments, merchant, store, intent, mandateId, payer, payee, rows }) {
  if (!/^[A-Za-z0-9._:-]{16,128}$/.test(intent)) throw Error('STABLE_INTENT_REQUIRED');
  const input = normalizeRows(rows);
  const id = digest(['buyer-report-v1', payer, intent]);
  const commitment = digest([mandateId, payer, payee, input]);
  let record = store.read(id);
  if (record && record.commitment !== commitment) throw Error('INTENT_CONFLICT');
  if (record?.stage === 'done') return record.result;
  if (record || store.blocked || activeStores.has(store)) throw Error('ORIGINAL_OPERATION_UNRESOLVED');
  activeStores.add(store); // Own this store before the first await, including for other intents.
  try {
    const quote = await tool(merchant, 'quote_report', { intent, mandateId, rows: input });
    if (quote.payer !== payer || quote.merchant !== payee || quote.mint !== MINT || quote.maximum !== MAXIMUM ||
        quote.price !== '650000' || quote.inputSha256 !== digest(input)) throw Error('QUOTE_DIFFERS');
    record = { schema: 1, id, commitment, stage: 'hold_pending', quote };
    store.save(record);
    try {
      const held = await tool(payments, 'hold', { actor: payer, mandateId, payee, amount: MAXIMUM,
        mint: MINT, idempotencyKey: `report:${quote.orderId}:hold` });
      if (typeof held.hold?.id !== 'string') throw Error('HOLD_UNPROVEN');
      record.holdId = held.hold.id;
      record.stage = 'purchase_pending'; store.save(record);
      const result = await tool(merchant, 'purchase_report', { orderId: quote.orderId, holdId: record.holdId });
      if (result.orderId !== quote.orderId || result.stage !== 'done' || result.receipt?.profile !== 'mock' ||
          result.receipt?.holdId !== record.holdId || result.receipt?.grossCaptured !== PRICE || result.receipt?.released !== '350000' ||
          result.artifact?.sha256 !== quote.artifactSha256 ||
          typeof result.artifact?.utf8 !== 'string' || createHash('sha256').update(result.artifact.utf8).digest('hex') !== result.artifact.sha256) throw Error('ARTIFACT_DIFFERS');
      record.stage = 'done'; record.result = result; store.save(record);
      return result;
    } catch {
      store.blocked = true;
      throw Error('PURCHASE_UNRESOLVED_NO_RETRY');
    }
  } finally { activeStores.delete(store); }
}

async function main() {
  const [inputPath, mandateId, intent] = process.argv.slice(2);
  if (!inputPath || !mandateId || !intent) throw Error('INPUT_MANDATE_INTENT_REQUIRED');
  const payments = await paymentClient(process.env);
  const store = new Store(process.env.BUYER_STATE_DIR);
  const merchant = new Client({ name: 'expense-report-buyer', version: '0.1.0' });
  // The merchant subprocess receives only its mock endpoint/roles/store, no wallet or human secrets.
  const env = Object.fromEntries(['PATH', 'HOME', 'PAYMENT_PROFILE', 'PAYMENT_MCP_URL', 'MERCHANT_STATE_DIR', 'REPORT_PAYER', 'REPORT_MERCHANT']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  try {
    await merchant.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./merchant.mjs', import.meta.url))], env, stderr: 'pipe' }));
    const result = await buy({ payments, merchant, store, intent, mandateId, payer: process.env.REPORT_PAYER,
      payee: process.env.REPORT_MERCHANT, rows: JSON.parse(readFileSync(inputPath, 'utf8')) });
    console.log(JSON.stringify(result));
  } finally { await merchant.close().catch(() => {}); await payments.close().catch(() => {}); store.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Buyer stopped; preserve original intent and private state. No automatic retry.'); process.exit(1); });
}
