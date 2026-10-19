import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, openSync, closeSync, writeFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { paymentClient, tool, MAXIMUM, MINT } from './common.mjs';
import { runCodexBuyer } from './codex-buyer.mjs';

/** Disposable mock ledger only. A new backend is never advertised as recovered history. */
export async function mockLlm(checkout, root) {
  if (!isAbsolute(checkout ?? '') || !isAbsolute(root ?? '')) throw Error('ABSOLUTE_SOURCE_AND_PRIVATE_RUN_REQUIRED');
  if (execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: checkout, encoding: 'utf8' }).trim() !==
      'https://github.com/bubon-ik/singit-agent-pay.git') throw Error('SINGIT_SOURCE_REQUIRED');
  for (let parent = root; ; parent = dirname(parent)) {
    // Check using git without discovering or touching a wallet/runtime.
    try { execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: parent, stdio: 'ignore' }); throw Error('PRIVATE_RUN_REQUIRED'); }
    catch (error) { if (error.message === 'PRIVATE_RUN_REQUIRED') throw error; }
    if (parent === dirname(parent)) break;
  }
  mkdirSync(root, { mode: 0o700 }); // Never reuse a run or replace its evidence.
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const buyerToken = randomUUID(), merchantToken = randomUUID(), humanSecret = randomUUID();
  const base = `http://127.0.0.1:${port}`;
  const log = openSync(join(root, 'payment-service.log'), 'wx', 0o600);
  const upstream = spawn(process.execPath, [join(checkout, 'singit-mcp/node_modules/tsx/dist/cli.mjs'), join(checkout, 'singit-mcp/src/index.ts'), '--http'],
    { cwd: checkout, env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(port), SINGIT_BACKEND: 'mock',
      SINGIT_BUYER_TOKEN: buyerToken, SINGIT_MERCHANT_TOKEN: merchantToken, SINGIT_HUMAN_ROUTE_SECRET: humanSecret,
      SINGIT_PAYER_ADDRESS: 'buyer-agent', SINGIT_MERCHANT_ADDRESS: 'seller-agent' }, stdio: ['ignore', 'ignore', log] });
  let client;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${base}/health`)).ok) { ready = true; break; } } catch {}
      if (upstream.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!ready) throw Error('MOCK_STARTUP_FAILED');
    // Only this trusted operator step holds the human route secret.
    const issued = await fetch(`${base}/human/mandate`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-singit-human-secret': humanSecret },
      body: JSON.stringify({ payer: 'buyer-agent', totalBudget: MAXIMUM, perTxCap: MAXIMUM,
        expiresAt: Math.floor(Date.now() / 1000) + 1800, allowedCounterparties: ['seller-agent'] }) });
    const body = await issued.json();
    if (!issued.ok || !body.ok) throw Error('MANDATE_ISSUANCE_STOPPED');
    const environment = { PAYMENT_PROFILE: 'mock', PAYMENT_MCP_URL: `${base}/mcp`, REPORT_PAYER: 'buyer-agent',
      REPORT_MERCHANT: 'seller-agent', BUYER_STATE_DIR: join(root, 'buyer'), MERCHANT_STATE_DIR: join(root, 'merchant'),
      SINGIT_BUYER_TOKEN: buyerToken, SINGIT_MERCHANT_TOKEN: merchantToken };
    const configPath = join(root, 'buyer-run.json');
    writeFileSync(configPath, JSON.stringify({ schema: 1, environment, mandateId: body.mandate.id,
      intent: 'expense-report-mock-intent-v1', inputPath: fileURLToPath(new URL('./sample.json', import.meta.url)),
      evidenceDir: join(root, 'model') }), { mode: 0o600, flag: 'wx' });
    const result = await runCodexBuyer(configPath);
    const state = await (await fetch(`${base}/api/state`)).json();
    writeFileSync(join(root, 'payment-state.json'), JSON.stringify(state, null, 2), { mode: 0o600, flag: 'wx' });
    if (state.ops.length !== 2 || state.ops.some(op => op.state !== 'succeeded') ||
        state.holds[0]?.held !== '0' || state.holds[0]?.captured !== '650000' ||
        state.mandates[0]?.mandate.committed !== '650000') throw Error('MOCK_ACCOUNTING_DIFFERS');
    client = await paymentClient(environment, 'buyer');
    const mustRefuse = async (name, args, code) => {
      try { await tool(client, name, args); } catch (error) { if (error.message === code) return; throw error; }
      throw Error('REFUSAL_MISSING');
    };
    await mustRefuse('hold', { actor: 'buyer-agent', mandateId: body.mandate.id, payee: 'seller-agent', amount: '450000',
      mint: MINT, idempotencyKey: 'mock-negative-over-budget' }, 'OVER_BUDGET');
    await mustRefuse('capture', { actor: 'seller-agent', holdId: state.holds[0].id, amount: '1', releaseRemainder: true,
      idempotencyKey: 'mock-negative-buyer-capture' }, 'PRINCIPAL_FORBIDDEN');
    const after = await (await fetch(`${base}/api/state`)).json();
    if (after.ops.length !== 2) throw Error('NEGATIVE_CASE_SENT_OPERATION');
    const trace = readFileSync(result.tracePath, 'utf8');
    if ([buyerToken, merchantToken, humanSecret].some(secret => trace.includes(secret))) throw Error('TRACE_CREDENTIAL_LEAK');
    writeFileSync(join(root, 'negative-results.json'), JSON.stringify({ overBudget: 'refused', buyerCapture: 'refused',
      operationsBefore: 2, operationsAfter: 2, credentialLeak: false, profile: 'mock' }), { mode: 0o600, flag: 'wx' });
    return result;
  } finally { await client?.close().catch(() => {}); upstream.kill('SIGTERM'); closeSync(log); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  mockLlm(...process.argv.slice(2)).then(() => console.log('Mock LLM run complete; all evidence remains private.'))
    .catch(() => { console.error('Mock LLM run stopped; preserve this run and its original records.'); process.exitCode = 1; });
}
