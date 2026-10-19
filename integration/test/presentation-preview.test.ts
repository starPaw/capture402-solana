// Actual empty-environment entrypoint, not a mocked restaurant main prefix.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { test, expect } from 'vitest';

test('unconfigured public preview starts without installed data and has no economic backend', async () => {
  const child = spawn(process.execPath, ['--experimental-strip-types', resolve('src/presentation-preview.ts'), '0'], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', errors = '';
  child.stderr.on('data', data => { errors += data.toString(); });
  try {
    const info = await new Promise<{port:number; host:string; configured:boolean}>((accept, reject) => {
      const timeout = setTimeout(() => reject(Error('preview startup timeout')), 10000);
      child.once('exit', code => { clearTimeout(timeout); reject(Error(`preview exited ${code}: ${errors}`)); });
      child.stdout.on('data', data => {
        output += data.toString();
        if (output.includes('\n')) { clearTimeout(timeout); try { accept(JSON.parse(output.split('\n')[0]!)); } catch (e) { reject(e); } }
      });
    });
    expect(info).toMatchObject({host:'127.0.0.1',configured:false});
    const origin = `http://127.0.0.1:${info.port}`;
    expect((await fetch(origin+'/')).status).toBe(200);
    expect((await fetch(origin+'/integrate')).status).toBe(200);
    const config = await (await fetch(origin+'/api/config')).json() as any;
    expect(config).toMatchObject({configured:false,network:'unconfigured',programId:''});
    for (const route of ['/resource','/api/orders','/api/private']) {
      expect((await fetch(origin+route, {method:'POST'})).status).toBe(503);
    }
  } finally {
    const exit = once(child, 'exit');
    child.kill('SIGTERM');
    if (child.exitCode === null) await exit;
  }
}, 15000);
