import { selectedPaymentProfile, LEGACY_PROFILE, CIRCLE_PROFILE, circleApproval, profileHash, validateProfileRuntime, requireCircleRpc, requireProfileForTreasury, type PaymentProfile } from './payment-profile.ts';
import { circleCustodyGuard } from './circle-custody.ts';
import { operationalValue } from './operational-data.ts';
// Static presentation remains available before provisioning. An unconfigured backend returns
// 503; it never fabricates balances, receipts or signatures, or substitutes generated keys.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createKeyPairSignerFromBytes, type Address } from "@solana/kit";
import { getMintDecoder } from "@solana-program/token";
import { loadDeploymentRecord } from "./deployment-record.ts";
import { createRestaurantApp, RestaurantOrders, DEMO_BUDGET, type RestaurantConfig } from "./restaurant.ts";
import { DEMO_COMPUTE } from "./demo-compute.ts";
import { OperationStore } from "./operation-store.ts";
import { FileSubmissionJournal } from "./submission-journal.ts";
import { RpcLedger, cachedClusterClock } from "./rpc-ledger.ts";
import { TOKEN_PROGRAM_ADDRESS } from "./program.ts";
import { AdmissionJournal, loadAdmissionContract } from './admission-journal.ts';
import { selectedAbandonPolicies } from './authorize-abandon.ts';
import { selectedIsolationPolicy } from './unknown-authorize-isolation.ts';
import { e2eSponsor, requireE2eRuntimeRpc, trustedRuntimeFile } from './e2e-runtime-policy.ts';
import { validateProfileFaucet, type FaucetPolicy } from './devnet-faucet-store.ts';
import { devnetFaucetProxy } from './devnet-faucet-proxy.ts';
import { ata } from './program.ts';
import {validateMerchantDemoPolicy,merchantDemoPolicy} from './merchant-demo.ts';

export const DEMO_TIMING = { captureSeconds: 150, refundSecondsAfterCapture: 30 } as const;
const root = fileURLToPath(new URL("../web/", import.meta.url));
export function createPresentationApp(info: { programId: string; network: string; configured: boolean; reason?: string; sponsor?: string; merchant?: string; mint?: string; faucetEnabled?:boolean; publicMerchantDemoEnabled?:boolean; paymentProfile?:PaymentProfile; profileHash?:string }, backend?: Hono): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src https://connect.solflare.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    await next();
  });
  app.all("/assets/homepage.css", async (c, next) => { if (c.req.method !== "GET") return c.body(null, 405); await next(); });
  app.all("/assets/homepage.js", async (c, next) => { if (c.req.method !== "GET") return c.body(null, 405); await next(); });
  // Exact static destinations never fall through to the economic backend.
  for (const [route, file] of [["/integrate", "integrate.html"], ["/evidence", "evidence.html"], ["/assets/guide.css", "guide.css"]] as const) {
    app.all(route, c => {
      if (c.req.path !== route) return c.notFound();
      if (c.req.method !== "GET") return c.body(null, 405);
      c.header("Content-Type", `${file.endsWith(".css") ? "text/css" : "text/html"}; charset=utf-8`);
      return c.body(readFileSync(`${root}${file}`, "utf8"));
    });
  }
  app.get("/", c => c.html(readFileSync(`${root}homepage.html`, "utf8")));
  for (const route of ["/customer", "/merchant"]) app.get(route, c => c.html(readFileSync(`${root}index.html`, "utf8")));
  for (const [name, mime] of [["homepage.css", "text/css"], ["homepage.js", "text/javascript"], ["app.js", "text/javascript"], ["payment-profile.js", "text/javascript"], ["receipt-state.js", "text/javascript"], ["wallet.js", "text/javascript"], ["style.css", "text/css"], ["solflare.js", "text/javascript"], ["solflare.js.LEGAL.txt", "text/plain"]]) app.get(`/assets/${name}`, c => { c.header("Content-Type", `${mime}; charset=utf-8`); return c.body(readFileSync(`${root}${name}`)); });
  app.get("/api/config", c => c.json({ ...info, venue: "Capture402 payment lab", budget: Number((info.paymentProfile??LEGACY_PROFILE).budget)/1_000_000, decimals: 6, assetLabel: (info.paymentProfile??LEGACY_PROFILE).assetLabel, paymentProfile:info.paymentProfile??LEGACY_PROFILE, treasury:info.paymentProfile?.id===CIRCLE_PROFILE.id?info.sponsor:undefined, cluster: "devnet", walletChain: "solana:devnet", computeBudget: DEMO_COMPUTE, timing: DEMO_TIMING }));
  if (backend) app.route("/", backend);
  else { for (const pattern of ["/api/*", "/resource"]) app.all(pattern, c => c.json({ error: "Devnet demo awaits keypairs, six-decimal test mint and token funding." }, 503)); }
  return app;
}
export async function startRestaurant() {
  const profile=selectedPaymentProfile();
  const circle=profile.id===CIRCLE_PROFILE.id?circleApproval():undefined;
  const recordPath = process.env.SAC006_DEPLOYMENT_RECORD_PATH;
  if (!recordPath) throw new Error("SAC006_DEPLOYMENT_RECORD_PATH required");
  const record = loadDeploymentRecord(recordPath);
  const names = ["SOLANA_RPC_URL", "SAC006_BEARER_TOKEN", "SAC006_FACILITATOR_URL", "SAC006_FEE_PAYER", "SAC006_SERVER_KEYPAIR_PATH", "SAC006_STORE_DIR", "SAC006_ASSET_MINT"];
  const missing = names.filter(n => !process.env[n]);
  if (process.env.SAC006_SERVER_KEYPAIR_PATH && !existsSync(process.env.SAC006_SERVER_KEYPAIR_PATH)) missing.push("merchant key file");
  const info = { paymentProfile:profile,...(circle?{profileHash:profileHash(circle),mint:circle.mint,sponsor:circle.sponsor,merchant:circle.merchant}:{}), programId: record.programId, network: record.network.caip2, configured: false, reason: "Provisioning required" };
  let backend: Hono | undefined;
  let guardCustody=()=>{};
  if (missing.length === 0) {
    requireProfileForTreasury(profile,process.env.SAC006_FEE_PAYER as Address);
    if(circle && (record.programId!==circle.programId || record.network.genesisHash!==circle.genesisHash || record.network.caip2!==circle.network))throw Error("Circle deployment mismatch");
    if(circle){requireCircleRpc(process.env.SOLANA_RPC_URL!);requireE2eRuntimeRpc(process.env.SOLANA_RPC_URL!,record);
      guardCustody=circleCustodyGuard({resource:process.env.SAC006_STORE_DIR!,orders:`${process.env.SAC006_STORE_DIR}-restaurant`,
        reclaims:process.env.SAC006_RECLAIM_JOURNAL_DIR??'',orderAdmission:process.env.SAC006_E2E_ORDER_ADMISSION_DIR??''});}
    const e2e = !!circle || process.env.SAC006_FEE_PAYER === e2eSponsor() || process.env.SAC006_SERVER_KEYPAIR_PATH!.includes('/capture402-e2e/');
    if (e2e) requireE2eRuntimeRpc(process.env.SOLANA_RPC_URL!,record);
    const b3Recovery = e2e && process.env.SAC006_B3_RECOVERY_POLICY_PATH ? JSON.parse(trustedRuntimeFile(process.env.SAC006_B3_RECOVERY_POLICY_PATH)) : undefined;
    if (b3Recovery && JSON.stringify(b3Recovery)!==JSON.stringify(operationalValue('b3RecoveryPolicy'))) throw Error('B3 recovery policy exceeds selected operation');
    const authorizeAbandonPolicies=e2e && process.env.SAC006_B3_AUTHORIZE_ABANDON_POLICY_PATH ? selectedAbandonPolicies(JSON.parse(trustedRuntimeFile(process.env.SAC006_B3_AUTHORIZE_ABANDON_POLICY_PATH))) : undefined;
    const authorizeIsolationPolicy=e2e && process.env.SAC006_B3_AUTHORIZE_ISOLATION_POLICY_PATH ? JSON.parse(trustedRuntimeFile(process.env.SAC006_B3_AUTHORIZE_ISOLATION_POLICY_PATH)) : undefined;
    if(authorizeIsolationPolicy && (Object.keys(authorizeIsolationPolicy).sort().join()!==[...Object.keys(selectedIsolationPolicy()),'archiveSha256'].sort().join() ||
      Object.entries(selectedIsolationPolicy()).some(([k,v])=>authorizeIsolationPolicy[k]!==v) || !/^[a-f0-9]{64}$/.test(authorizeIsolationPolicy.archiveSha256)))throw Error('Unknown authorization isolation exceeds the selected original');
    const ledger = new RpcLedger({ deployment: record, network: record.network.caip2, genesisHash: record.network.genesisHash, rpcUrl: process.env.SOLANA_RPC_URL!, rpcMinIntervalMs:e2e?250:0 });
    await ledger.verifyGenesis();
    const server = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(process.env.SAC006_SERVER_KEYPAIR_PATH!, "utf8"))));
    const mint = await ledger.getAccount(process.env.SAC006_ASSET_MINT as Address);
    if (!mint || mint.owner !== TOKEN_PROGRAM_ADDRESS || mint.data.length !== getMintDecoder().fixedSize || !getMintDecoder().decode(mint.data).isInitialized || getMintDecoder().decode(mint.data).decimals !== 6) throw new Error("restaurant requires an initialized classic SPL mint with six decimals");
    const baseDir = process.env.SAC006_STORE_DIR!;
    let faucet;
    const faucetPolicyPath=process.env.SAC006_E2E_FAUCET_POLICY_PATH;
    if(circle && !faucetPolicyPath)throw Error("Circle faucet approval required");
    if(faucetPolicyPath) {
      if(!e2e)throw Error('faucet is restricted to the reviewed E2E campaign');
      const policy=JSON.parse(trustedRuntimeFile(faucetPolicyPath)) as FaucetPolicy;validateProfileFaucet(profile,policy);
      if(policy.mint!==process.env.SAC006_ASSET_MINT || policy.mint!==(circle?.mint ?? operationalValue<string>('mintAddress')) ||
        policy.sponsor!==(circle?.sponsor ?? e2eSponsor()) || policy.pool!==await ata(policy.sponsor,policy.mint) || policy.origin!==process.env.SAC006_PUBLIC_ORIGIN)throw Error('faucet policy exceeds existing E2E identities');
      faucet=devnetFaucetProxy(process.env.SAC006_FACILITATOR_URL!,process.env.SAC006_BEARER_TOKEN!,circle && policy.schema===2?{profileHash:profileHash(circle),mint:circle.mint,network:circle.network,treasury:circle.treasury,pool:policy.pool,amountAtomic:policy.amount}:undefined);
    }
    const config: RestaurantConfig = {
      merchantToken: process.env.SAC006_MERCHANT_TOKEN || undefined,
      facilitatorUrl: process.env.SAC006_FACILITATOR_URL!, bearerToken: process.env.SAC006_BEARER_TOKEN!, network: record.network.caip2, programId: record.programId,
      feePayer: process.env.SAC006_FEE_PAYER as Address, server, asset: process.env.SAC006_ASSET_MINT as Address, amount: BigInt(profile.budget), paymentProfile:profile,
      captureDeadlineSeconds: DEMO_TIMING.captureSeconds, refundDeadlineSeconds: DEMO_TIMING.refundSecondsAfterCapture,
      store: new OperationStore(baseDir), orders: new RestaurantOrders(`${baseDir}-restaurant`), ledger,
      verifyEconomicIdentity:circle?()=>ledger.verifyGenesis():undefined,
      reclaimJournal: new FileSubmissionJournal(process.env.SAC006_RECLAIM_JOURNAL_DIR ?? `${baseDir}-restaurant-reclaim`),
      origin: process.env.SAC006_PUBLIC_ORIGIN ?? operationalValue<string>('publicOrigin'), getLatestBlockhash: () => ledger.latestBlockhash(), now: cachedClusterClock(() => ledger.now()),
      ...(faucet?{faucet}:{}),
      handler: async () => { throw new Error("payment lab uses explicit lifecycle captures"); },
      ...(e2e ? { orderAdmission:new AdmissionJournal(process.env.SAC006_E2E_ORDER_ADMISSION_DIR!,'orders',Number(process.env.SAC006_E2E_MAX_ORDERS),loadAdmissionContract('orders',circle?'circle-usdc-v1':undefined)),
        ...(b3Recovery ? {b3Recovery} : {}),
        ...(authorizeAbandonPolicies ? {authorizeAbandonPolicies} : {}),
        ...(authorizeIsolationPolicy ? {authorizeIsolationPolicy} : {}),
        now:() => ledger.now() } : {}),
    };
    validateProfileRuntime(profile,config);
    const demoPolicyPath=process.env.SAC006_E2E_PUBLIC_MERCHANT_DEMO_POLICY_PATH;
    if(demoPolicyPath) {
      if(!e2e || process.env.SAC006_E2E_MAX_ORDERS!=='100')throw Error('public merchant demo restricted to bounded E2E');
      validateMerchantDemoPolicy(JSON.parse(trustedRuntimeFile(demoPolicyPath)),profile);
      const p=merchantDemoPolicy(profile);
      if(config.origin!==p.origin || config.network!==p.network || config.programId!==p.programId || config.feePayer!==p.sponsor || server.address!==p.merchant || config.asset!==p.mint)throw Error('public merchant demo runtime identity differs');
      config.publicMerchantDemo=true;
    }
    guardCustody();
    backend = createRestaurantApp(config); info.configured = true;
    Object.assign(info, { sponsor: config.feePayer, merchant: server.address, mint: config.asset, reason: undefined,...(faucet?{faucetEnabled:true}:{}),...(config.publicMerchantDemo?{publicMerchantDemoEnabled:true}:{}) });
  }
  console.log(missing.length ? `Restaurant UI available; missing configuration: ${missing.join(", ")}` : "Restaurant backend enabled against accepted Devnet deployment");
  const app=createPresentationApp(info, backend);
  serve({ fetch: (request,env)=>{
    try {guardCustody();} catch {return new Response('Circle custody unavailable',{status:503});}
    return app.fetch(request,env);
  }, hostname: process.env.SAC006_HOST ?? "127.0.0.1", port: Number(process.env.SAC006_RESOURCE_PORT ?? 8788) });
}
if (process.argv[1]?.endsWith("restaurant-server.ts")) startRestaurant().catch(() => { console.error("Restaurant startup stopped; verify private configuration and accepted Devnet identity."); process.exitCode = 1; });
