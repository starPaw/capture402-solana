import { operationalValue, DEPLOYMENT_RECORD_PATH } from '../src/operational-data.ts';
// Separate operator entry point: never defaults to historical dev, never starts services.
import { createDurableFile } from '../src/durable-file.ts';
import { credentialDirectory, validatePreSignerContinuation, type PreSignerStop } from './p2-presigner-stop.ts';
import { CampaignBudget, type CampaignPolicy } from '../src/campaign-budget.ts';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { isAddress } from '@solana/kit';
import { loadDeploymentRecord } from '../src/deployment-record.ts';
import { loadKeypair } from './lib.ts';
import { acceptedApplicationRelease, E2E_BUDGET, E2EProvisioner, ProvisionStore, validatePlan, type ProvisionPlan } from './e2e-provisioning.ts';
const PRIVATE = '/etc/capture402-e2e';
const SETUP = '/var/lib/capture402-e2e/setup';
const BUDGET = '/var/lib/capture402-e2e/facilitator/campaign-budget';
export function provisionArguments(args: string[]) {
  if (args.length !== 3 || args[1] !== '--profile' || args[2] !== 'e2e' || !['accept-funding', 'assets', 'observe-funding', 'observe-assets', 'init-budget', 'budget-status', 'plan-assets', 'continue-assets-presigner-stop'].includes(args[0]!)) throw Error('expected accept-funding|assets|observe-funding|observe-assets|init-budget|budget-status --profile e2e');
  return args[0] as 'accept-funding' | 'assets' | 'observe-funding' | 'observe-assets' | 'init-budget' | 'budget-status' | 'plan-assets' | 'continue-assets-presigner-stop';
}
function protectedPath(path: string, mode?: number): void {
  let current = path;
  for (;;) {
    const s = lstatSync(current);
    if (s.isSymbolicLink() || s.uid !== 0 || (s.mode & 0o022) || (!s.isFile() && !s.isDirectory())) throw Error('untrusted operator input ancestry');
    if (current === path && (mode !== undefined && (s.mode & 0o777) !== mode || s.isFile() && s.nlink !== 1)) throw Error('unsafe operator input metadata');
    if (dirname(current) === current) break;
    current = dirname(current);
  }
}
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
export { rpcBackend } from '../src/provision-rpc.ts';
import { rpcBackend } from '../src/provision-rpc.ts';

async function setupSigner(role: 'sponsor' | 'mint') {
  // PID 1 loads only these two approved sources for the assets unit. Original key
  // custody is verified before launch; the key directory is hidden in the unit.
  const directory = credentialDirectory(process.env.CREDENTIALS_DIRECTORY);
  const path = `${directory}/${role}-key`;
  protectedPath(path, 0o400);
  return await loadKeypair(path);
}
async function main(): Promise<void> {
  const E2E_APPLICATION_RELEASE=acceptedApplicationRelease();
  const RELEASE=`/opt/capture402-e2e/releases/${E2E_APPLICATION_RELEASE}`;
  const ACCEPTED_EXTERNAL_FUNDING=operationalValue<ProvisionPlan['externalFunding']>('acceptedExternalFunding');
  const action = provisionArguments(process.argv.slice(2));
  if (process.getuid?.() !== 0) throw Error('trusted isolated operator session required');
  if (!/^[a-f0-9]{32}$/.test(process.env.INVOCATION_ID ?? '') || !/^CapEff:\s+0+$/m.test(readFileSync('/proc/self/status','utf8'))) throw Error('zero-capability systemd compartment required');
  protectedPath(`${PRIVATE}/provision-approved.json`, 0o600);
  protectedPath(`${PRIVATE}/b1-complete.json`, 0o600);
  protectedPath(`${PRIVATE}/identities.json`, 0o600);
  protectedPath(SETUP, 0o700); protectedPath(RELEASE);
  const approved = JSON.parse(readFileSync(`${PRIVATE}/provision-approved.json`, 'utf8'));
  const complete = JSON.parse(readFileSync(`${PRIVATE}/b1-complete.json`, 'utf8'));
  const ids = JSON.parse(readFileSync(`${PRIVATE}/identities.json`, 'utf8'));
  if (approved.applicationRelease !== E2E_APPLICATION_RELEASE || complete.release !== E2E_APPLICATION_RELEASE || complete.status !== 'OFFLINE_B1_VERIFIED_B2_B3_NOT_RUN') throw Error('accepted B1/release receipt required');
  if (approved.b1ReceiptSha256 !== digest(`${PRIVATE}/b1-complete.json`) || approved.identitiesSha256 !== digest(`${PRIVATE}/identities.json`)) throw Error('approved custody evidence mismatch');
  const ownPath = realpathSync(new URL(import.meta.url)), corePath = realpathSync(new URL('./e2e-provisioning.ts', import.meta.url));
  for (const [path, expected] of [[ownPath, approved.entrypointSha256], [corePath, approved.coreSha256]]) {
    protectedPath(path!);
    if (digest(path!) !== expected) throw Error('operator executable approval mismatch');
  }
  const permission = approved.actions?.[action];
  if (typeof permission !== 'string' || !permission.trim()) throw Error('exact operator action approval missing');
  if (!isAddress(approved.browser)) throw Error('approved browser public key required');
  const plan: ProvisionPlan = { applicationRelease: E2E_APPLICATION_RELEASE, approvalReference: approved.campaignReference,
    sponsor: ids.sponsor, merchant: ids.merchant, payer: ids.payer, mint: ids.mint, browser: approved.browser, externalFunding: ACCEPTED_EXTERNAL_FUNDING };
  validatePlan(plan);
  if (plan.sponsor !== operationalValue<string>('sponsorAddress') || plan.browser !== operationalValue<string>('browserAddress') || approved.spendLimit !== '1000000000' || approved.assetsMaximumSpend !== '15640160') throw Error('owner funding/spending policy mismatch');
  for (const role of ['sponsor', 'merchant', 'payer', 'mint']) if (ids[role] !== complete.public_ids?.[role]) throw Error('B1 public identity receipt changed');
  const record = loadDeploymentRecord(DEPLOYMENT_RECORD_PATH);
  const policy: CampaignPolicy = {schema: 1, reference: plan.approvalReference, genesisHash: record.network.genesisHash, sponsor: plan.sponsor, browser: plan.browser, spendLimit: '1000000000'};
  if (action === 'init-budget') { protectedPath(BUDGET, 0o700); createDurableFile(`${SETUP}/campaign-budget-init-intent.json`,JSON.stringify(policy)); CampaignBudget.initialize(BUDGET, policy); console.log('CAMPAIGN_BUDGET_INITIALIZED'); return; }
  const budget = new CampaignBudget(BUDGET, policy);
  if (action === 'budget-status') { console.log(JSON.stringify(budget.summary(), (_k,x)=>typeof x==='bigint'?String(x):x)); return; }
  const provisioner = new E2EProvisioner(plan, new ProvisionStore(SETUP), rpcBackend(record), record.network.genesisHash, budget);
  if (action === 'plan-assets') {
    const q = await provisioner.quoteAssets();
    console.log(JSON.stringify({status:'UNSIGNED_PLAN_ONLY',browserAta:q.browserAta,merchantAta:q.merchantAta,quote:{mintRent:q.mintRent,tokenRent:q.tokenRent,fee:q.fee,spend:q.spend,reservationCeiling:q.mintRent+2n*q.tokenRent+E2E_BUDGET.browserSol+E2E_BUDGET.maximumSetupFee,actionCeiling:E2E_BUDGET.maximumAssetsRent+E2E_BUDGET.browserSol+E2E_BUDGET.maximumSetupFee},preSlot:q.pre.slot},(_k,x)=>typeof x==='bigint'?String(x):x));return;
  }
  if (action === 'accept-funding') await provisioner.acceptFunding();
  else if (action === 'assets') await provisioner.assets(async () => ({ sponsor: await setupSigner('sponsor'), mint: await setupSigner('mint') }));
  else if (action === 'continue-assets-presigner-stop') {
    const stopPath = `${PRIVATE}/p2-presigner-stop.json`; protectedPath(stopPath, 0o600);
    if (typeof approved.preSignerStopSha256 !== 'string' || digest(stopPath) !== approved.preSignerStopSha256) throw Error('approved specific stop attestation required');
    const continuation = { stop: JSON.parse(readFileSync(stopPath, 'utf8')) as PreSignerStop, attestationSha256: approved.preSignerStopSha256, ownerApprovalReference: permission };
    validatePreSignerContinuation(continuation);
    await provisioner.assets(async () => ({ sponsor: await setupSigner('sponsor'), mint: await setupSigner('mint') }), continuation);
  }
  const result = await provisioner.observe(action.endsWith('funding') ? 'external-funding' : 'assets');
  console.log(JSON.stringify(result, (_k,x)=>typeof x==='bigint'?String(x):x));
  if (result.status !== 'FINALIZED_SUCCEEDED') process.exitCode = 2;
}
if (process.argv[1]?.endsWith('e2e-provision.ts')) main().catch(() => {
  console.error('E2E provisioning stopped. Preserve all reservations and original wires; observe only, never resend or regenerate.');
  process.exitCode = 1;
});
