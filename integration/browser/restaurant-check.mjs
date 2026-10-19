// Browser/DOM fixtures only: no RPC, real wallets, usable signatures or broadcasts.
// Run in an isolated network namespace with existing Playwright and Chromium:
// RESTAURANT_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node browser/restaurant-check.mjs
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:https';
import { once } from 'node:events';
import { serve } from '@hono/node-server';
import { createPresentationApp } from '../src/restaurant-server.ts';
import { OrderSessionAccess } from '../src/order-session.ts';
const { chromium } = await import(pathToFileURL(process.env.RESTAURANT_PLAYWRIGHT_MODULE));
const temp = mkdtempSync(join(tmpdir(), 'capture402-dom-'));
const output = process.env.RESTAURANT_QA_OUTPUT || temp;
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', join(temp, 'key.pem'), '-out', join(temp, 'cert.pem')], { stdio: 'pipe' });
const info = { programId:'11111111111111111111111111111111', network:'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', configured:true, merchant:'11111111111111111111111111111111', mint:'11111111111111111111111111111111', sponsor:'11111111111111111111111111111111' };
const app = createPresentationApp(info); // No economic backend exists in this fixture.
const server = serve({ fetch:app.fetch, hostname:'127.0.0.1', port:0, createServer, serverOptions:{ key:readFileSync(join(temp,'key.pem')), cert:readFileSync(join(temp,'cert.pem')) } });
await once(server, 'listening');
const origin = `https://127.0.0.1:${server.address().port}`;
let browser;
const report = {  sourceSha256:Object.fromEntries(['index.html','style.css','app.js','wallet.js','receipt-state.js'].map(name=>[name,createHash('sha256').update(readFileSync(new URL('../web/'+name,import.meta.url))).digest('hex')])), scope:'Local HTTPS DOM fixtures; no Devnet, wallet signing or economic E2E claim.', browser:'', checks:[], viewports:[], requests:[] };
let lastActionBody, nextActionPreflight, definitiveResponse = false;
let renewalSequence=0;
let state, rpcFailure = false, posts = 0, gets = 0, loseResponse = false, delayPreflight = false, missingAuthority = false;
const secret = 'local-browser-fixture-credential-' + 'x'.repeat(32);
const id = 'a'.repeat(32);
const draft = () => ({ id, payer:info.merchant, payment:info.programId, scenario:'normal', status:'draft', authorized:0, captured:0, remaining:0, refunded:0, released:0, captureDeadline:Math.floor(Date.now()/1000)-5, refundDeadline:Math.floor(Date.now()/1000)+25, now:Math.floor(Date.now()/1000), events:[], actions:{beer:false,salmon:false,finish:false,void:false,refund:false,reclaim:false}, actionReasons:{beer:'Wallet approval is not finalized authorization.'}, balances:{payer:{amount:100,reason:''},merchant:{amount:0,reason:''}}, required:{accepts:[]}, unsigned:'unsigned-DOM-fixture-never-signed' });
const held = () => ({ ...draft(), status:'active', authorized:100, remaining:100, heldBaseUnits:'100000000', refundableBaseUnits:'0', captureDeadline:Math.floor(Date.now()/1000)+140, refundDeadline:Math.floor(Date.now()/1000)+170, actions:{beer:true,salmon:false,finish:false,void:true,refund:false,reclaim:false}, actionReasons:{beer:'',salmon:'Finalize capture 40 first.',finish:'Finalize captures 40 and 25 first.',void:'',refund:'No refundable captured balance.',reclaim:'Payer reclaim opens at the onchain capture deadline.'}, events:[{action:'authorize',label:'Local DOM authorize fixture',amount:100,at:new Date().toISOString(),status:'finalized',signature:'fixture-original-signature-not-onchain',chainStatus:{commitment:'finalized'}}] });
const check = name => report.checks.push(name);
try {
  browser = await chromium.launch({ headless:true }); report.browser = browser.version();
  const context = await browser.newContext({ ignoreHTTPSErrors:true, viewport:{width:1440,height:900} });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', req => { const u = new URL(req.url()); assert.equal(u.origin, origin, 'All runtime requests must be same origin'); assert(!req.url().includes(secret)); report.requests.push({path:u.pathname,method:req.method(),operatorBearer:!!req.headers().authorization}); });
  await page.route('**/api/orders**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (path === '/api/orders' && req.method() === 'POST') {
      posts++;
      const next = { ...draft(), id:'b'.repeat(32), captureDeadline:Math.floor(Date.now()/1000)+150, refundDeadline:Math.floor(Date.now()/1000)+180 };
      state = next;
      return route.fulfill({ status:402, contentType:'application/json', headers:{'PAYMENT-REQUIRED':Buffer.from(JSON.stringify(next.required)).toString('base64')}, body:JSON.stringify({order:next.id,unsigned:next.unsigned,required:next.required}) });
    }
    if(path.endsWith('/abandon-authorize') && req.method()==='POST') {
      posts++;state={...state,status:'abandoned',authorizeAbandonEligible:false,authorizeAbandoned:{kind:'expired-unfunded-authorize',order:state.id,payment:state.payment}};
      return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({abandoned:true,proof:{kind:'expired-unfunded-authorize',payment:state.payment}})});
    }
    if(path.endsWith('/reclaim-renewal') && req.method()==='POST') {
      posts++;const unsigned='renewed-DOM-fixture-never-signed-'+(++renewalSequence);state={...state,reclaimGeneration:createHash('sha256').update(unsigned).digest('hex'),reclaimDraftState:'ready',reclaimPreparation:false};
      return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({unsigned,payer:state.payer,proof:{kind:'expired-no-reclaim-effect'}})});
    }
    if (path.includes('/actions/')) {
      if (req.method() === 'GET') {
        gets++;
        if (nextActionPreflight) { state = nextActionPreflight; nextActionPreflight = undefined; }
        if (delayPreflight) await new Promise(resolve => setTimeout(resolve, 250));
        if (missingAuthority || req.headers().authorization !== `Bearer ${secret}`) return route.fulfill({status:401,contentType:'application/json',body:JSON.stringify({error:'fixture-refused'})});
        if (rpcFailure) return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'fixture-RPC-unavailable'})});
        return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...state,operatorAccess:true})});
      }
      posts++; lastActionBody = req.postData();
      if (loseResponse) return route.abort('failed');
      if (definitiveResponse) {
        const receipt={success:false,errorReason:'settlement_not_submitted',transaction:'',network:info.network,payer:state.payer};
        return route.fulfill({status:409,contentType:'application/json',headers:{'PAYMENT-RESPONSE':Buffer.from(JSON.stringify(receipt)).toString('base64')},body:JSON.stringify({receipt})});
      }
      return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({receipt:{success:false,errorReason:'settlement_pending',transaction:''}})});
    }
    return route.fulfill({status:rpcFailure?409:200,contentType:'application/json',body:JSON.stringify(rpcFailure?{error:'Finalized RPC state unavailable.'}:state)});
  });
  async function load(next, wallet = false) {
    nextActionPreflight = undefined; state = next; rpcFailure = false; posts = 0; gets = 0; loseResponse = false; missingAuthority = false; definitiveResponse = false;
    await page.goto(origin + '/customer');
    await page.evaluate(({state,id,wallet}) => {
      localStorage.clear(); if(state) localStorage.setItem('capture402-order',state.id);
      if(wallet) window.addEventListener('wallet-standard:app-ready', event => event.detail.register({name:'Local DOM wallet — cannot sign',features:{'standard:connect':{connect:async()=>({accounts:[{address:id,chains:['solana:devnet'],features:['solana:signTransaction']}]})},'solana:signTransaction':{supportedTransactionVersions:['legacy'],signTransaction:async()=>{window.fixtureSigns=(window.fixtureSigns||0)+1;throw new Error('DOM fixture cannot sign');}}}}), {once:true});
    }, {state:next,id:info.merchant,wallet});
    // Install registry before the module discovers wallets on the next navigation.
    await page.addInitScript(({wallet,id}) => { if(wallet) window.addEventListener('wallet-standard:app-ready', e=>e.detail.register({name:'Local DOM wallet — cannot sign',features:{'standard:connect':{connect:async()=>({accounts:[{address:id,chains:['solana:devnet'],features:['solana:signTransaction']}]})},'solana:signTransaction':{supportedTransactionVersions:['legacy'],signTransaction:async()=>{window.fixtureSigns=(window.fixtureSigns||0)+1;throw new Error('DOM fixture cannot sign');}}}}),{once:true}); }, {wallet,id:info.merchant});
    await page.reload();await page.locator('#advanced').evaluate(e=>e.open=true); if(next) await page.waitForFunction(()=>document.getElementById('payment-id').querySelector('a')); else await page.waitForFunction(()=>document.getElementById('clock-label').textContent.includes('no offer yet'));
  }
  await load(undefined);
  assert.equal(await page.locator('#clock').textContent(),'02:30'); assert(await page.locator('#authorize').isDisabled());
  assert((await page.locator('#authorize-reason').textContent()).includes('Connect')); check('Absent wallet, no offer: 02:30 and explicit disabled reason');
  assert.equal(await page.locator('img').count(),0); assert(!(await page.content()).includes('praguemarina.cz')); check('No photograph or external photo dependency');
  await load(held(), true);
  await page.locator('#connect-wallet').click(); await page.locator('#wallet-list button').first().click();
  assert.equal(await page.locator('#payer-key').textContent(),info.merchant); assert(await page.locator('[data-action=beer]').isDisabled());
  check('Connected payer wallet and original order grant no merchant authority');
  for (const [width,height] of [[1440,900],[1024,768],[768,1024],[390,844],[320,740]]) {
    await page.setViewportSize({width,height});
    await page.locator('#advanced').evaluate(e=>e.open=false);await page.evaluate(()=>scrollTo(0,0));
    const layout = await page.evaluate(() => ({scrollWidth:document.documentElement.scrollWidth,pageHeight:document.documentElement.scrollHeight,nextActionBottom:document.getElementById('next-action').getBoundingClientRect().bottom,receiptTop:document.getElementById('history-heading').getBoundingClientRect().top,advancedOpen:document.getElementById('advanced').open}));
    assert.equal(layout.scrollWidth,width,`${width}px horizontal overflow`);
    // Keep readable text instead of forcing the inspector and receipts above the fold.
    assert(layout.nextActionBottom<=height,`${width}px next action bottom ${layout.nextActionBottom} must fit ${height}px`);
    assert(await page.locator('#next-action').isVisible());
    report.viewports.push({width,height,...layout});
    if(width===1440||width===390||width===320) await page.screenshot({path:join(output,`restaurant-${width}.png`),fullPage:true});
  }
  await page.locator('#advanced').evaluate(e=>e.open=true);
  check('Responsive layout at five viewports and screenshot evidence');
  await page.setViewportSize({width:1440,height:900});
  const before = posts;
  await page.locator('#merchant-secret').fill('wrong-but-long-fixture-credential-000000'); await page.locator('#unlock-merchant').click();
  await page.waitForFunction(()=>document.getElementById('action-status').textContent.includes('no economic request'));
  assert.equal(posts,before); assert(await page.locator('[data-action=beer]').isDisabled()); assert.equal(await page.locator('#merchant-secret').inputValue(),'');
  check('Invalid credential uses GET only; clears input and never posts an economic action');
  async function unlock() { await page.locator('#merchant-secret').fill(secret); await page.locator('#unlock-merchant').click(); await page.waitForFunction(()=>document.getElementById('operator-status').textContent.includes('verified')); await page.waitForFunction(()=>!document.getElementById('unlock-merchant').disabled); }
  await unlock(); assert(!(await page.locator('[data-action=beer]').isDisabled())); assert(await page.locator('[data-action=salmon]').isDisabled());
  assert.equal(await page.locator('#merchant-secret').inputValue(),'');
  async function noSecretLeak() {
    const contents = await page.evaluate(()=>({html:document.documentElement.outerHTML,local:JSON.stringify(localStorage),session:JSON.stringify(sessionStorage),cookie:document.cookie,url:location.href}));
    for(const value of Object.values(contents)) assert(!value.includes(secret),'Credential must remain absent from DOM/storage/cookie/URL');
  }
  await noSecretLeak(); check('Verified operator unlock enables only eligible action; no secret in DOM or persistent storage');
  await page.locator('#lock-merchant').click(); assert(await page.locator('[data-action=beer]').isDisabled()); check('Explicit lock clears operator access');
  await unlock(); await page.reload();await page.locator('#advanced').evaluate(e=>e.open=true); await page.waitForFunction(()=>document.getElementById('payment-state').textContent.includes('Finalized'));
  assert(await page.locator('[data-action=beer]').isDisabled()); await noSecretLeak(); check('Navigation clears operator secret and access');
  await unlock(); missingAuthority = true;
  await page.locator('[data-action=beer]').click(); await page.waitForFunction(()=>document.getElementById('action-status').textContent.includes('credential refused'));
  assert.equal(posts,0); assert(await page.locator('[data-action=beer]').isDisabled()); check('Authority revoked before action preflight cannot produce an economic POST');
  missingAuthority = false;
  state.events[0].label = '<img src=x onerror="window.fixtureXss=true">';
  await page.locator('#refresh').click(); await page.waitForFunction(()=>document.getElementById('timeline').textContent.includes('<img'));
  assert.equal(await page.locator('#timeline img').count(),0); assert.equal(await page.evaluate(()=>window.fixtureXss),undefined); check('XSS-sensitive event labels render as escaped text');
  await unlock(); rpcFailure = true;
  await page.locator('#refresh').click(); await page.waitForFunction(()=>document.getElementById('payment-state').textContent.includes('State unavailable'));
  assert(await page.locator('[data-action=beer]').isDisabled()); assert((await page.locator('[data-reason=beer]').textContent()).includes('state unavailable')); check('RPC failure pauses state and merchant actions');
  await load({...held(),status:'pending',actions:Object.fromEntries(Object.keys(held().actions).map(a=>[a,false])),actionReasons:{beer:'Original operation pending or reserved; inspect its signatures.'}});
  await unlock(); assert(await page.locator('[data-action=beer]').isDisabled()); assert((await page.locator('[data-reason=beer]').textContent()).includes('pending')); check('Pending original payment stays ineligible after valid operator authentication');
  await load({...held(),captureDeadline:Math.floor(Date.now()/1000)-1,actions:{...held().actions,beer:false,void:false,reclaim:true},actionReasons:{beer:'Onchain capture deadline expired.',reclaim:''}});
  await unlock(); assert.equal(await page.locator('#clock').textContent(),'00:00'); assert(await page.locator('[data-action=beer]').isDisabled()); assert(await page.locator('#new-budget').isHidden());
  check('Funded expired hold never resets deadlines or exposes replacement');
  await load(held()); missingAuthority = true;
  await page.locator('#merchant-secret').fill(secret); await page.locator('#unlock-merchant').click(); await page.waitForFunction(()=>document.getElementById('action-status').textContent.includes('no economic request'));
  assert.equal(posts,0); assert(await page.locator('[data-action=beer]').isDisabled()); check('Missing operator authority fails closed without an economic POST');
  await load(draft(),true); await page.locator('#connect-wallet').click(); await page.locator('#wallet-list button').first().click();
  assert.equal(await page.locator('#clock').textContent(),'00:00'); assert(await page.locator('#authorize').isDisabled());
  await page.locator('#new-budget').click(); await page.waitForFunction(()=>localStorage.getItem('capture402-order')==='b'.repeat(32)&&document.getElementById('payment-state').textContent.includes('Unsigned'));
  assert.equal(posts,1); assert.equal(await page.evaluate(()=>window.fixtureSigns||0),0); assert.equal(await page.evaluate(()=>localStorage.getItem('capture402-order')),'b'.repeat(32));
  check('Expired never-submitted draft replaced only by explicit click; separate unsigned offer, no wallet signing');
  await load(held()); await unlock(); delayPreflight = true;
  await page.evaluate(()=>{const b=document.querySelector('[data-action=beer]');b.click();b.click();});
  await page.waitForFunction(()=>document.getElementById('payment-state').textContent.includes('Unknown') || document.getElementById('payment-state').textContent.includes('Pending'));
  assert.equal(posts,1); assert(await page.locator('[data-action=beer]').isDisabled()); check('Concurrent clicks produce one POST; pending response stays locked');
  delayPreflight = false;
  await load(held()); await unlock(); loseResponse = true;
  await page.locator('[data-action=beer]').click(); await page.waitForFunction(()=>document.getElementById('payment-state').textContent.includes('Unknown'));
  assert.equal(posts,1); assert(await page.locator('[data-action=beer]').isDisabled());
  await page.reload();await page.locator('#advanced').evaluate(e=>e.open=true); await page.waitForFunction(()=>document.getElementById('payment-state').textContent.includes('Unknown'));
  assert(await page.locator('[data-action=beer]').isDisabled()); assert(await page.locator('#new-budget').isHidden()); await noSecretLeak(); check('Lost economic response persists non-secret lock through reload and blocks replacement');
  const refundable = {...held(),status:'closed',remaining:0,heldBaseUnits:'0',refundableBaseUnits:'65000000',captured:65,released:35,
    actions:{...held().actions,beer:false,void:false,refund:true},actionReasons:{...held().actionReasons,refund:''},
    balances:{payer:{amount:935,reason:''},merchant:{amount:10,reason:''}}};
  await load(refundable); await unlock();
  assert.equal(await page.locator('[data-action=refund]').count(),1);
  assert.equal(await page.locator('[data-action=refund]').textContent(),'Refund 10');
  assert(!(await page.locator('[data-action=refund]').isDisabled()));
  await page.locator('[data-action=refund]').click();
  await page.waitForFunction(()=>document.getElementById('payment-state').textContent.includes('Unknown'));
  assert.equal(posts,1); assert(!lastActionBody);
  await noSecretLeak(); check('Normal refund 10 needs only 10 liquidity at F=65; one bodyless POST locks on pending response');
  await load({...refundable,balances:{...refundable.balances,merchant:{amount:9.999999,reason:''}}}); await unlock();
  assert(await page.locator('[data-action=refund]').isDisabled());
  assert((await page.locator('[data-reason=refund]').textContent()).includes('cannot fund'));
  assert.equal(posts,0); check('Normal refund UI rejects liquidity below selected 10 before POST');
  await load({...refundable,refundableBaseUnits:'5000000'}); await unlock();
  assert(await page.locator('[data-action=refund]').isDisabled());
  assert.equal(posts,0); check('Normal refund UI rejects F below selected 10 before POST');
  await load({...refundable,refundableBaseUnits:undefined}); await unlock();
  assert(await page.locator('[data-action=refund]').isDisabled());
  assert.equal(posts,0); check('Unavailable finalized F blocks normal refund UI');
  await load(refundable); await unlock();
  nextActionPreflight = {...refundable,balances:{...refundable.balances,merchant:{amount:9.999999,reason:''}}};
  await page.locator('[data-action=refund]').click();
  await page.waitForFunction(()=>document.getElementById('action-status').textContent.includes('cannot fund'));
  assert.equal(posts,0); check('Fresh operator preflight rechecks selected refund liquidity before POST');
  const fullRefund = {...refundable,scenario:'refund',remaining:60,heldBaseUnits:'60000000',refundableBaseUnits:'40000000',captured:40,released:0,
    balances:{payer:{amount:900,reason:''},merchant:{amount:40,reason:''}}};
  await load(fullRefund); await unlock();
  assert.equal(await page.locator('[data-action=refund]').textContent(),'Merchant-funded refund');
  await page.locator('[data-action=refund]').click();
  await page.waitForFunction(()=>document.getElementById('payment-state').textContent.includes('Unknown'));
  assert.equal(posts,1); assert(!lastActionBody); check('Dedicated full refund remains bodyless with its original control and pending lock');
  await load({...fullRefund,balances:{...fullRefund.balances,merchant:{amount:10,reason:''}}}); await unlock();
  assert(await page.locator('[data-action=refund]').isDisabled());
  assert.equal(posts,0); check('Dedicated refund UI still requires full F liquidity');
  await load(held());await unlock();definitiveResponse=true;
  await page.locator('[data-action=beer]').click();await page.waitForFunction(()=>document.getElementById('action-status').textContent.includes('refused'));
  assert.equal(posts,1);assert.equal(await page.evaluate(()=>localStorage.getItem('capture402-uncertain')),null);
  assert(await page.evaluate(()=>JSON.parse(localStorage.getItem('capture402-request-'+localStorage.getItem('capture402-order'))).path.endsWith('/actions/beer')));
  check('Exact pre-dispatch body/header releases only its fresh latch and retains source-bound request metadata');
  const recovery={order:id,payer:info.merchant,payment:info.programId,policySha256:'a'.repeat(64),originalEvidenceSha256:'b'.repeat(64),classification:'source-bound-pre-dispatch-refusal',continued:false};
  const expiredHeld={...held(),captureDeadline:Math.floor(Date.now()/1000)-1,actions:{...held().actions,reclaim:true},reclaimPreparation:true,b3Recovery:recovery};
  const feeReason='The original payer has 0 Devnet SOL. Add Devnet SOL to this wallet for reclaim network fees, then observe the original state. Test tokens cannot pay SOL fees. This check submits no transaction.';
  await load({...expiredHeld,reclaimPreparation:false,actions:{...expiredHeld.actions,reclaim:false},actionReasons:{reclaim:feeReason},balances:{...expiredHeld.balances,payerSol:{lamports:'0',reason:''}},reclaimFunding:{balanceLamports:'0',requiredLamports:null,reason:feeReason}},true);
  await page.locator('#connect-wallet').click();await page.locator('#wallet-list button').first().click();
  await page.waitForFunction(()=>document.getElementById('next-step').textContent==='Devnet SOL required');
  assert(await page.locator('#reclaim').isDisabled());assert((await page.locator('#payer-sol-balance').textContent()).includes('0.000000000'));
  assert((await page.locator('#readiness').textContent()).includes('Test tokens cannot pay SOL fees'));
  assert.equal(posts,0);assert.equal(await page.evaluate(()=>window.fixtureSigns||0),0);
  check('Zero payer SOL explains reclaim fees in the guided step before signing, with the native balance visible');
  state={...expiredHeld,reclaimPreparation:false,balances:{...expiredHeld.balances,payerSol:{lamports:'100000000',reason:''}},reclaimFunding:{balanceLamports:'100000000',requiredLamports:'25000',reason:''}};
  await page.locator('#next-action').click();await page.waitForFunction(()=>!document.getElementById('reclaim').disabled);
  assert.equal(posts,0);assert.equal(await page.evaluate(()=>window.fixtureSigns||0),0);
  check('Explicit observation after SOL funding exposes reclaim without automatically signing or submitting');
  await load({...expiredHeld,reclaimPreparation:false,actions:{...expiredHeld.actions,reclaim:false},balances:{...expiredHeld.balances,payerSol:{lamports:null,reason:'Finalized payer Devnet SOL balance unavailable.'}},reclaimFunding:{balanceLamports:null,requiredLamports:null,reason:'Finalized payer Devnet SOL balance unavailable.'}},true);
  await page.locator('#connect-wallet').click();await page.locator('#wallet-list button').first().click();
  await page.waitForFunction(()=>document.getElementById('next-step').textContent==='Reclaim fee check unavailable');
  assert((await page.locator('#payer-sol-balance').textContent()).includes('unavailable'));assert(await page.locator('#reclaim').isDisabled());assert.equal(posts,0);
  check('Unavailable native balance stays unknown and cannot be presented as zero SOL or an eligible signature');
  await load(expiredHeld,true);await page.locator('#connect-wallet').click();await page.locator('#wallet-list button').first().click();
  await page.evaluate(()=>localStorage.setItem('capture402-uncertain',localStorage.getItem('capture402-order')));
  await page.locator('#refresh').click();await page.waitForFunction(()=>!document.getElementById('reclaim').disabled);
  assert(!(await page.locator('#reclaim').isDisabled()));assert(await page.locator('[data-action=beer]').isDisabled());assert(await page.locator('#new-budget').isHidden());
  assert.equal(await page.evaluate(()=>localStorage.getItem('capture402-uncertain')),id);
  check('Reviewed legacy provenance enables only distinct payer reclaim while original latch stays retained');
  await page.evaluate(()=>localStorage.setItem('capture402-reclaim-wallet-attempt',localStorage.getItem('capture402-order')));
  await page.locator('#refresh').click();await page.waitForFunction(()=>document.getElementById('reclaim').disabled);
  assert.equal(posts,0);check('Original reclaim wallet-consent marker blocks replacement signing across refresh');
  await page.waitForFunction(()=>!document.getElementById('renew-reclaim').hidden);assert(await page.locator('#renew-reclaim').isVisible());
  await page.locator('#renew-reclaim').click();await page.waitForFunction(()=>!document.getElementById('reclaim').disabled);
  assert.equal(posts,1);assert.equal(await page.evaluate(()=>window.fixtureSigns||0),0);
  assert.equal(await page.evaluate(()=>localStorage.getItem('capture402-uncertain')),id);
  assert.equal(await page.evaluate(()=>localStorage.getItem('capture402-reclaim-wallet-attempt')),id);
  assert.equal(await page.locator('#action-status').textContent(),'Previous reclaim wire archived after finalized no-effect proof. Fresh unsigned draft prepared; request signature separately.');
  check('Successful reviewed renewal preserves its no-effect preparation message after refresh, without claiming a finalized reclaim');
  check('Explicit renewal prepares one unsigned draft without wallet signing or clearing original latch/consent');
  await page.reload();await page.locator('#advanced').evaluate(e=>e.open=true);await page.waitForFunction(()=>document.getElementById('payment-id').querySelector('a'));
  await page.locator('#connect-wallet').click();await page.locator('#wallet-list button').first().click();
  await page.waitForFunction(()=>!document.getElementById('reclaim').disabled);
  assert(await page.locator('#renew-reclaim').isHidden());
  check('Retained valid generation survives navigation without offering replacement');
  const firstGeneration=state.reclaimGeneration;
  state={...state,reclaimDraftState:'expired-or-unavailable',reclaimPreparation:true};
  await page.locator('#refresh').click();await page.waitForFunction(()=>document.getElementById('reclaim').disabled && !document.getElementById('renew-reclaim').hidden);
  assert((await page.locator('#reclaim-description').textContent()).includes('expired or unavailable'));
  assert.equal(await page.evaluate(()=>window.fixtureSigns||0),0);
  check('Expired unsigned generation disables signing and exposes explicit proof-gated preparation');
  await page.locator('#renew-reclaim').click();await page.waitForFunction(()=>!document.getElementById('reclaim').disabled);
  assert.notEqual(state.reclaimGeneration,firstGeneration);assert.equal(posts,2);assert.equal(await page.evaluate(()=>window.fixtureSigns||0),0);
  check('Explicit repeated preparation changes generation without wallet signing or dispatch');
  state={...state,reclaimDraftState:'stopped',reclaimPreparation:false};
  await page.evaluate(id=>localStorage.setItem('capture402-reclaim-wallet-attempt-'+id,localStorage.getItem('capture402-reclaim-renewed-'+id)),id);
  await page.locator('#refresh').click();await page.waitForFunction(()=>document.getElementById('reclaim').disabled && document.getElementById('action-status').textContent.includes('All new operations stopped'));
  assert(await page.locator('#renew-reclaim').isHidden());
  assert((await page.locator('#action-status').textContent()).includes('All new operations stopped'));
  check('New generation wallet attempt locks further signing while old generation remains preserved');
  state=expiredHeld;await page.evaluate(id=>{localStorage.setItem('capture402-reclaim-uncertain',id);localStorage.removeItem('capture402-reclaim-renewed-'+id);},id);
  await page.locator('#refresh').click();await page.waitForFunction(()=>document.getElementById('reclaim').disabled && document.getElementById('action-status').textContent.includes('All new operations stopped'));
  assert(await page.locator('#renew-reclaim').isHidden());
  assert((await page.locator('#action-status').textContent()).includes('All new operations stopped'));
  check('UNKNOWN distinct reclaim response cannot use expiry-consent UI renewal');
  await load(expiredHeld,true);await page.locator('#connect-wallet').click();await page.locator('#wallet-list button').first().click();
  await page.evaluate(()=>localStorage.setItem('capture402-uncertain',localStorage.getItem('capture402-order')));

  await page.evaluate(()=>localStorage.removeItem('capture402-reclaim-wallet-attempt')); // Controlled DOM fixture only.
  state={...expiredHeld,b3Recovery:{...recovery,payment:'stale'}};await page.locator('#refresh').click();await page.waitForFunction(()=>document.getElementById('reclaim').disabled);
  assert.equal(posts,0);check('Wrong legacy payment provenance keeps payer reclaim locked');
  await load({...held(),scenario:'atomic',actions:{...held().actions,beer:false,atomic:true},actionReasons:{atomic:''}});await unlock();
  assert(!(await page.locator('[data-action=atomic]').isDisabled()));assert(await page.locator('[data-action=atomic]').isVisible());
  await page.locator('[data-action=atomic]').click();await page.waitForFunction(()=>document.getElementById('payment-state').textContent.includes('Unknown'));
  assert.equal(posts,1);check('Atomic scenario exposes a single explicit action and UNKNOWN still blocks new actions');
  await load({...fullRefund,status:'closed',remaining:0,heldBaseUnits:'0'},true);await page.locator('#connect-wallet').click();await page.locator('#wallet-list button').first().click();
  assert(!(await page.locator('[data-scenario=cancelled]').isDisabled()));await page.locator('[data-scenario=cancelled]').click();await page.locator('#new-budget').click();
  await page.waitForFunction(()=>localStorage.getItem('capture402-order')==='b'.repeat(32));assert.equal(posts,1);
  check('Closed original hold permits explicit selection of the next scenario before a separately unsigned offer');
  await load({...draft(),authorizeAbandonEligible:true},true);
  await page.evaluate(id=>localStorage.setItem('capture402-wallet-attempt',id),id);
  await page.locator('#refresh').click();await page.waitForFunction(()=>!document.getElementById('abandon-authorize').hidden);
  assert(await page.locator('#authorize').isDisabled());assert(await page.locator('#new-budget').isHidden());
  await page.locator('#abandon-authorize').click();await page.waitForFunction(()=>document.getElementById('payment-state').textContent.includes('archived'));
  assert.equal(posts,1);assert.equal(await page.evaluate(()=>window.fixtureSigns||0),0);assert(await page.locator('#new-budget').isVisible());
  assert.equal(await page.evaluate(()=>localStorage.getItem('capture402-wallet-attempt')),id);
  check('Selected abandoned unfunded draft preserves old consent and enables only explicit separate offer, with no signing/dispatch');
  await load({...draft(),authorizeAbandonEligible:true},true);
  await page.evaluate(id=>localStorage.setItem('capture402-signed-'+id,'retained-signed-original'),id);
  await page.locator('#refresh').click();assert(await page.locator('#abandon-authorize').isHidden());assert.equal(posts,0);
  check('Retained signed authorization forbids the narrow abandonment control');
  await page.evaluate(id=>{localStorage.removeItem('capture402-signed-'+id);localStorage.setItem('capture402-uncertain',id);},id);
  await page.locator('#refresh').click();assert(await page.locator('#abandon-authorize').isHidden());assert.equal(posts,0);
  check('UNKNOWN authorization cannot enter unfunded abandonment');
  const isolatedSignature='3'.repeat(88),isolated={...draft(),status:'pending',refundDeadline:Math.floor(Date.now()/1000)-1,
    events:[{action:'authorize',status:'pending',signature:isolatedSignature,label:'Preserved UNKNOWN original',amount:100,at:new Date().toISOString()}],
    authorizeIsolation:{kind:'expired-no-successful-authorize-effect',originalOutcome:'unknown',originalSignature:isolatedSignature,reserveRetained:true,
      proof:{kind:'expired-no-successful-authorize-effect',payment:info.programId,unsignedSha256:'a'.repeat(64),originSlot:'1',expirySlot:'2',paymentSlot:'3',clockSlot:'4',clockUnixTimestamp:String(Math.floor(Date.now()/1000))}}};
  await load(isolated,true);await page.locator('#connect-wallet').click();await page.locator('#wallet-list button').first().click();
  await page.evaluate(id=>{localStorage.setItem('capture402-uncertain',id);localStorage.setItem('capture402-wallet-attempt',id);localStorage.setItem('capture402-signed-'+id,'preserved-signed-original');},id);
  await page.locator('#refresh').click();await page.waitForFunction(()=>document.getElementById('payment-state').textContent.includes('new order available'));
  assert(await page.locator('#authorize').isDisabled());assert(await page.locator('[data-action=beer]').isDisabled());assert(await page.locator('#abandon-authorize').isHidden());
  await page.locator('#new-budget').waitFor({state:'visible'});assert.equal(posts,0);
  await page.locator('#new-budget').click();await page.waitForFunction(()=>localStorage.getItem('capture402-order')==='b'.repeat(32));
  assert.equal(posts,1);assert.equal(await page.evaluate(()=>window.fixtureSigns||0),0);
  const custody=await page.evaluate(id=>({latch:localStorage.getItem('capture402-uncertain'),attempt:localStorage.getItem('capture402-wallet-attempt'),signed:localStorage.getItem('capture402-signed-'+id),archive:JSON.parse(localStorage.getItem('capture402-isolation-archive-'+id))}),id);
  assert.equal(custody.latch,id);assert.equal(custody.attempt,id);assert.equal(custody.signed,'preserved-signed-original');assert.equal(custody.archive.evidence.originalOutcome,'unknown');assert.equal(custody.archive.evidence.reserveRetained,true);
  check('Selected expired signed UNKNOWN permits one explicit unsigned successor while preserving original latch, signed bytes and reserve evidence');
  await load({...isolated,authorizeIsolation:{...isolated.authorizeIsolation,reserveRetained:false}});
  assert(await page.locator('#new-budget').isHidden());assert.equal(posts,0);check('Incomplete isolation evidence never exposes a successor');
  await load(isolated);rpcFailure=true;await page.locator('#refresh').click();await page.waitForFunction(()=>document.getElementById('payment-state').textContent.includes('State unavailable'));
  assert(await page.locator('#new-budget').isHidden());assert.equal(posts,0);check('Stale RPC state hides the isolated successor and shows paused status');
  // Exercise actual app.js orchestration through both preflights. The wallet module
  // and HTTP backend are explicit non-economic stubs; no real signature is created.
  const flow=await context.newPage(),sequence=[];
  const flowUnsigned='unsigned-flow-fixture-never-signed';
  const flowHash=createHash('sha256').update(flowUnsigned).digest('hex');
  let flowState={...expiredHeld,reclaimGeneration:flowHash,reclaimDraftState:'ready',reclaimPreparation:false};
  await flow.route('**/wallet.js',route=>route.fulfill({contentType:'text/javascript',body:`
    const wallet={name:'Flow fixture wallet; no cryptography'};
    export const walletSignOrderSession=async()=>{throw Error('Session recovery disabled in this fixture');};
    export const wallets=()=>[wallet];export const onWallets=()=>()=>{};
    export const connect=async()=>({wallet,account:{address:${JSON.stringify(info.merchant)}}});
    export const walletSign=async()=>{window.fixtureSigns=(window.fixtureSigns||0)+1;return 'signed-flow-stub-not-a-transaction';};
    export const walletSignMerchantDemo=async()=>{throw new Error('Merchant demo is disabled in this fixture');};
    export const walletSignFaucetRequest=async()=>{throw new Error('Faucet is disabled in the reclaim fixture');};
    export const encodeEnvelope=x=>btoa(JSON.stringify(x));export const decodeEnvelope=x=>JSON.parse(atob(x));
    export const signingReport=()=>undefined;export const assertDevnetPolicy=()=>{};
  `}));
  await flow.route('**/api/orders**',async route=>{
    const req=route.request(),u=new URL(req.url());
    if(u.pathname.endsWith('/signing-preflight')) {
      const dispatch=u.searchParams.get('phase')==='dispatch';sequence.push(dispatch?'dispatch-preflight':'consent-preflight');
      assert.equal(dispatch,sequence.includes('consent'));
      return route.fulfill({contentType:'application/json',body:JSON.stringify({id,operation:'reclaim',phase:dispatch?'dispatch':'consent',fresh:!dispatch,unsignedSha256:flowHash})});
    }
    if(u.pathname.endsWith('/wallet-consent')) {sequence.push('consent');assert.equal(req.postDataJSON().unsignedSha256,flowHash);return route.fulfill({contentType:'application/json',body:'{"reserved":true}'});}
    if(u.pathname.endsWith('/reclaim') && req.method()==='GET')return route.fulfill({contentType:'application/json',body:JSON.stringify({unsigned:flowUnsigned,payer:info.merchant})});
    if(u.pathname.endsWith('/reclaim') && req.method()==='POST') {
      sequence.push('dispatch');assert.equal(req.postDataJSON().transaction,'signed-flow-stub-not-a-transaction');
      flowState={...flowState,status:'closed',remaining:0,heldBaseUnits:'0',reclaimDraftState:'stopped',b3Recovery:{...recovery,continued:true},events:[...flowState.events,{action:'reclaim',status:'finalized',amount:100,at:new Date().toISOString(),label:'Fixture reclaimed',signature:'flow-receipt-not-onchain',chainStatus:{kind:'found',commitment:'finalized',err:null}}]};
      return route.fulfill({contentType:'application/json',body:JSON.stringify({receipt:{success:true,transaction:'flow-receipt-not-onchain'}})});
    }
    return route.fulfill({contentType:'application/json',body:JSON.stringify(flowState)});
  });
  await flow.goto(origin+'/customer');await flow.evaluate(id=>{localStorage.clear();localStorage.setItem('capture402-order',id);localStorage.setItem('capture402-uncertain',id);},id);
  await flow.reload();await flow.waitForFunction(()=>document.getElementById('payment-id').querySelector('a'));
  await flow.locator('#advanced').evaluate(e=>e.open=true);await flow.locator('#connect-wallet').click();await flow.locator('#wallet-list button').first().click();assert.equal(await flow.locator('#next-action').textContent(),'Reclaim remaining hold');await flow.locator('#next-action').click();
  await flow.waitForFunction(()=>document.getElementById('action-status').textContent.includes('Payer reclaim finalized'));
  assert.deepEqual(sequence,['consent-preflight','consent','dispatch-preflight','dispatch']);assert.equal(await flow.evaluate(()=>window.fixtureSigns),1);
  assert.equal(await flow.evaluate(()=>localStorage.getItem('capture402-uncertain')),id);assert.equal(await flow.evaluate(()=>localStorage.getItem('capture402-reclaim-uncertain')),null);
  assert(await flow.locator('#new-budget').isVisible());
  check('Actual UI sequence separates consent and post-sign dispatch preflight, dispatches once and retains historical capture evidence');
  await flow.close();
  // Separate DOM fixture: no actual wallet, signature, network or token transfer.
  const faucetContext=await browser.newContext({ignoreHTTPSErrors:true}),faucetPage=await faucetContext.newPage();
  let faucetPosts=0,faucetReads=0,faucetFinal=false;
  const faucetId='d'.repeat(64),faucetSignature='1'.repeat(64);
  const faucetResult=()=>({id:faucetId,recipient:info.merchant,amount:1000,mint:info.mint,status:faucetFinal?'finalized':'unknown',signature:faucetSignature,finalizedSlot:faucetFinal?'10':null});
  await faucetPage.route('**/wallet.js',route=>route.fulfill({contentType:'text/javascript',body:`
    const wallet={name:'Faucet DOM fixture; no cryptography'};
    export const walletSignOrderSession=async()=>{throw Error('Session recovery disabled in this fixture');};
    export const wallets=()=>[wallet];export const onWallets=()=>()=>{};
    export const connect=async()=>({wallet,account:{address:${JSON.stringify(info.merchant)}}});
    export const walletSign=async()=>{throw new Error('No transaction signing in faucet DOM fixture');};
    export const walletSignMerchantDemo=async()=>{throw new Error('Merchant demo is disabled in this fixture');};
    export const walletSignFaucetRequest=async()=>{window.fixtureMessages=(window.fixtureMessages||0)+1;return 'unsigned-DOM-fixture-not-a-signature';};
    export const encodeEnvelope=x=>btoa(JSON.stringify(x));export const decodeEnvelope=x=>JSON.parse(atob(x));
    export const signingReport=()=>undefined;export const assertDevnetPolicy=()=>{};
  `}));
  await faucetPage.route('**/api/config',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({...info,faucetEnabled:true})}));
  await faucetPage.route('**/api/faucet/**',route=>{
    const req=route.request(),path=new URL(req.url()).pathname;
    if(path.endsWith('/challenge'))return route.fulfill({contentType:'application/json',body:JSON.stringify({id:faucetId,recipient:info.merchant})});
    if(path.endsWith('/claim')){faucetPosts++;return route.abort();}
    faucetReads++;return route.fulfill({contentType:'application/json',body:JSON.stringify(faucetResult())});
  });
  await faucetPage.goto(origin+'/customer');await faucetPage.locator('#advanced').evaluate(e=>e.open=true);await faucetPage.waitForSelector('#faucet-panel',{state:'visible'});
  assert(await faucetPage.locator('#claim-test-tokens').isDisabled());
  await faucetPage.locator('#connect-wallet').click();await faucetPage.locator('#wallet-list button').first().click();
  await faucetPage.locator('#claim-test-tokens').click();
  await faucetPage.waitForFunction(()=>localStorage.getItem('capture402-faucet-original') && !document.getElementById('refresh-test-tokens').hidden);
  assert.equal(faucetPosts,1);assert(await faucetPage.locator('#claim-test-tokens').isDisabled());assert(await faucetPage.locator('#authorize').isDisabled());
  await faucetPage.reload();await faucetPage.locator('#advanced').evaluate(e=>e.open=true);await faucetPage.waitForFunction(()=>document.getElementById('faucet-status').textContent.includes('UNKNOWN'));
  assert.equal(faucetPosts,1);assert(faucetReads>=1);assert(await faucetPage.locator('#claim-test-tokens').isDisabled());
  faucetFinal=true;await faucetPage.locator('#refresh-test-tokens').click();
  await faucetPage.waitForFunction(()=>document.getElementById('faucet-status').textContent.includes('delivered'));
  assert.equal(await faucetPage.evaluate(()=>localStorage.getItem('capture402-faucet-original')),null);
  assert.equal(faucetPosts,1);assert(await faucetPage.locator('#faucet-receipt').isVisible());
  assert.equal(await faucetPage.locator('#faucet-receipt').getAttribute('href'),`https://explorer.solana.com/tx/${faucetSignature}?cluster=devnet`);
  check('Faucet DOM: message request, lost response/reload stop, read-only original observation and finalized receipt without a second POST');
  await faucetContext.close();
  // Public demo orchestration only: synthetic readable consent, no cryptography.
  const demoContext=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:390,height:844}}),demoPage=await demoContext.newPage();
  let demoPosts=0,demoMessages=0,demoChallenge=0,demoHeader='';const demoState=held();
  demoPage.on('pageerror',error=>errors.push(error.message));
  await demoPage.addInitScript(id=>localStorage.setItem('capture402-order',id),id);
  await demoPage.route('**/api/config',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({...info,publicMerchantDemoEnabled:true})}));
  await demoPage.route('**/wallet.js',r=>r.fulfill({contentType:'text/javascript',body:`
    const wallet={name:'Public demo fixture wallet; no cryptography'};
    export const walletSignOrderSession=async()=>{throw Error('Session recovery disabled in this fixture');};
    export const wallets=()=>[wallet];export const onWallets=()=>()=>{};
    export const connect=async()=>({wallet,account:{address:${JSON.stringify(info.merchant)}}});
    export const walletSign=async()=>{throw Error('Transaction signing disabled in fixture');};
    export const walletSignMerchantDemo=async()=>{window.demoMessages=(window.demoMessages||0)+1;return 'synthetic-message-proof';};
    export const walletSignFaucetRequest=async()=>{throw Error('Faucet disabled');};
    export const encodeEnvelope=x=>btoa(JSON.stringify(x));export const decodeEnvelope=x=>JSON.parse(atob(x));
    export const signingReport=()=>undefined;export const assertDevnetPolicy=()=>{};
  `}));
  await demoPage.route('**/api/orders**',r=>{
    const req=r.request(),path=new URL(req.url()).pathname;
    if(path.endsWith('/merchant-demo')){demoChallenge++;assert.equal(req.method(),'POST');return r.fulfill({contentType:'application/json',body:JSON.stringify({token:'synthetic-order-challenge',expiresAt:demoState.refundDeadline})});}
    if(path.includes('/actions/')){
      assert(req.headers().authorization.startsWith('Demo '));demoHeader=req.headers().authorization;
      if(req.method()==='GET')return r.fulfill({contentType:'application/json',body:JSON.stringify({...demoState,operatorAccess:true})});
      demoPosts++;return r.abort();
    }
    return r.fulfill({contentType:'application/json',body:JSON.stringify(demoState)});
  });
  await demoPage.goto(origin+'/customer');await demoPage.locator('#advanced').evaluate(e=>e.open=true);await demoPage.waitForSelector('#enable-demo-controls',{state:'visible'});
  assert(await demoPage.locator('#operator-credentials').isHidden());assert(await demoPage.locator('#enable-demo-controls').isDisabled());
  assert((await demoPage.locator('#operator-status').textContent()).includes('original payer wallet'));
  await demoPage.locator('#connect-wallet').click();await demoPage.locator('#wallet-list button').first().click();
  await demoPage.locator('#next-action').click();await demoPage.waitForFunction(()=>!document.querySelector('[data-action=beer]').disabled);
  demoMessages=await demoPage.evaluate(()=>window.demoMessages);assert.equal(demoMessages,1);assert.equal(demoChallenge,1);assert.equal(demoPosts,0);
  assert(!(await demoPage.content()).includes(demoHeader));assert(!(await demoPage.evaluate(()=>JSON.stringify({...localStorage}))).includes(demoHeader));
  assert.equal(await demoPage.evaluate(()=>document.documentElement.scrollWidth),390);
  await demoPage.reload();await demoPage.locator('#advanced').evaluate(e=>e.open=true);await demoPage.waitForFunction(()=>document.querySelector('[data-action=beer]').disabled);assert(await demoPage.locator('#operator-credentials').isHidden());
  await demoPage.locator('#connect-wallet').click();await demoPage.locator('#wallet-list button').first().click();
  await demoPage.locator('#next-action').click();await demoPage.waitForFunction(()=>!document.querySelector('[data-action=beer]').disabled);
  assert.equal(await demoPage.locator('#next-action').textContent(),'Collect 40');await demoPage.locator('#next-action').click();await demoPage.waitForFunction(()=>document.getElementById('payment-state').textContent.includes('Unknown'));
  assert.equal(demoPosts,1);assert(await demoPage.locator('#enable-demo-controls').isDisabled());
  await demoPage.reload();await demoPage.locator('#advanced').evaluate(e=>e.open=true);await demoPage.waitForFunction(()=>document.getElementById('payment-state').textContent.includes('Unknown'));assert.equal(demoPosts,1);assert(await demoPage.locator('#enable-demo-controls').isDisabled());
  check('Public demo DOM: explicit message/preflight, memory-only grant, reload clears access, mobile layout and UNKNOWN survive reload without another POST');
  await demoContext.close();
  // Stage C guided presentation: original endpoints and consent rules, synthetic responses only.
  const guideContext=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:900}});
  const guide=await guideContext.newPage();
  const guideErrors=[];guide.on('pageerror',e=>guideErrors.push(e.message));
  let guideState,guideCreates=0,guideConsent=0,guideSigns=0,guideEconomic=0,guideActionGets=0,guideUnavailable=false;
  const guideUnsigned='guided-fixture-unsigned-not-a-transaction',guideHash=createHash('sha256').update(guideUnsigned).digest('hex');
  const accepts=[{amount:'100000000',asset:info.mint,payTo:info.merchant,network:info.network,extra:{programId:info.programId,feePayer:info.sponsor,paymentFlow:'escrow'}}];
  const guideDraft=()=>({...draft(),captureDeadline:Math.floor(Date.now()/1000)+150,refundDeadline:Math.floor(Date.now()/1000)+180,unsigned:guideUnsigned,required:{accepts}});
  await guide.route('**/wallet.js',r=>r.fulfill({contentType:'text/javascript',body:`
    const wallet={name:'Guided stub wallet; no cryptography'};
    export const walletSignOrderSession=async()=>{throw Error('Session recovery disabled in this fixture');};
    export const wallets=()=>[wallet];export const onWallets=()=>()=>{};
    export const connect=async()=>({wallet,account:{address:${JSON.stringify(info.merchant)}}});
    export const walletSign=async()=>{window.guideDeclines=(window.guideDeclines||0)+1;throw Error('Wallet approval declined');};
    export const walletSignMerchantDemo=async()=>{throw Error('Demo consent disabled in guided fixture');};
    export const walletSignFaucetRequest=async()=>{throw Error('Faucet disabled in guided fixture');};
    export const encodeEnvelope=x=>btoa(JSON.stringify(x));export const decodeEnvelope=x=>JSON.parse(atob(x));
    export const signingReport=()=>undefined;export const assertDevnetPolicy=()=>{};
  `}));
  await guide.route('**/api/orders**',async r=>{
    const req=r.request(),path=new URL(req.url()).pathname;
    if(path==='/api/orders' && req.method()==='POST'){
      guideCreates++;guideState={...guideDraft(),scenario:req.postDataJSON().scenario};
      await new Promise(resolve=>setTimeout(resolve,100));
      return r.fulfill({status:402,contentType:'application/json',headers:{'PAYMENT-REQUIRED':Buffer.from(JSON.stringify(guideState.required)).toString('base64')},body:JSON.stringify({order:id,unsigned:guideUnsigned})});
    }
    if(path.endsWith('/wallet-consent')){guideConsent++;return r.fulfill({contentType:'application/json',body:'{"reserved":true}'});}
    if(path.endsWith('/signing-preflight'))return r.fulfill({contentType:'application/json',body:JSON.stringify({id,operation:'authorize',phase:'consent',fresh:true,unsignedSha256:guideHash})});
    if(path.includes('/actions/')) {
      if(req.method()==='POST'){guideEconomic++;return r.abort();}
      guideActionGets++;assert.equal(req.headers().authorization,`Bearer ${secret}`);
      return r.fulfill({contentType:'application/json',body:JSON.stringify({...guideState,operatorAccess:true})});
    }
    return r.fulfill({status:guideUnavailable?409:200,contentType:'application/json',body:JSON.stringify(guideUnavailable?{error:'Finalized RPC state unavailable.'}:guideState)});
  });
  await guide.route('**/resource**',r=>{guideEconomic++;return r.abort();});
  await guide.goto(origin+'/customer');await guide.waitForFunction(()=>document.getElementById('next-action').textContent==='Connect wallet');
  assert.equal(await guide.locator('[data-scenario]:visible').count(),2);assert(await guide.locator('#advanced').evaluate(e=>!e.open));
  assert.equal(await guide.locator('#remaining').textContent(),'—');
  await guide.locator('#next-action').focus();await guide.keyboard.press('Enter');
  assert(await guide.locator('#wallet-dialog').evaluate(e=>e.open));await guide.keyboard.press('Escape');
  await guide.locator('#next-action').click();await guide.locator('#wallet-list button').click();
  await guide.waitForFunction(()=>document.getElementById('next-action').textContent==='Prepare unsigned offer');
  await guide.locator('[data-scenario=partial-reclaim]').click();
  await guide.evaluate(()=>{const b=document.getElementById('next-action');b.click();b.click();});
  await guide.waitForFunction(()=>document.getElementById('next-action').textContent==='Authorize 100 test tokens');
  assert.equal(guideCreates,1);assert.equal(guideConsent,0);assert.equal(await guide.evaluate(()=>window.guideDeclines||0),0);assert.equal(guideState.scenario,'partial-reclaim');
  const originalDeadline=guideState.captureDeadline;
  assert((await guide.locator('#readiness').textContent()).includes(new Date(originalDeadline*1000).toISOString()));
  assert(await guide.locator('[data-scenario=normal]').isDisabled());
  await guide.locator('[data-scenario=normal]').evaluate(e=>e.onclick());assert.equal(guideState.scenario,'partial-reclaim');
  check('Guided initial paths, keyboard dialog/Escape, unknown totals and duplicate unsigned preparation: one offer, no consent/signing');
  await guide.locator('#next-action').click();
  await guide.waitForFunction(()=>document.getElementById('readiness').textContent.includes('declined'));
  guideSigns=await guide.evaluate(()=>window.guideDeclines);assert.equal(guideSigns,1);assert.equal(guideConsent,1);assert.equal(guideEconomic,0);
  assert.equal(await guide.evaluate(()=>localStorage.getItem('capture402-wallet-attempt')),id);
  assert.equal(await guide.locator('#next-action').textContent(),'Observe original state');
  await guide.locator('#next-action').click();assert.equal(await guide.evaluate(()=>window.guideDeclines),1);
  await guide.reload();await guide.waitForFunction(()=>document.getElementById('payment-id').querySelector('a'));
  await guide.waitForFunction(payer=>document.getElementById('payer-key').textContent===payer,info.merchant);
  assert.equal(await guide.locator('#wallet-dialog').evaluate(e=>e.open),false);
  assert.equal(await guide.evaluate(()=>window.guideDeclines||0),0);
  assert((await guide.locator('#readiness').textContent()).includes('consent attempt is retained'));
  assert.equal(guideEconomic,0);assert.equal(guideCreates,1);assert.equal(guideState.captureDeadline,originalDeadline);
  check('Guided declined approval retains durable consent across observation/reload; no second signature, replacement or economic submission');
  guideState={...guideDraft(),balances:{payer:{amount:0,reason:'Test-mint token account missing; operator funding required.'}}};
  await guide.evaluate(()=>localStorage.removeItem('capture402-wallet-attempt'));await guide.locator('#refresh').click();
  await guide.waitForFunction(()=>document.getElementById('next-step').textContent==='Test tokens required');
  assert(await guide.locator('#authorize').isDisabled());assert.equal(guideEconomic,0);assert((await guide.locator('#readiness').textContent()).includes('funding required'));
  check('Guided insufficient tokens are distinct from unsigned approval and never bypass funding eligibility');
  guideState={...held(),scenario:'partial-reclaim',captured:40,remaining:60,heldBaseUnits:'60000000',refundableBaseUnits:'40000000',actions:{beer:false,reclaim:false},actionReasons:{reclaim:'Payer reclaim opens at the onchain capture deadline.'}};
  await guide.locator('#refresh').click();await guide.waitForFunction(()=>document.getElementById('next-step').textContent==='Wait / inspect original evidence');
  assert.equal(await guide.locator('#next-action').textContent(),'Observe original state');assert(await guide.locator('#new-budget').isHidden());
  assert((await guide.locator('#path-description').textContent()).includes('No work is performed'));
  const retainedDeadline=guideState.captureDeadline;await guide.locator('#next-action').click();assert.equal(guideState.captureDeadline,retainedDeadline);
  check('Guided partial capture waits for original real deadline with no advance-time or early return action');
  guideUnavailable=true;await guide.locator('#refresh').click();await guide.waitForFunction(()=>document.getElementById('next-step').textContent==='Current state unavailable');
  assert((await guide.locator('#totals-caption').textContent()).includes('Last observed'));assert.equal(await guide.locator('#remaining').textContent(),'60');
  assert.equal(await guide.locator('#illustration-link').getAttribute('target'),'_blank');
  assert.equal(await guide.locator('#illustration-link').getAttribute('href'),'/#demo');
  const retained=await guide.evaluate(()=>JSON.stringify(localStorage));
  await guide.locator('#illustration-link').evaluate(e=>e.addEventListener('click',ev=>ev.preventDefault(),{once:true}));await guide.locator('#illustration-link').click();
  assert.equal(await guide.evaluate(()=>JSON.stringify(localStorage)),retained);assert.equal(guideEconomic,0);
  assert((await guide.locator('#reclaim-guide').getAttribute('href')).includes('/starPaw/capture402-solana/'));assert.equal((await guide.locator('#reclaim-guide').textContent()).trim(),'public standalone reclaim guide ↗');assert((await guide.locator('.recovery-note').textContent()).includes('application routes'));
  check('Guided stale amounts, safe separate illustration link and public independent-reclaim guide preserve live custody');
  guideUnavailable=false;
  guideState={...held(),status:'pending',actions:{beer:false,reclaim:false}};await guide.locator('#refresh').click();
  await guide.waitForFunction(()=>document.getElementById('next-step').textContent.includes('Pending'));
  await guide.evaluate(id=>localStorage.setItem('capture402-uncertain',id),id);await guide.locator('#refresh').click();
  await guide.waitForFunction(()=>document.getElementById('next-step').textContent.includes('UNKNOWN'));
  await guide.reload();await guide.waitForFunction(()=>document.getElementById('next-step').textContent.includes('UNKNOWN'));
  assert.equal(guideCreates,1);assert.equal(guideEconomic,0);assert(await guide.locator('[data-scenario=normal]').isDisabled());
  check('Guided pending and UNKNOWN have distinct observation steps; reload/scenario switches never create a payment');
  await guide.evaluate(()=>localStorage.removeItem('capture402-uncertain'));
  guideState=held();await guide.locator('#refresh').click();await guide.waitForFunction(()=>document.getElementById('next-action').textContent==='Open operator tools');await guide.locator('#next-action').click();
  assert(await guide.locator('#advanced').evaluate(e=>e.open));assert.equal(await guide.evaluate(()=>document.activeElement.id),'merchant-secret');
  await guide.locator('#merchant-secret').fill(secret);await guide.locator('#unlock-merchant').click();await guide.waitForFunction(()=>document.getElementById('next-action').textContent==='Collect 40');
  // Fresh original GET revokes eligibility after the guided button was displayed.
  guideState={...guideState,actions:{...guideState.actions,beer:false},actionReasons:{beer:'Original operation now reserved.'}};
  await guide.locator('#next-action').click();await guide.waitForFunction(()=>document.getElementById('action-status').textContent.includes('now reserved'));
  assert.equal(guideEconomic,0);assert(guideActionGets>=2);
  check('Guided merchant control preserves separate operator auth and rechecks eligibility before any POST');
  guideState={...held(),status:'closed',captured:65,remaining:0,released:35,heldBaseUnits:'0',refundableBaseUnits:'65000000',actions:{}};
  await guide.locator('#refresh').click();await guide.waitForFunction(()=>document.getElementById('next-step').textContent==='Completed · hold closed');
  assert((await guide.locator('#receipt-summary').textContent()).includes('Paid 65, held 0, returned unused 35'));assert.equal(guideEconomic,0);
  await guide.locator('#advanced').evaluate(e=>e.open=false);await guide.locator('#action-status').evaluate(e=>e.hidden=true);
  for(const width of [1440,390]){
    await guide.setViewportSize({width,height:900});await guide.evaluate(()=>scrollTo(0,0));
    await guide.screenshot({path:join(output,`guided-completed-${width}.png`),fullPage:true});
  }
  check('Guided completed summary separates paid/unused totals and retains original receipts');
  guideState=held();await guide.locator('#refresh').click();await guide.waitForFunction(()=>document.getElementById('next-action').textContent==='Collect 40');
  await guide.evaluate(()=>{const b=document.getElementById('next-action');b.click();b.click();});
  await guide.waitForFunction(()=>document.getElementById('next-step').textContent.includes('UNKNOWN'));
  assert.equal(guideEconomic,1);await guide.reload();await guide.waitForFunction(()=>document.getElementById('next-step').textContent.includes('UNKNOWN'));assert.equal(guideEconomic,1);
  check('Guided double collection click dispatches once; lost response/reload retain UNKNOWN and cannot replay');
  await guide.emulateMedia({reducedMotion:'reduce'});assert.equal(await guide.evaluate(()=>matchMedia('(prefers-reduced-motion: reduce)').matches),true);
  assert.equal(guideErrors.length,0);await guideContext.close();
  // Exercise the actual 15-second observation callback, with no guided click or manual render.
  const pollContext=await browser.newContext({ignoreHTTPSErrors:true});const pollPage=await pollContext.newPage();
  let pollState=held(),pollFails=false,pollReads=0,pollFailures=0,pollPosts=0;
  pollPage.on('request',request=>{if(request.method()==='POST')pollPosts++;});
  await pollPage.route('**/wallet.js',r=>r.fulfill({contentType:'text/javascript',body:`
    const wallet={name:'Poll fixture wallet; no cryptography'};
    export const walletSignOrderSession=async()=>{throw Error('Session recovery disabled in this fixture');};
    export const wallets=()=>[wallet];export const onWallets=()=>()=>{};
    export const connect=async()=>({wallet,account:{address:${JSON.stringify(info.merchant)}}});
    export const walletSign=async()=>{throw Error('Signing disabled in poll fixture');};
    export const walletSignMerchantDemo=walletSign;export const walletSignFaucetRequest=walletSign;
    export const encodeEnvelope=x=>btoa(JSON.stringify(x));export const decodeEnvelope=x=>JSON.parse(atob(x));
    export const signingReport=()=>undefined;export const assertDevnetPolicy=()=>{};
  `}));
  await pollPage.route('**/api/orders**',r=>{
    if(r.request().method()!=='GET')return r.abort();
    pollReads++;if(pollFails)pollFailures++;
    return r.fulfill({status:pollFails?409:200,contentType:'application/json',body:JSON.stringify(pollFails?{error:'Finalized RPC state unavailable.'}:pollState)});
  });
  await pollPage.goto(origin+'/customer');await pollPage.evaluate(id=>localStorage.setItem('capture402-order',id),id);await pollPage.reload();
  await pollPage.locator('#connect-wallet').click();await pollPage.locator('#wallet-list button').first().click();
  await pollPage.waitForFunction(()=>document.getElementById('next-step').textContent==='Merchant authorization required');
  const observePoll=async(step,label)=>{
    const previous=pollReads;
    await pollPage.waitForResponse(response=>new URL(response.url()).pathname===`/api/orders/${id}` && response.request().method()==='GET' && pollReads>previous,{timeout:20000});
    await pollPage.waitForFunction(({step,label})=>document.getElementById('next-step').textContent===step && document.getElementById('next-action').textContent===label && !document.getElementById('next-action').disabled,{step,label});
    assert.equal(pollPosts,0);
  };
  await observePoll('Merchant authorization required','Open operator tools');
  check('Successful background observation restores the eligible guided operator action after reading completes');
  pollFails=true;await observePoll('Current state unavailable','Observe original state');
  assert(await pollPage.locator('[data-action=beer]').isDisabled());
  check('Failed background observation exposes read-only recovery and pauses merchant action');
  pollFails=false;pollState={...held(),status:'pending',actions:{beer:false,reclaim:false}};
  await observePoll('Pending · await finalized evidence','Observe original state');
  assert(await pollPage.locator('#new-budget').isHidden());assert(await pollPage.locator('[data-action=beer]').isDisabled());
  pollState=held();await pollPage.evaluate(id=>localStorage.setItem('capture402-uncertain',id),id);
  await observePoll('UNKNOWN · keep this order','Observe original state');
  assert(await pollPage.locator('#new-budget').isHidden());assert(await pollPage.locator('[data-action=beer]').isDisabled());
  check('Background observations keep pending and UNKNOWN on the original read-only path');
  await observePoll('UNKNOWN · keep this order','Observe original state');
  assert.equal(pollPosts,0);assert(pollReads>=6);
  report.polling={originalReads:pollReads,automaticReads:pollReads-1,failedReads:pollFailures,economicPosts:pollPosts};
  check('Repeated automatic observations send zero economic POSTs');
  await pollContext.close();
  const readyContext=await browser.newContext({ignoreHTTPSErrors:true});const readyPage=await readyContext.newPage();
  let ready=false,readyCreates=0,readyReads=0;
  await readyPage.route('**/api/config',r=>{readyReads++;return r.fulfill({contentType:'application/json',body:JSON.stringify({...info,walletChain:'solana:devnet',cluster:'devnet',configured:ready})});});
  await readyPage.route('**/api/orders**',r=>{if(r.request().method()==='POST')readyCreates++;return r.abort();});
  await readyPage.goto(origin+'/customer');await readyPage.waitForFunction(()=>document.getElementById('next-step').textContent==='Live lab unavailable');
  assert(await readyPage.locator('#prepare-offer').isDisabled());ready=true;await readyPage.locator('#refresh').click();
  await readyPage.waitForFunction(()=>document.getElementById('next-action').textContent==='Connect wallet');
  assert.equal(readyCreates,0);assert.equal(readyReads,2);await readyContext.close();
  check('Readiness recovery explicitly observes config again without creating an order or wallet action');
  // Fresh-visitor funding must be visible without opening Advanced. Exercise
  // the real wallet-connect/render path, but never approve a claim in this fixture.
  const fundingContext=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:390,height:844}});
  const fundingPage=await fundingContext.newPage();let configFails=false,faucetEnabled=true,fundingPosts=0;
  await fundingContext.addInitScript(id=>window.addEventListener('wallet-standard:app-ready',e=>e.detail.register({name:'Funding DOM wallet',features:{'standard:connect':{connect:async()=>({accounts:[{address:id,chains:['solana:devnet'],features:['solana:signTransaction']}]})},'solana:signTransaction':{supportedTransactionVersions:['legacy'],signTransaction:async()=>{throw Error('No signing allowed');}}}}),{once:true}),info.merchant);
  await fundingPage.route('**/api/config',r=>r.fulfill({status:configFails?503:200,contentType:'application/json',body:JSON.stringify(configFails?{error:'Configuration temporarily unavailable.'}:{...info,walletChain:'solana:devnet',cluster:'devnet',faucetEnabled})}));
  await fundingPage.route('**/api/faucet/**',r=>{if(r.request().method()==='POST')fundingPosts++;return r.abort();});
  await fundingPage.goto(origin+'/customer');
  await fundingPage.waitForFunction(()=>document.getElementById('faucet-availability').textContent.includes('Connect your'));
  assert.equal(await fundingPage.locator('#advanced').getAttribute('open'),null);
  assert(await fundingPage.locator('#claim-test-tokens').isVisible());assert(await fundingPage.locator('#claim-test-tokens').isDisabled());
  await fundingPage.locator('#connect-wallet').click();await fundingPage.locator('#wallet-list button').first().click();
  await fundingPage.waitForFunction(()=>!document.getElementById('claim-test-tokens').disabled);
  assert(await fundingPage.locator('#claim-test-tokens').isVisible());assert.equal(fundingPosts,0);
  await fundingPage.screenshot({path:join(output,'faucet-onboarding-390.png'),fullPage:true});
  check('Fresh mobile visitor sees claim beside wallet with Advanced closed; connection enables it without a claim POST');
  await fundingPage.evaluate(()=>localStorage.setItem('capture402-faucet-original',JSON.stringify({id:'f'.repeat(64),recipient:'fixture'})));
  await fundingPage.locator('#refresh').click();await fundingPage.waitForFunction(()=>document.getElementById('claim-test-tokens').disabled);
  assert(await fundingPage.locator('#refresh-test-tokens').isVisible());assert.equal(fundingPosts,0);
  check('Visible funding controls preserve unresolved original claim and prevent duplicate economics');
  await fundingPage.evaluate(()=>localStorage.clear());faucetEnabled=false;await fundingPage.reload();
  await fundingPage.waitForFunction(()=>document.getElementById('faucet-availability').textContent.includes('unavailable on this deployment'));
  assert(await fundingPage.locator('#claim-test-tokens').isVisible());assert(await fundingPage.locator('#claim-test-tokens').isDisabled());
  check('Disabled faucet remains visible with an explicit deployment availability reason');
  configFails=true;await fundingPage.reload();await fundingPage.waitForFunction(()=>document.getElementById('payment-state').textContent.includes('State unavailable'));
  configFails=false;faucetEnabled=true;await fundingPage.locator('#refresh').click();
  await fundingPage.waitForFunction(()=>document.getElementById('next-action').textContent==='Connect wallet');
  assert.equal(fundingPosts,0);await fundingContext.close();
  check('Transient startup failure recovers by explicit observation without an order or economic POST');
  const sessionContext=await browser.newContext({ignoreHTTPSErrors:true});const sessionPage=await sessionContext.newPage();
  let sessionRestored=false,sessionPosts=0,otherPosts=0;
  const sessionChallenge=new OrderSessionAccess('private-browser-fixture-session-secret-0123456789').challenge({origin,network:info.network,programId:info.programId,order:id,payer:info.merchant,payment:info.programId,capabilityHash:'b'.repeat(64)});
  await sessionContext.addInitScript(({id,payer})=>{
    localStorage.setItem('capture402-order',id);localStorage.setItem('capture402-uncertain',id);localStorage.setItem(`capture402-signed-${id}`,'retained-original-bytes');
    window.addEventListener('wallet-standard:app-ready',e=>e.detail.register({name:'Session DOM wallet',features:{'standard:connect':{connect:async()=>({accounts:[{address:payer,chains:['solana:devnet'],features:['solana:signTransaction','solana:signMessage']}]})},'solana:signTransaction':{supportedTransactionVersions:['legacy'],signTransaction:async()=>{throw Error('No transaction signing allowed');}},'solana:signMessage':{signMessage:async({message})=>[{signedMessage:new Uint8Array(message),signature:new Uint8Array(64)}]}}}),{once:true});
  },{id,payer:info.merchant});
  await sessionPage.route('**/api/config',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({...info,walletChain:'solana:devnet',cluster:'devnet',publicMerchantDemoEnabled:true,faucetEnabled:true})}));
  await sessionPage.route('**/api/orders**',async r=>{
    const path=new URL(r.request().url()).pathname;
    if(path.endsWith('/session')) {
      if(r.request().method()==='GET')return r.fulfill({contentType:'application/json',body:JSON.stringify(sessionChallenge)});
      sessionPosts++;assert.deepEqual(JSON.parse(r.request().postData()),{token:sessionChallenge.token,signature:Buffer.alloc(64).toString('base64')});sessionRestored=true;
      return r.fulfill({contentType:'application/json',body:JSON.stringify({order:id,restored:true})});
    }
    if(r.request().method()==='POST')otherPosts++;
    return r.fulfill({status:sessionRestored?200:409,contentType:'application/json',body:JSON.stringify(sessionRestored?held():{code:'order_session_unavailable',error:'Original order session expired or unavailable.'})});
  });
  await sessionPage.goto(origin+'/customer');await sessionPage.waitForFunction(()=>document.getElementById('next-step').textContent==='Restore the original order');
  assert(await sessionPage.locator('#session-recovery').isVisible());assert(await sessionPage.locator('#claim-test-tokens').isDisabled());
  await sessionPage.locator('#next-action').click();await sessionPage.locator('#wallet-list button').first().click();
  await sessionPage.waitForFunction(()=>document.getElementById('next-action').textContent==='Restore original order with my wallet'&&!document.getElementById('next-action').disabled);
  await sessionPage.locator('#next-action').click();await sessionPage.waitForFunction(()=>document.getElementById('next-step').textContent==='UNKNOWN · keep this order');
  assert.equal(sessionPosts,1);assert.equal(otherPosts,0);assert(await sessionPage.locator('#session-recovery').isHidden());
  assert.deepEqual(await sessionPage.evaluate(id=>[localStorage.getItem('capture402-order'),localStorage.getItem('capture402-uncertain'),localStorage.getItem(`capture402-signed-${id}`)],id),[id,id,'retained-original-bytes']);
  assert(await sessionPage.locator('[data-action=beer]').isDisabled());assert(await sessionPage.locator('#claim-test-tokens').isDisabled());
  sessionRestored=false;await sessionPage.locator('#refresh').click();
  await sessionPage.waitForFunction(()=>document.getElementById('next-step').textContent==='Restore the original order'&&!document.getElementById('next-action').disabled);
  assert.equal(await sessionPage.locator('#payment-state').textContent(),'Session expired · restore access');
  await sessionPage.screenshot({path:join(output,'session-expired.png'),fullPage:true});
  await sessionPage.locator('#next-action').click();await sessionPage.waitForFunction(()=>document.getElementById('next-step').textContent==='UNKNOWN · keep this order');
  assert.equal(sessionPosts,2);assert.equal(otherPosts,0);
  check('Session expiry after an order was already rendered also exposes access-only recovery without losing its prior state');
  await sessionContext.close();check('Expired browser session restores the same order with access-only wallet consent while preserving original bytes, UNKNOWN and economic locks');
  const noJS=await browser.newContext({ignoreHTTPSErrors:true,javaScriptEnabled:false});const noJSPage=await noJS.newPage();await noJSPage.goto(origin+'/merchant');
  assert(await noJSPage.locator('noscript').isVisible());assert(await noJSPage.locator('#next-action').isDisabled());assert(await noJSPage.locator('#authorize').isDisabled());await noJS.close();
  check('Reduced-motion preference and no-JS merchant route retain explanation and disabled payment controls');

  assert.equal(errors.length,0,errors.join('\n'));
  check('No browser page errors or external runtime requests');
  writeFileSync(join(output,'restaurant-browser-report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({checks:report.checks.length,viewports:report.viewports,browser:report.browser,output,scope:report.scope}));
} finally { if(browser) await browser.close(); await new Promise(resolve=>server.close(resolve)); rmSync(temp,{recursive:true,force:true}); }
