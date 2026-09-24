/**
 * Ending the session, which is the last chance to let anything go.
 *
 * This was the untested part of the MCP mode, and it is the part where a
 * mistake is least visible: the process is going away, so nothing reports that
 * it went away still holding a port. The order matters, it must run once, and
 * it must reach the exit even when something below it refuses to finish.
 */

import { describe, expect, it } from '@jest/globals';
import { createShutdown } from '../../mcp/shutdown.js';

const never = () => new Promise<never>(() => {});

describe('createShutdown', () => {
  it('stops the proxies, then closes the server, then exits', async () => {
    const order: string[] = [];
    const shutdown = createShutdown({
      supervisor: {
        stop: async () => {
          order.push('stop');
          return [];
        },
      },
      closeServer: async () => {
        order.push('close');
      },
      exit: (code) => order.push(`exit ${code}`),
    });

    await shutdown('test');

    expect(order).toEqual(['stop', 'close', 'exit 0']);
  });

  it('runs once, however many signals arrive', async () => {
    let stops = 0;
    const shutdown = createShutdown({
      supervisor: {
        stop: async () => {
          stops += 1;
          return [];
        },
      },
      closeServer: async () => {},
      exit: () => {},
    });

    await Promise.all([shutdown('SIGINT'), shutdown('SIGTERM'), shutdown('stdin')]);

    expect(stops).toBe(1);
  });

  it('exits anyway when stopping refuses to finish', async () => {
    const exits: number[] = [];
    const shutdown = createShutdown({
      supervisor: { stop: never },
      closeServer: async () => {},
      exit: (code) => exits.push(code),
      deadlineMs: 30,
    });

    await shutdown('SIGTERM');

    // Without a deadline this is the process that ignores SIGTERM and keeps its
    // port — the failure the in-process design exists to avoid.
    expect(exits).toEqual([0]);
  });

  it('exits anyway when stopping throws', async () => {
    const exits: number[] = [];
    const shutdown = createShutdown({
      supervisor: {
        stop: async () => {
          throw new Error('broker refused to let go');
        },
      },
      closeServer: async () => {},
      exit: (code) => exits.push(code),
    });

    await shutdown('SIGINT');

    expect(exits).toEqual([0]);
  });

  it('exits anyway when closing the server hangs', async () => {
    const exits: number[] = [];
    const shutdown = createShutdown({
      supervisor: { stop: async () => [] },
      closeServer: never,
      exit: (code) => exits.push(code),
      deadlineMs: 30,
    });

    await shutdown('stdin closed');

    expect(exits).toEqual([0]);
  });

  it('never rejects, because nothing is left to catch it', async () => {
    const shutdown = createShutdown({
      supervisor: {
        stop: async () => {
          throw new Error('boom');
        },
      },
      closeServer: async () => {
        throw new Error('also boom');
      },
      exit: () => {},
    });

    // A signal handler has no caller. A rejection here is an unhandled one.
    await expect(shutdown('SIGTERM')).resolves.toBeUndefined();
  });
});
