// Synthetic, loopback-only ingress checks. No RPC, signer or live service exists.
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { serve, type ServerType } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createPresentationApp } from '../src/restaurant-server.ts';
import { createRestaurantApp, DEMO_BUDGET, RestaurantOrders, type RestaurantConfig } from '../src/restaurant.ts';
import { FileSubmissionJournal } from '../src/submission-journal.ts';

const fragments = [
  ['stable', 'nginx-resource.conf', 8788],
  ['development', 'dev/nginx-routes.conf', 18888],
  ['e2e', 'e2e/nginx-public-demo.conf', 28888],
  ['main-circle', 'main/nginx-public-demo.conf', 8898],
] as const;
const readFragment = (name:string) => readFileSync(new URL(`../deploy/${name}`, import.meta.url), 'utf8');

test.each(fragments)('%s ingress admits the exact profile module as GET only', (_environment, name) => {
  const blocks = [...readFragment(name).matchAll(/location ~ "([^"]+)" \{([^}]+\}[^}]*?)\n\}/g)];
  const matches = blocks.filter(m => new RegExp(m[1]!.replaceAll('\\\\', '\\')).test('/assets/payment-profile.js'));
  expect(matches).toHaveLength(1);
  expect(matches[0]![2]).toContain('if ($request_method != GET) { return 405; }');
  const pattern = new RegExp(matches[0]![1]!.replaceAll('\\\\', '\\'));
  for (const path of ['/assets/payment-profile.js/', '/assets/payment-profile.js.extra', '/assets/payment-profileXjs', '/assets/private.js']) expect(pattern.test(path)).toBe(false);
});

test('only separately installed public campaigns expose the exact read-only faucet status route', () => {
  for(const [name,port] of [['e2e/nginx-public-demo.conf',28888],['main/nginx-public-demo.conf',8898]] as const) {
    const match = readFragment(name).match(/location = \/api\/faucet\/status \{([\s\S]*?)\n\}/);
    expect(match).not.toBeNull();
    expect(match![1]).toContain('if ($request_method != GET) { return 405; }');
    expect(match![1]).toContain(`proxy_pass http://127.0.0.1:${port};`);
  }
  for (const name of ['nginx-resource.conf', 'dev/nginx-routes.conf']) expect(readFragment(name)).not.toContain('/api/faucet/status');
});

async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as import('node:net').AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  return port;
}

for (const [environment, name, originalPort] of fragments) describe.skipIf(!process.env.SAC006_TEST_NGINX)(`${environment} Circle ingress through real nginx HTTPS`, () => {
  let directory:string, backend:ServerType|undefined, nginx:ChildProcess|undefined, origin:string, ca:Buffer;
  let availability = { available:true, reason:'', nextEligibleAt:0 };
  const received:string[] = [], upstream:string[] = [];
  const identity = '11111111111111111111111111111111';
  function https(path:string, method='GET') {
    return new Promise<{status:number;body:string;type:string|undefined}>((resolve,reject) => {
      const req = request(new URL(path, origin), {method, ca, agent:false}, res => {
        const chunks:Buffer[] = [];
        res.on('data', chunk => chunks.push(Buffer.from(chunk)));
        res.on('end', () => resolve({status:res.statusCode!,body:Buffer.concat(chunks).toString(),type:res.headers['content-type']}));
        res.on('error', reject);
      });
      req.on('error', reject); req.setTimeout(5000, () => req.destroy(Error('isolated nginx timeout'))); req.end();
    });
  }
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'circle-ingress-'));
    execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost',
      '-addext','subjectAltName=IP:127.0.0.1','-keyout',join(directory,'key.pem'),'-out',join(directory,'cert.pem')], {stdio:'pipe'});
    ca = readFileSync(join(directory,'cert.pem'));
    // The real restaurant status handler forwards only read-only requests to this
    // synthetic faucet. Access to an economic endpoint or RPC is never required.
    const config = {amount:DEMO_BUDGET,origin:'https://synthetic.invalid',
      orders:new RestaurantOrders(join(directory,'orders')),reclaimJournal:new FileSubmissionJournal(join(directory,'reclaims')),
      faucet:{request:async(path:string, method:string) => {
        expect(method).toBe('GET'); expect(path).toMatch(/^\/status(?:\?recipient=[1-9A-HJ-NP-Za-km-z]{32,44})?$/);
        received.push(path); return Response.json(availability);
      }},
    } as unknown as RestaurantConfig;
    const app = createPresentationApp({programId:identity,network:'synthetic',configured:true}, createRestaurantApp(config));
    backend = serve({hostname:'127.0.0.1',port:0,fetch:req => {upstream.push(new URL(req.url).pathname);return app.fetch(req);}});
    await once(backend,'listening');
    const backendPort = (backend.address() as import('node:net').AddressInfo).port;
    const fragment = readFragment(name).replaceAll(`http://127.0.0.1:${originalPort}`, `http://127.0.0.1:${backendPort}`);
    writeFileSync(join(directory,'routes.conf'), fragment);
    origin = `https://127.0.0.1:${await freePort()}`;
    writeFileSync(join(directory,'nginx.conf'), `daemon off;
master_process off;
pid "${directory}/nginx.pid";
error_log stderr notice;
events { worker_connections 64; }
http {
  access_log off;
  map $request_method $capture402_e2e_public_post { default ""; POST $binary_remote_addr; }
  limit_req_zone $capture402_e2e_public_post zone=capture402_e2e_demo_public:1m rate=20r/m;
  map $request_method $capture402_main_public_post { default ""; POST $binary_remote_addr; }
  limit_req_zone $capture402_main_public_post zone=capture402_main_demo_public:1m rate=20r/m;
  client_body_temp_path "${directory}/body";
  proxy_temp_path "${directory}/proxy";
  server {
    listen 127.0.0.1:${new URL(origin).port} ssl;
    ssl_certificate "${directory}/cert.pem";
    ssl_certificate_key "${directory}/key.pem";
    include "${directory}/routes.conf";
  }
}
`);
    const args = ['-e','stderr','-p',directory+'/','-c',join(directory,'nginx.conf')];
    const validated = spawnSync(process.env.SAC006_TEST_NGINX!, ['-t',...args], {encoding:'utf8'});
    expect(validated.status, validated.stderr).toBe(0);
    nginx = spawn(process.env.SAC006_TEST_NGINX!, args, {stdio:['ignore','ignore','pipe']});
    let errors = ''; nginx.stderr!.on('data', data => {errors += data.toString();});
    let ready = false;
    for (let i=0; i<50; i++) {
      if (nginx.exitCode!==null) throw Error(errors);
      try {if ((await https('/api/config')).status===200) {ready=true;break;}} catch { /* bounded local startup */ }
      await delay(100);
    }
    expect(ready, errors).toBe(true);
  });
  afterAll(async () => {
    if (nginx && nginx.exitCode===null) {const closed=once(nginx,'exit');nginx.kill('SIGTERM');await closed;}
    if (backend?.listening) await new Promise<void>((resolve,reject) => backend!.close(e => e ? reject(e) : resolve()));
    if (directory) rmSync(directory,{recursive:true,force:true});
  });
  test('profile dependency bytes and MIME survive ingress, with exact path and method denials', async () => {
    for (const name of ['app.js','wallet.js','payment-profile.js']) {
      const response = await https('/assets/'+name);
      expect(response.status).toBe(200);expect(response.type).toBe('text/javascript; charset=utf-8');
      expect(response.body).toBe(readFileSync(new URL(`../web/${name}`,import.meta.url),'utf8'));
    }
    const before=upstream.length;
    for (const method of ['HEAD','POST','PUT','PATCH','DELETE','OPTIONS']) expect((await https('/assets/payment-profile.js',method)).status).toBe(405);
    for (const path of ['/assets/payment-profile.js/','/assets/payment-profile.js.extra','/assets/payment-profileXjs']) expect((await https(path)).status).toBe(404);
    expect(upstream).toHaveLength(before);
  });
  test('status preserves recipient and availability through approved public campaigns, with no facilitator route exposed', async () => {
    if (environment==='e2e' || environment==='main-circle') {
      for (const state of [{available:true,reason:'',nextEligibleAt:0},
        {available:false,reason:'Treasury token supply low; operator refill required.',nextEligibleAt:0},
        {available:false,reason:'Claim cooldown active: one claim per 24 hours.',nextEligibleAt:2000000000},
        {available:false,reason:'Original faucet operation pending or UNKNOWN.',nextEligibleAt:0},
        {available:false,reason:'Devnet RPC unavailable; claims paused.',nextEligibleAt:0},
        {available:false,reason:'Treasury status rate limit active; check again later.',nextEligibleAt:0}]) {
        availability=state;
        const response=await https('/api/faucet/status?recipient='+identity);
        expect(response.status).toBe(200);expect(JSON.parse(response.body)).toEqual(state);
        expect(received.at(-1)).toBe('/status?recipient='+identity);
      }
      expect((await https('/api/faucet/status')).status).toBe(200);expect(received.at(-1)).toBe('/status');
      const count=received.length;
      expect((await https('/api/faucet/status?recipient=invalid')).status).toBe(400);expect(received).toHaveLength(count);
      const before=upstream.length;
      for (const method of ['HEAD','POST','PUT','PATCH','DELETE','OPTIONS']) expect((await https('/api/faucet/status',method)).status).toBe(405);
      expect(upstream).toHaveLength(before);
    } else {
      const before=upstream.length;
      expect((await https('/api/faucet/status?recipient='+identity)).status).toBe(404);expect(upstream).toHaveLength(before);expect(received).toEqual([]);
    }
    const before=upstream.length;
    for (const path of ['/api/faucet/status/','/api/faucet/status.extra','/faucet/status','/faucet/claim','/settle','/verify']) expect((await https(path)).status).toBe(404);
    expect(upstream).toHaveLength(before);
  });
});
