/**
 * Taking a port without racing for it.
 *
 * The requirement is that two sessions never collide, and the way to get that
 * is to bind port 0 and ask what was bound — not to probe for a free port and
 * then bind it, which leaves a window for someone else to take it in between.
 */

import { afterEach, describe, expect, it } from '@jest/globals';
import { createServer, type Server } from 'node:http';
import { listenOnFreePort } from '../../mcp/ports.js';

const opened: Server[] = [];

afterEach(async () => {
  await Promise.all(
    opened.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

function server(): Server {
  const s = createServer(() => {});
  opened.push(s);
  return s;
}

describe('listenOnFreePort', () => {
  it('reports the port it actually bound', async () => {
    const s = server();

    const port = await listenOnFreePort(s, '127.0.0.1');

    expect(port).toBeGreaterThan(0);
    const address = s.address();
    expect(typeof address === 'object' && address?.port).toBe(port);
  });

  it('gives two servers two ports', async () => {
    const first = await listenOnFreePort(server(), '127.0.0.1');
    const second = await listenOnFreePort(server(), '127.0.0.1');

    expect(second).not.toBe(first);
  });

  it('binds the host it is given', async () => {
    const s = server();

    await listenOnFreePort(s, '127.0.0.1');

    const address = s.address();
    expect(typeof address === 'object' && address?.address).toBe('127.0.0.1');
  });

  it('surfaces a bind failure rather than hanging', async () => {
    const s = server();

    await expect(
      listenOnFreePort(s, '203.0.113.1'), // TEST-NET-3, not a local address
    ).rejects.toThrow();
  });
});
