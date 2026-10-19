// Capability-free public preview: no accepted deployment, RPC, signer or durable store.
import { serve } from '@hono/node-server';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createPresentationApp } from './restaurant-server.ts';

export function startPresentationPreview(port = 18788) {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw Error('invalid preview port');
  const app = createPresentationApp({ programId: '', network: 'unconfigured', configured: false, reason: 'Presentation preview only; deployment is not configured.' });
  return serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, info => {
    console.log(JSON.stringify({ preview: true, host: '127.0.0.1', port: info.port, configured: false }));
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { startPresentationPreview(process.argv[2] === undefined ? 18788 : Number(process.argv[2])); }
  catch { console.error('Presentation preview could not start.'); process.exitCode = 1; }
}
