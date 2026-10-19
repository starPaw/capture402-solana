import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buy } from '../buyer.mjs';
import { MAXIMUM, MINT, paymentClient, PRICE, report, Store, tool } from '../common.mjs';
import { Merchant } from '../merchant.mjs';

const rows = [{ id: 'a', category: 'compute', amount: '9007199254740993' }, { id: 'a', category: 'data', amount: '2' }];
const intent = 'synthetic-intent-0001';
const args = { intent, mandateId: 'm-1', rows };
const ok = value => ({ structuredContent: { ok: true, ...value } });
function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'capture402-merchant-test-'));
  const store = new Store(dir);
  let captures = 0;
  const hold = { id: 'h-1', payer: 'buyer-test', payee: 'seller-test', mint: MINT, maximum: MAXIMUM,
    held: MAXIMUM, captured: '0', refunded: '0', captureDeadline: Math.floor(Date.now() / 1000) + 100, ...options.hold };
  const payments = { async callTool({ name }) {
    if (name === 'get_mandate') return ok({ mandate: { payer: 'buyer-test' }, holds: [hold] });
    assert.equal(name, 'capture'); captures++;
    if (options.lostReply) throw Error('synthetic lost reply after send');
    Object.assign(hold, { held: '0', captured: PRICE });
    return ok({ hold, txSig: 'mock-tx-2' });
  } };
  const merchant = new Merchant({ store, payments, payer: 'buyer-test', merchant: 'seller-test' });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { merchant, store, dir, captures: () => captures };
}

test('report preserves integer precision and exposes duplicate rows without silently deduplicating totals', () => {
  const artifact = report(rows).artifact;
  const parsed = JSON.parse(artifact.utf8);
  assert.equal(parsed.total, '9007199254740995');
  assert.deepEqual(parsed.duplicateIds, ['a']);
  assert.deepEqual(parsed.categories, { compute: '9007199254740993', data: '2' });
  assert.deepEqual(report(rows).artifact, artifact);
  assert.throws(() => report([{ id: 'a', category: 'data', amount: '-1' }]), /INVALID_ROWS/);
});

test('quotes bind the original intent to exact input and mandate', t => {
  const f = fixture(t);
  assert.deepEqual(f.merchant.quote(args), f.merchant.quote(args));
  assert.throws(() => f.merchant.quote({ ...args, mandateId: 'm-2' }), /INTENT_CONFLICT/);
  assert.throws(() => f.merchant.quote({ ...args, rows: [rows[0]] }), /INTENT_CONFLICT/);
  assert.equal(f.captures(), 0);
});

test('foreign merchant or changed hold terms refuse before capture', async t => {
  const f = fixture(t, { hold: { payee: 'another-seller' } });
  const quote = f.merchant.quote(args);
  await assert.rejects(f.merchant.purchase({ orderId: quote.orderId, holdId: 'h-1' }), /PAYMENT_TERMS_DIFFER/);
  assert.equal(f.captures(), 0);
});

test('identical artifact survives restart and redelivery never recaptures', async t => {
  const f = fixture(t), quote = f.merchant.quote(args);
  const first = await f.merchant.purchase({ orderId: quote.orderId, holdId: 'h-1' });
  assert.equal(first.receipt.released, '350000');
  assert.equal(f.captures(), 1);
  f.store.close();
  const restored = new Store(f.dir);
  try {
    const m = new Merchant({ store: restored, payments: { callTool() { throw Error('no payment expected'); } }, payer: 'buyer-test', merchant: 'seller-test' });
    assert.deepEqual(await m.purchase({ orderId: quote.orderId, holdId: 'h-1' }), first);
    assert.deepEqual(m.status(quote.orderId).artifact, first.artifact);
  } finally { restored.close(); }
});

test('a consumed hold cannot purchase a second artifact', async t => {
  const f = fixture(t), one = f.merchant.quote(args), two = f.merchant.quote({ ...args, intent: 'synthetic-intent-0002' });
  await f.merchant.purchase({ orderId: one.orderId, holdId: 'h-1' });
  await assert.rejects(f.merchant.purchase({ orderId: two.orderId, holdId: 'h-1' }), /HOLD_ALREADY_BOUND/);
  assert.equal(f.captures(), 1);
});

test('lost capture response retains original pending record and blocks all new purchases after restart', async t => {
  const f = fixture(t, { lostReply: true }), quote = f.merchant.quote(args);
  await assert.rejects(f.merchant.purchase({ orderId: quote.orderId, holdId: 'h-1' }), /NO_RETRY/);
  assert.equal(f.merchant.status(quote.orderId).artifact, undefined);
  await assert.rejects(f.merchant.purchase({ orderId: quote.orderId, holdId: 'h-1' }), /UNRESOLVED/);
  assert.equal(f.captures(), 1);
  f.store.close();
  const restored = new Store(f.dir);
  try {
    const m = new Merchant({ store: restored, payments: {}, payer: 'buyer-test', merchant: 'seller-test' });
    assert.throws(() => m.quote({ ...args, intent: 'synthetic-intent-0002' }), /UNRESOLVED/);
    assert.equal(restored.all()[0].stage, 'capture_pending');
  } finally { restored.close(); }
});

test('post-capture persistence failure withholds delivery and never retries', async t => {
  const f = fixture(t), quote = f.merchant.quote(args), save = f.store.save.bind(f.store);
  f.store.save = record => { if (record.stage === 'done') throw Error('synthetic fsync failure'); save(record); };
  await assert.rejects(f.merchant.purchase({ orderId: quote.orderId, holdId: 'h-1' }), /NO_RETRY/);
  assert.equal(f.store.read(quote.orderId).stage, 'capture_pending');
  await assert.rejects(f.merchant.purchase({ orderId: quote.orderId, holdId: 'h-1' }), /UNRESOLVED/);
  assert.equal(f.captures(), 1);
});

test('buyer lost hold reply cannot create a second hold on rerun', async t => {
  const f = fixture(t), q = f.merchant.quote(args);
  let sends = 0;
  const request = { store: f.store, intent, mandateId: 'm-1', payer: 'buyer-test', payee: 'seller-test', rows,
    merchant: { callTool: async () => ok(q) }, payments: { callTool: async () => { sends++; throw Error('lost hold response'); } } };
  await assert.rejects(buy(request), /NO_RETRY/);
  await assert.rejects(buy(request), /UNRESOLVED/);
  assert.equal(sends, 1);
});

test('devnet profile refuses before any network request or payment', async () => {
  await assert.rejects(paymentClient({ PAYMENT_PROFILE: 'devnet', PAYMENT_MCP_URL: 'http://127.0.0.1:1/mcp' }), /LIVE_BLOCKED/);
});

test('actual SingIt mock HTTP → merchant stdio MCP → buyer workflow, duplicate delivery and exact accounting', { skip: !process.env.SINGIT_CHECKOUT }, async t => {
  const checkout = process.env.SINGIT_CHECKOUT;
  const root = mkdtempSync(join(tmpdir(), 'capture402-mcp-test-'));
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const upstream = spawn(process.execPath, [join(checkout, 'singit-mcp/node_modules/tsx/dist/cli.mjs'), join(checkout, 'singit-mcp/src/index.ts'), '--http'],
    { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(port), SINGIT_BACKEND: 'mock' }, stdio: ['ignore', 'ignore', 'ignore'] });
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, PAYMENT_PROFILE: 'mock', PAYMENT_MCP_URL: `http://127.0.0.1:${port}/mcp`,
    REPORT_PAYER: 'buyer-agent', REPORT_MERCHANT: 'seller-agent', MERCHANT_STATE_DIR: join(root, 'merchant') };
  let payments, merchant, buyerStore;
  t.after(async () => { await merchant?.close().catch(() => {}); await payments?.close().catch(() => {}); buyerStore?.close(); upstream.kill('SIGTERM'); rmSync(root, { recursive: true, force: true }); });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) { ready = true; break; } } catch {}
    if (upstream.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.ok(ready, 'external SingIt mock entrypoint must start');
  payments = await paymentClient(env);
  // Human mandate setup belongs to the test/operator, never the buyer/merchant tools.
  const issued = await tool(payments, 'create_mandate', { actor: 'buyer-agent', payer: 'buyer-agent', totalBudget: '2000000', perTxCap: MAXIMUM,
    expiresAt: Math.floor(Date.now() / 1000) + 300, allowedCounterparties: ['seller-agent'] });
  merchant = new Client({ name: 'fixture-buyer', version: '0.1.0' });
  await merchant.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../merchant.mjs', import.meta.url))], env, stderr: 'pipe' }));
  buyerStore = new Store(join(root, 'buyer'));
  const request = { payments, merchant, store: buyerStore, intent, mandateId: issued.mandate.id, payer: 'buyer-agent', payee: 'seller-agent', rows };
  const first = await buy(request);
  assert.equal(first.stage, 'done');
  assert.equal(JSON.parse(first.artifact.utf8).total, '9007199254740995');
  assert.deepEqual(await buy(request), first);
  assert.deepEqual(await tool(merchant, 'get_report', { orderId: first.orderId }), first);
  const state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
  assert.equal(state.ops.length, 2);
  assert.deepEqual(state.ops.map(op => op.action).sort(), ['capture', 'hold']);
  assert.equal(state.holds[0].held, '0');
  assert.equal(state.holds[0].captured, PRICE);
  assert.equal(state.mandates[0].mandate.committed, PRICE);
  await merchant.close();
  const cliEnv = { ...env, BUYER_STATE_DIR: join(root, 'buyer-cli') };
  async function runCli() {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../buyer.mjs', import.meta.url)), fileURLToPath(new URL('../sample.json', import.meta.url)),
      issued.mandate.id, 'synthetic-cli-intent-0002'], { env: cliEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const exit = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    assert.equal(exit, 0, stderr);
    return JSON.parse(stdout);
  }
  const cliFirst = await runCli();
  assert.equal(JSON.parse(cliFirst.artifact.utf8).total, '2800');
  assert.deepEqual(await runCli(), cliFirst);
  const afterCli = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
  assert.equal(afterCli.ops.length, 4, 'one additional hold/capture for the new CLI intent; none for replay');
  assert.equal(afterCli.mandates[0].mandate.committed, '1300000');
});
