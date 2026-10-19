// Real browser rendering against synthetic HTTPS API responses only. No RPC,
// usable signatures, wallet approval, treasury funding or economic submission.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:https';
import { once } from 'node:events';
import { serve } from '@hono/node-server';
import { createPresentationApp } from '../src/restaurant-server.ts';
import { CIRCLE_PROFILE, CIRCLE_MINT, DEVNET_PROGRAM, DEVNET_NETWORK } from '../src/payment-profile.ts';
const { chromium }=await import(pathToFileURL(process.env.RESTAURANT_PLAYWRIGHT_MODULE));
const temp=mkdtempSync(join(tmpdir(),'capture402-circle-dom-'));
const output=process.env.RESTAURANT_QA_OUTPUT??temp;
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-keyout',join(temp,'key.pem'),'-out',join(temp,'cert.pem')],{stdio:'pipe'});
const identity='11111111111111111111111111111111';
const info={programId:DEVNET_PROGRAM,network:DEVNET_NETWORK,configured:true,merchant:identity,sponsor:identity,mint:CIRCLE_MINT,
  faucetEnabled:true,paymentProfile:CIRCLE_PROFILE,profileHash:'a'.repeat(64)};
const app=createPresentationApp(info);
const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0,createServer,serverOptions:{key:readFileSync(join(temp,'key.pem')),cert:readFileSync(join(temp,'cert.pem'))}});
await once(server,'listening');
const origin=`https://127.0.0.1:${server.address().port}`;
const id='b'.repeat(32),signature='2'.repeat(88);
let browser,state,availability={available:true,reason:''},posts=0;
const report={scope:'Local Circle-profile DOM fixtures only; no Devnet or economic acceptance',checks:[],browser:''};
try {
  browser=await chromium.launch({headless:true});report.browser=browser.version();
  const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[];
  page.setDefaultTimeout(15000);page.setDefaultNavigationTimeout(15000);
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>{
    const req=route.request(),url=new URL(req.url());assert.equal(url.origin,origin,'loopback requests only');
    if(req.method()==='POST'){posts++;throw Error('DOM fixture must never submit');}
    const data=url.pathname==='/api/faucet/status'?availability:url.pathname===`/api/orders/${id}`?state:undefined;
    if(data)return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
    return route.continue();
  });
  await page.addInitScript(({identity})=>{
    window.addEventListener('wallet-standard:app-ready',event=>event.detail.register({name:'Synthetic Circle DOM wallet',accounts:[{address:identity,chains:['solana:devnet'],features:['solana:signTransaction']}],features:{
      'standard:connect':{connect:async()=>({accounts:[{address:identity,chains:['solana:devnet'],features:['solana:signTransaction']}]})},
      'solana:signTransaction':{supportedTransactionVersions:['legacy'],signTransaction:async()=>{throw Error('DOM fixture cannot sign');}}
    }}),{once:true});
  },{identity});
  await page.goto(origin+'/customer');
  await page.evaluate(identity=>localStorage.setItem('capture402-wallet',JSON.stringify({name:'Synthetic Circle DOM wallet',address:identity})),identity);
  await page.reload();await page.waitForFunction(()=>document.getElementById('payer-key').textContent==='11111111111111111111111111111111');
  await page.locator('#advanced').evaluate(e=>e.open=true);
  assert.equal(await page.locator('#claim-test-tokens').textContent(),'Get 0.50 Devnet USDC');
  assert.equal(await page.locator('#authorize').textContent(),'Authorize up to 0.10 USDC');
  assert.equal(await page.locator('[data-action=beer]').textContent(),'Capture 0.04 USDC');
  assert.equal(await page.locator('[data-action=salmon]').textContent(),'Capture 0.025 USDC');
  assert.equal(await page.locator('#finish').textContent(),'Release 0.035 USDC');
  assert.equal(await page.locator('[data-action=refund]').textContent(),'Refund 0.01 USDC');
  assert.equal(await page.locator('#terms-heading').textContent(),'0.10 USDC maximum');
  report.checks.push('All Circle claim, authorization, captures, release and refund labels use the approved profile');
  const now=Math.floor(Date.now()/1000);
  state={id,payer:identity,payment:identity,scenario:'normal',status:'draft',authorized:0,captured:0,remaining:0,refunded:0,released:0,
    captureDeadline:now+150,refundDeadline:now+180,now,events:[],actions:{},actionReasons:{},balances:{payer:{amount:0.5,reason:''},merchant:{amount:0,reason:''}},
    required:{accepts:[{amount:'100000',asset:CIRCLE_MINT}]},unsigned:'synthetic-never-signed'};
  await page.evaluate(id=>localStorage.setItem('capture402-order',id),id);await page.reload();
  await page.locator('#advanced').evaluate(e=>e.open=true);await page.waitForFunction(()=>document.getElementById('next-action').textContent==='Authorize up to 0.10 USDC');
  assert.equal(await page.locator('#authorize').isEnabled(),true);report.checks.push('0.50 payer balance permits a 0.10 offer; no legacy 100-token threshold');
  state={...state,status:'closed',authorized:0.1,captured:0.065,remaining:0,refunded:0,released:0.035,heldBaseUnits:'0',refundableBaseUnits:'65000',
    events:[{action:'beer',label:'Capture',amount:0.04,status:'finalized',at:new Date().toISOString(),signature,chainStatus:{commitment:'finalized',err:null}}]};
  await page.locator('#refresh').click();await page.waitForFunction(()=>document.getElementById('bar-paid').style.width==='65%');
  assert.equal(await page.locator('#bar-returned').evaluate(e=>e.style.width),'35%');
  await page.locator('#receipt-details').evaluate(e=>e.open=true);
  assert((await page.locator('#timeline').textContent()).includes(signature));assert((await page.locator('#timeline a').getAttribute('href')).endsWith('?cluster=devnet'));
  report.checks.push('65/35 percent bars, six-decimal amounts and full original signature with Devnet Explorer link');
  for(const reason of ['Treasury token supply low; operator refill required.','Claim cooldown active: one claim per 24 hours.','Original faucet operation pending or UNKNOWN.','Devnet RPC unavailable; claims paused.']) {
    availability={available:false,reason};await page.locator('#refresh').click();
    await page.waitForFunction(reason=>document.getElementById('faucet-availability').textContent===reason,reason);
    assert(await page.locator('#claim-test-tokens').isDisabled());
  }
  report.checks.push('Empty treasury, cooldown, UNKNOWN and RPC unavailability disable the claim control');
  for(const width of [1440,390,320]) {
    await page.setViewportSize({width,height:1000});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width,`${width}px horizontal overflow`);
    await page.screenshot({path:join(output,`circle-usdc-${width}.png`),fullPage:true});
  }
  assert.deepEqual(errors,[]);assert.equal(posts,0);
  report.checks.push('Three viewport widths, no browser errors and zero POST/signing operations');
  writeFileSync(join(output,'circle-usdc-dom.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));rmSync(temp,{recursive:true,force:true});}
