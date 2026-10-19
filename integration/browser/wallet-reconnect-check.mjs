// Actual app/adapter with a local Wallet Standard fixture. No real wallet, RPC,
// usable signatures or economic calls; reload and account/race behavior are real.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync,readFileSync,writeFileSync,rmSync,mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:https';
import { once } from 'node:events';
import { serve } from '@hono/node-server';
import { createPresentationApp } from '../src/restaurant-server.ts';
const { chromium } = await import(pathToFileURL(process.env.RESTAURANT_PLAYWRIGHT_MODULE));
const temp=mkdtempSync(join(tmpdir(),'capture402-wallet-reconnect-'));
const output=process.env.RESTAURANT_QA_OUTPUT || temp;mkdirSync(output,{recursive:true});
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-keyout',join(temp,'key.pem'),'-out',join(temp,'cert.pem')],{stdio:'pipe'});
const payer='1'.repeat(32),other='2'.repeat(32),id='a'.repeat(32);
const info={programId:payer,network:'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',configured:true,merchant:payer,sponsor:payer,mint:payer,publicMerchantDemoEnabled:true,faucetEnabled:true};
const server=serve({fetch:createPresentationApp(info).fetch,hostname:'127.0.0.1',port:0,createServer,serverOptions:{key:readFileSync(join(temp,'key.pem')),cert:readFileSync(join(temp,'cert.pem'))}});
await once(server,'listening');const origin=`https://127.0.0.1:${server.address().port}`;
const report={scope:'Local HTTPS app/Wallet Standard fixtures only; no live-wallet acceptance.',sourceSha256:Object.fromEntries(['app.js','wallet.js'].map(n=>[n,createHash('sha256').update(readFileSync(new URL('../web/'+n,import.meta.url))).digest('hex')])),checks:[],errors:[],economicPosts:0};
let browser;
const check=name=>report.checks.push(name);
try {
  browser=await chromium.launch({headless:true});
  async function fixture({name='Remembered fixture',late=false,seed=false}={}) {
    const context=await browser.newContext({ignoreHTTPSErrors:true});
    await context.addInitScript(({name,late,seed,payer,other})=>{
      const account=address=>({address,chains:['solana:devnet'],features:['solana:signTransaction','solana:signMessage']});
      if(seed&&!localStorage.getItem('fixture-seeded')) {localStorage.setItem('capture402-wallet',JSON.stringify({name,address:payer}));localStorage.setItem('fixture-seeded','true');}
      window.fixtureConnects=[];window.fixtureSigns=0;window.fixtureMessages=0;window.fixtureListeners=new Set();
      const mode=()=>localStorage.getItem('fixture-mode');
      const wallet={name,features:{'standard:connect':{connect:async input=>{
        window.fixtureConnects.push(input??null);
        if(input?.silent&&mode()==='locked')throw Error('Wallet locked');
        if(input?.silent&&mode()==='race')return new Promise(resolve=>window.resolveSilent=()=>resolve({accounts:[account(payer)]}));
        return{accounts:[account(mode()==='wrong'||mode()==='race'&&!input?.silent?other:payer)]};
      }},'standard:events':{on:(_event,fn)=>{window.fixtureListeners.add(fn);return()=>window.fixtureListeners.delete(fn);}},'solana:signTransaction':{supportedTransactionVersions:['legacy'],signTransaction:async()=>{window.fixtureSigns++;throw Error('No transaction signature allowed');}},'solana:signMessage':{signMessage:async()=>{window.fixtureMessages++;throw Error('No message signature allowed');}}}};
      window.addEventListener('wallet-standard:app-ready',e=>{window.fixtureRegister=()=>e.detail.register(wallet);if(!late)window.fixtureRegister();},{once:true});
      window.fixtureDisconnect=()=>{for(const notify of window.fixtureListeners)notify({accounts:[]});};
    },{name,late,seed,payer,other});
    const page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));
    page.on('request',r=>{assert.equal(new URL(r.url()).origin,origin);if(r.method()==='POST')report.economicPosts++;});
    await page.route('**/api/orders/**',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({id,payer,payment:payer,scenario:'normal',status:'active',authorized:100,captured:0,remaining:100,refunded:0,released:0,heldBaseUnits:'100000000',refundableBaseUnits:'0',now:Math.floor(Date.now()/1000),captureDeadline:Math.floor(Date.now()/1000)+150,refundDeadline:Math.floor(Date.now()/1000)+180,events:[],actions:{beer:true},actionReasons:{},balances:{payer:{amount:900,reason:''},merchant:{amount:0,reason:''}}})}));
    await page.goto(origin+'/customer');await page.waitForFunction(()=>document.getElementById('program-id').querySelector('a'));
    return{context,page};
  }
  const {context,page}=await fixture();
  assert.deepEqual(await page.evaluate(()=>window.fixtureConnects),[]);assert.equal(await page.evaluate(()=>localStorage.getItem('capture402-wallet')),null);
  await page.locator('#connect-wallet').click();await page.locator('#wallet-list button').first().click();await page.waitForFunction(p=>document.getElementById('payer-key').textContent===p,payer);
  assert.deepEqual(await page.evaluate(()=>window.fixtureConnects),[null]);
  assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('capture402-wallet'))),{name:'Remembered fixture',address:payer});
  check('Fresh visitor gets no automatic connect; explicit selection stores only wallet name and public address');
  await page.evaluate(id=>{localStorage.setItem('capture402-order',id);localStorage.setItem('capture402-uncertain',id);localStorage.setItem(`capture402-signed-${id}`,'retained-original');},id);
  await page.reload();await page.waitForFunction(p=>document.getElementById('payer-key').textContent===p,payer);
  assert.deepEqual(await page.evaluate(()=>window.fixtureConnects),[{silent:true}]);assert.equal(await page.locator('#wallet-dialog').evaluate(e=>e.open),false);
  assert(await page.locator('[data-action=beer]').isDisabled());
  assert.deepEqual(await page.evaluate(id=>[localStorage.getItem('capture402-order'),localStorage.getItem('capture402-uncertain'),localStorage.getItem(`capture402-signed-${id}`),window.fixtureSigns,window.fixtureMessages],id),[id,id,'retained-original',0,0]);
  check('Reload reconnects silently to the same account without dialog, signatures, merchant consent or custody changes');
  await page.evaluate(()=>localStorage.setItem('fixture-mode','locked'));await page.reload();await page.waitForFunction(()=>window.fixtureConnects.length===1);
  assert.equal(await page.locator('#payer-key').textContent(),'No wallet connected');assert.deepEqual(await page.evaluate(()=>window.fixtureConnects),[{silent:true}]);
  await page.evaluate(()=>window.fixtureRegister());await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>window.fixtureConnects.length),1);
  assert.equal(await page.locator('#wallet-dialog').evaluate(e=>e.open),false);check('Locked wallet gets one silent attempt and no interactive fallback or repeated discovery attempts');
  await page.evaluate(()=>localStorage.setItem('fixture-mode','wrong'));await page.reload();await page.waitForFunction(()=>window.fixtureConnects.length===1);
  assert.equal(await page.locator('#payer-key').textContent(),'No wallet connected');assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('capture402-wallet')).address),payer);
  check('A different authorized account is never silently substituted for the remembered payer');
  await page.evaluate(()=>localStorage.removeItem('fixture-mode'));await page.reload();await page.waitForFunction(p=>document.getElementById('payer-key').textContent===p,payer);
  await page.evaluate(()=>window.fixtureDisconnect());await page.waitForFunction(()=>document.getElementById('payer-key').textContent==='No wallet connected');
  assert.equal(await page.evaluate(()=>localStorage.getItem('capture402-wallet')),null);await page.reload();
  assert.deepEqual(await page.evaluate(()=>window.fixtureConnects),[]);check('Wallet disconnect clears the preference and prevents reconnect on the next reload');await context.close();
  const delayed=await fixture({late:true,seed:true});assert.equal(await delayed.page.locator('#payer-key').textContent(),'No wallet connected');
  await delayed.page.evaluate(()=>window.fixtureRegister());await delayed.page.waitForFunction(p=>document.getElementById('payer-key').textContent===p,payer);
  assert.deepEqual(await delayed.page.evaluate(()=>window.fixtureConnects),[{silent:true}]);check('Wallet discovery after configuration load still restores the remembered account');await delayed.context.close();
  const race=await fixture({seed:true});await race.page.waitForFunction(p=>document.getElementById('payer-key').textContent===p,payer);
  await race.page.evaluate(()=>localStorage.setItem('fixture-mode','race'));await race.page.reload();await race.page.waitForFunction(()=>typeof window.resolveSilent==='function');
  await race.page.locator('#connect-wallet').click();await race.page.locator('#wallet-list button').first().click();await race.page.waitForFunction(p=>document.getElementById('payer-key').textContent===p,other);
  await race.page.evaluate(()=>window.resolveSilent());await race.page.waitForTimeout(100);
  assert.equal(await race.page.locator('#payer-key').textContent(),other);assert.equal(await race.page.evaluate(()=>window.fixtureListeners.size),1);
  check('An explicit wallet/account choice wins over a late silent result; the stale event subscription is removed');await race.context.close();
  const solflare=await fixture({name:'Solflare',seed:true});await solflare.page.waitForFunction(p=>document.getElementById('payer-key').textContent===p,payer);
  assert.equal(await solflare.page.locator('iframe').count(),0);assert.deepEqual(await solflare.page.evaluate(()=>[window.fixtureSigns,window.fixtureMessages]),[0,0]);
  check('Solflare reconnect restores identity without opening the SDK iframe or asking for any signature');await solflare.context.close();
  assert.equal(report.economicPosts,0);assert.deepEqual(report.errors,[]);check('All reconnect paths produce zero economic POSTs and browser errors');
  writeFileSync(join(output,'wallet-reconnect-browser-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({checks:report.checks.length,economicPosts:report.economicPosts,errors:report.errors.length}));
} finally {if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));rmSync(temp,{recursive:true,force:true});}
