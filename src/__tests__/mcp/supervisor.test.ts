/**
 * What the MCP mode owns: listeners started in THIS process.
 *
 * The requirement driving every test here is "hold nothing that is not
 * needed". So the assertions are about release, not about starting: a stopped
 * instance must have given its port back — asserted by binding it again, not
 * by trusting the return value — and must have left no timer running and no
 * record behind.
 */

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootedAt, InstanceRegistry } from '../../mcp/registry.js';
import { ProxySupervisor } from '../../mcp/supervisor.js';

let dir: string;
let supervisor: ProxySupervisor;

const facade = {
  getAuthorizationHeader: async () => 'Bearer t',
  getTargetUrl: async () => 'http://127.0.0.1:1',
};

/**
 * A loaded proxy config. The port in it is deliberately one that collides —
 * four of the real configs say 3001 — because the supervisor is supposed to
 * ignore it and take a free one.
 */
const cfg = (destination: string) =>
  ({ btpDestination: destination, httpPort: 3001 }) as never;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'supervisor-'));
  supervisor = new ProxySupervisor({
    registry: new InstanceRegistry(dir, () => true),
    proxyFor: async () => facade as never,
  });
});

afterEach(async () => {
  await supervisor.stop();
  rmSync(dir, { recursive: true, force: true });
});

/** Can this port be taken? The only honest question about a released port. */
function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe: Server = createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

/** A backend that starts a response and never finishes it — an event stream. */
async function neverEndingBackend(): Promise<{ url: string; close: () => void }> {
  const open: import('node:http').ServerResponse[] = [];
  const backend = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: first\n\n');
    open.push(res);
  });
  await new Promise<void>((r) => backend.listen(0, '127.0.0.1', r));
  const address = backend.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => {
      for (const res of open) res.end();
      backend.close();
    },
  };
}

/** Open a request through the proxy and resolve on its first byte. */
function firstByteThrough(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path: '/sse', method: 'GET',
        headers: { 'x-sap-destination': 'D1' } },
      (res) => res.once('data', () => resolve()),
    );
    req.on('error', reject);
    req.end();
  });
}

describe('ProxySupervisor', () => {
  it('starts a listener on a free port and reports where it is', async () => {
    const started = await supervisor.start({ name: 'cfg-D1', config: cfg('D1') });

    expect(started.port).toBeGreaterThan(0);
    expect(started.url).toBe(`http://127.0.0.1:${started.port}`);
    expect(await portIsFree(started.port)).toBe(false);
  });

  it('ignores the port written in the config, which is how they collide', async () => {
    const started = await supervisor.start({
      name: 'cfg-D1',
      config: cfg('D1'),
    });

    // Four of the configs on disk say 3001. Honouring that is the bug.
    expect(started.port).not.toBe(3001);
  });

  // Without this, the interactive browser login fires on the FIRST FORWARDED
  // REQUEST — which means a browser window opening in the middle of some
  // unrelated tool call, a five-minute timeout, and a 502 whose reason only
  // reaches stderr. The agent asked for a proxy here; this is where it should
  // learn it cannot have one.
  it('proves the credential works before reporting the proxy as running', async () => {
    let asked = 0;
    const priming = new ProxySupervisor({
      registry: new InstanceRegistry(dir, () => true),
      proxyFor: async () =>
        ({
          getAuthorizationHeader: async () => {
            asked += 1;
            return 'Bearer t';
          },
          getTargetUrl: async () => 'http://127.0.0.1:1',
        }) as never,
    });
    try {
      await priming.start({ name: 'cfg-D1', config: cfg('D1') });
      expect(asked).toBe(1);
    } finally {
      await priming.stop();
    }
  });

  it('does not report a proxy as running when its credential cannot be had', async () => {
    const failing = new ProxySupervisor({
      registry: new InstanceRegistry(dir, () => true),
      proxyFor: async () =>
        ({
          getAuthorizationHeader: async () => {
            throw new Error('Service key file not found for destination "D1"');
          },
          getTargetUrl: async () => 'http://127.0.0.1:1',
        }) as never,
    });

    try {
      await expect(
        failing.start({ name: 'cfg-D1', config: cfg('D1') }),
      ).rejects.toThrow(/Service key file not found/);

      // And nothing is left behind by the attempt.
      expect(failing.mine()).toEqual([]);
      expect(new InstanceRegistry(dir, () => true).live()).toEqual([]);
    } finally {
      // Without this, a start that unexpectedly SUCCEEDS leaves a listener open
      // and Jest waits on that handle forever — which is what it did.
      await failing.stop();
    }
  });

  it('leaves nothing running when the record cannot be written', async () => {
    let disposed = 0;
    const registry = new InstanceRegistry(dir, () => true);
    registry.record = () => {
      throw new Error('EACCES: read-only file system');
    };
    const failing = new ProxySupervisor({
      registry,
      proxyFor: async () =>
        ({ ...facade, dispose: () => { disposed += 1; } }) as never,
    });

    // The listener is bound before the record is written. A throw there used to
    // reject `start()` while leaving the port held, the credential alive, the
    // instance in `owned`, and no idle timer to ever clean it up.
    await expect(
      failing.start({ name: 'cfg-D1', config: cfg('D1') }),
    ).rejects.toThrow(/read-only/);

    expect(failing.mine()).toEqual([]);
    expect(disposed).toBe(1);
  });

  it('binds loopback when nothing says otherwise', async () => {
    const started = await supervisor.start({ name: 'c', config: cfg('D1') });

    expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
  });

  it('honours httpHost from the config', async () => {
    const started = await supervisor.start({
      name: 'c',
      config: { btpDestination: 'D1', httpPort: 3001, httpHost: '0.0.0.0' } as never,
    });

    // Loopback was never a boundary — anything with a shell can forward the
    // port. Refusing to bind elsewhere only stopped the honest case.
    expect(started.url).toMatch(/^http:\/\/0\.0\.0\.0:/);
  });

  it('lets the caller override the host for one start', async () => {
    const started = await supervisor.start({
      name: 'c',
      config: cfg('D1'),
      host: '0.0.0.0',
    });

    expect(started.url).toMatch(/^http:\/\/0\.0\.0\.0:/);
  });

  it('never puts two instances on one port', async () => {
    const first = await supervisor.start({ name: 'cfg-D1', config: cfg('D1') });
    const second = await supervisor.start({ name: 'cfg-D2', config: cfg('D2') });

    expect(second.port).not.toBe(first.port);
  });

  it('writes a record other sessions can see', async () => {
    const started = await supervisor.start({ name: 'cfg-D1', config: cfg('D1') });

    expect(new InstanceRegistry(dir, () => true).live()).toEqual([
      expect.objectContaining({
        port: started.port,
        destination: 'D1',
        config: 'cfg-D1',
        pid: process.pid,
      }),
    ]);
  });

  it('gives the port back on stop', async () => {
    const started = await supervisor.start({ name: 'cfg-D1', config: cfg('D1') });

    await supervisor.stop(started.instanceId);

    expect(await portIsFree(started.port)).toBe(true);
  });

  it('takes its record with it on stop', async () => {
    const started = await supervisor.start({ name: 'cfg-D1', config: cfg('D1') });

    await supervisor.stop(started.instanceId);

    expect(new InstanceRegistry(dir, () => true).live()).toEqual([]);
  });

  it('stops every instance it owns when asked for none in particular', async () => {
    const first = await supervisor.start({ name: 'cfg-D1', config: cfg('D1') });
    const second = await supervisor.start({ name: 'cfg-D2', config: cfg('D2') });

    const stopped = await supervisor.stop();

    expect(stopped.map((s) => s.instanceId).sort()).toEqual(
      [first.instanceId, second.instanceId].sort(),
    );
    expect(supervisor.mine()).toEqual([]);
  });

  it('stops only the instance named, leaving the others alone', async () => {
    const first = await supervisor.start({ name: 'cfg-D1', config: cfg('D1') });
    const second = await supervisor.start({ name: 'cfg-D2', config: cfg('D2') });

    await supervisor.stop(first.instanceId);

    expect(supervisor.mine().map((m) => m.instanceId)).toEqual([
      second.instanceId,
    ]);
    expect(await portIsFree(second.port)).toBe(false);
  });

  it('reports nothing stopped for an instance it does not own', async () => {
    await supervisor.start({ name: 'cfg-D1', config: cfg('D1') });

    const stopped = await supervisor.stop('someone-elses-instance');

    expect(stopped).toEqual([]);
    expect(supervisor.mine()).toHaveLength(1);
  });

  it('stops an instance that has been idle too long', async () => {
    const started = await supervisor.start({
      name: 'cfg-D1',
      config: cfg('D1'),
      idleTimeoutMs: 40,
    });

    await new Promise((resolve) => setTimeout(resolve, 140));

    // The backstop for an agent that finished and forgot: a proxy holds a port
    // and live credentials for as long as it runs.
    expect(supervisor.mine()).toEqual([]);
    expect(await portIsFree(started.port)).toBe(true);
  });

  // The failure this caught: `server.close()` waits for ACTIVE connections, and
  // a stream never becomes inactive. Measured on Node 26.7.0 — the close
  // callback had not fired after 1500ms. So `proxy_stop` never returned, and
  // because the shutdown path awaits the same call, SIGINT, SIGTERM and stdin
  // close all hung with the port still held. That is exactly the orphaned-port
  // failure running in-process was meant to prevent, reached from the other end.
  it('gives the port back even while a response is still streaming', async () => {
    const backend = await neverEndingBackend();
    const streaming = new ProxySupervisor({
      registry: new InstanceRegistry(dir, () => true),
      proxyFor: async () =>
        ({
          getAuthorizationHeader: async () => 'Bearer t',
          getTargetUrl: async () => backend.url,
        }) as never,
    });
    try {
      const started = await streaming.start({
        name: 'cfg-D1',
        config: cfg('D1'),
        stopGraceMs: 50,
      });
      await firstByteThrough(started.port);

      const stopped = await Promise.race([
        streaming.stop(started.instanceId),
        new Promise<'HUNG'>((r) => setTimeout(() => r('HUNG'), 3000)),
      ]);

      expect(stopped).not.toBe('HUNG');
      expect(await portIsFree(started.port)).toBe(true);
    } finally {
      backend.close();
      await streaming.stop();
    }
  });

  it('keeps going when a credential throws on dispose, rather than leaving the record behind', async () => {
    const throwing = new ProxySupervisor({
      registry: new InstanceRegistry(dir, () => true),
      proxyFor: async () =>
        ({
          ...facade,
          dispose: () => {
            throw new Error('broker refused to let go');
          },
        }) as never,
    });

    const started = await throwing.start({ name: 'cfg-D1', config: cfg('D1') });
    await expect(throwing.stop(started.instanceId)).resolves.toHaveLength(1);

    // A throw between closing the server and forgetting the record used to
    // leave both the instance and its file behind, and reject on top of it.
    expect(throwing.mine()).toEqual([]);
    expect(new InstanceRegistry(dir, () => true).live()).toEqual([]);
    expect(await portIsFree(started.port)).toBe(true);
  });

  it('does not call an open stream idle', async () => {
    const backend = await neverEndingBackend();
    const streaming = new ProxySupervisor({
      registry: new InstanceRegistry(dir, () => true),
      proxyFor: async () =>
        ({
          getAuthorizationHeader: async () => 'Bearer t',
          getTargetUrl: async () => backend.url,
        }) as never,
    });
    try {
      const started = await streaming.start({
        name: 'cfg-D1',
        config: cfg('D1'),
        idleTimeoutMs: 40,
        stopGraceMs: 20,
      });
      await firstByteThrough(started.port);

      await new Promise((r) => setTimeout(r, 180));

      // An SSE connection that is open but quiet is the ordinary MCP state —
      // a client waiting for server events. Counting it idle and stopping it
      // would end a working session on a schedule.
      expect(streaming.mine()).toHaveLength(1);
    } finally {
      backend.close();
      await streaming.stop();
    }
  });

  it('starts counting again once the last request is done', async () => {
    const backend = await neverEndingBackend();
    const streaming = new ProxySupervisor({
      registry: new InstanceRegistry(dir, () => true),
      proxyFor: async () =>
        ({
          getAuthorizationHeader: async () => 'Bearer t',
          getTargetUrl: async () => backend.url,
        }) as never,
    });
    try {
      const started = await streaming.start({
        name: 'cfg-D1',
        config: cfg('D1'),
        idleTimeoutMs: 60,
        stopGraceMs: 20,
      });
      await firstByteThrough(started.port);
      expect(streaming.mine()).toHaveLength(1);

      backend.close(); // ends the response, so nothing is in flight any more
      await new Promise((r) => setTimeout(r, 300));

      expect(streaming.mine()).toEqual([]);
    } finally {
      backend.close();
      await streaming.stop();
    }
  });

  it('releases the credential it was given when the instance stops', async () => {
    let disposed = 0;
    const own = new ProxySupervisor({
      registry: new InstanceRegistry(dir, () => true),
      proxyFor: async () =>
        ({
          ...facade,
          dispose: () => {
            disposed += 1;
          },
        }) as never,
    });

    const started = await own.start({ name: 'cfg-D1', config: cfg('D1') });
    await own.stop(started.instanceId);

    // Closing the listener frees the port; the broker and its cached
    // credential behind it are the other half of "hold nothing".
    expect(disposed).toBe(1);
  });

  it('survives a credential with nothing to dispose', async () => {
    const started = await supervisor.start({ name: 'cfg-D1', config: cfg('D1') });

    await expect(supervisor.stop(started.instanceId)).resolves.toHaveLength(1);
  });

  it('does not count another session’s instances as its own', async () => {
    const registry = new InstanceRegistry(dir, () => true);
    registry.record({
      pid: 999999,
      port: 4999,
      url: 'http://127.0.0.1:4999',
      destination: 'THEIRS',
      config: 'theirs',
      startedAt: new Date().toISOString(),
      bootedAt: bootedAt(),
    });

    await supervisor.start({ name: 'cfg-D1', config: cfg('D1') });

    expect(supervisor.mine()).toHaveLength(1);
    expect(supervisor.others().map((o) => o.destination)).toEqual(['THEIRS']);
  });
});
