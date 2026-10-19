// Rerun the original exploit assertions against the fixed checkout. Expected failures
// must be the two specific security refusals, not setup errors or test timeouts.
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
const target = join(root, 'test/capability-wallet-probe.test.ts');
let source = readFileSync(new URL('./capability-wallet-attacks.test.ts.txt', import.meta.url), 'utf8');
function replaceOnce(before, after) {
  if (source.split(before).length !== 2) throw new Error('Original reproduction fixture changed');
  source = source.replace(before, after);
}
// Only session setup changes: the attack still uses the original cross-site GET.
replaceOnce('app.request(`${origin}/resource?payer=${h.payer.address}&scenario=${scenario}`)',
  'app.request(`${origin}/api/orders`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ payer: h.payer.address, scenario }) })');
// Bound the deliberately ignored connect, so exploit refusal cannot hang a test.
replaceOnce('const connection = await connectionPromise;',
  'const connection = await Promise.race([connectionPromise, new Promise((_, reject) => setTimeout(() => reject(new Error("forged connect did not resolve the SDK connection")), 100))]);');
// Model DOM attachment for the trusted teardown; the forged source remains null.
replaceOnce('const frame = { style: {}, contentWindow:', 'const frame = { isConnected: true, style: {}, contentWindow:');
// Tear down the actual SDK listener/interval using a trusted fixture message.
replaceOnce('    vi.unstubAllGlobals();',
  `    events.dispatchEvent(Object.assign(new Event("message"), { origin: "https://connect.solflare.com", source: frame.contentWindow, data: { channel: "solflareIframeToWalletAdapter", data: { type: "event", event: { type: "disconnect" } } } }));
    vi.unstubAllGlobals();`);
writeFileSync(target, source, { flag: 'wx' });
try {
  const result = spawnSync('npm', ['test', '--', 'test/capability-wallet-probe.test.ts'], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  const output = result.stdout + result.stderr;
  if (result.error || result.status !== 1 || !/Tests\s+2 failed \(2\)/.test(output) ||
      !output.includes('null and string') || !output.includes('forged connect did not resolve the SDK connection')) {
    process.stderr.write(output); throw new Error('Original exploits did not fail for the expected security reasons');
  }
  process.stdout.write(output);
  process.stdout.write('\nBoth capability and wallet exploit assertions failed for the expected reasons: no replacement cookie; forged connect ignored.\n');
} finally { unlinkSync(target); }
