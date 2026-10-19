import { EventEmitter } from 'node:events';
import { expect, test, vi } from 'vitest';
import { createHarness } from './fixture.ts';

vi.mock('@hono/node-server', () => ({
  serve: () => {
    const server = new EventEmitter();
    queueMicrotask(() => server.emit('error', new Error('fixture listener refused')));
    return server;
  },
}));

test('a listener startup error rejects the harness instead of exhausting every hook timeout', async () => {
  await expect(createHarness()).rejects.toThrow('fixture listener refused');
}, 2_000);
