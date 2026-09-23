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
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InstanceRegistry } from '../../mcp/registry.js';
import { ProxySupervisor } from '../../mcp/supervisor.js';

let dir: string;
let supervisor: ProxySupervisor;

const facade = {
  getAuthorizationHeader: async () => 'Bearer t',
  getTargetUrl: async () => 'http://127.0.0.1:1',
};

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

describe('ProxySupervisor', () => {
  it('starts a listener on a free port and reports where it is', async () => {
    const started = await supervisor.start({ destination: 'D1' });

    expect(started.port).toBeGreaterThan(0);
    expect(started.url).toBe(`http://127.0.0.1:${started.port}`);
    expect(await portIsFree(started.port)).toBe(false);
  });

  it('never puts two instances on one port', async () => {
    const first = await supervisor.start({ destination: 'D1' });
    const second = await supervisor.start({ destination: 'D2' });

    expect(second.port).not.toBe(first.port);
  });

  it('writes a record other sessions can see', async () => {
    const started = await supervisor.start({ destination: 'D1' });

    expect(new InstanceRegistry(dir, () => true).live()).toEqual([
      expect.objectContaining({
        port: started.port,
        destination: 'D1',
        pid: process.pid,
      }),
    ]);
  });

  it('gives the port back on stop', async () => {
    const started = await supervisor.start({ destination: 'D1' });

    await supervisor.stop(started.instanceId);

    expect(await portIsFree(started.port)).toBe(true);
  });

  it('takes its record with it on stop', async () => {
    const started = await supervisor.start({ destination: 'D1' });

    await supervisor.stop(started.instanceId);

    expect(new InstanceRegistry(dir, () => true).live()).toEqual([]);
  });

  it('stops every instance it owns when asked for none in particular', async () => {
    const first = await supervisor.start({ destination: 'D1' });
    const second = await supervisor.start({ destination: 'D2' });

    const stopped = await supervisor.stop();

    expect(stopped.map((s) => s.instanceId).sort()).toEqual(
      [first.instanceId, second.instanceId].sort(),
    );
    expect(supervisor.mine()).toEqual([]);
  });

  it('stops only the instance named, leaving the others alone', async () => {
    const first = await supervisor.start({ destination: 'D1' });
    const second = await supervisor.start({ destination: 'D2' });

    await supervisor.stop(first.instanceId);

    expect(supervisor.mine().map((m) => m.instanceId)).toEqual([
      second.instanceId,
    ]);
    expect(await portIsFree(second.port)).toBe(false);
  });

  it('reports nothing stopped for an instance it does not own', async () => {
    await supervisor.start({ destination: 'D1' });

    const stopped = await supervisor.stop('someone-elses-instance');

    expect(stopped).toEqual([]);
    expect(supervisor.mine()).toHaveLength(1);
  });

  it('stops an instance that has been idle too long', async () => {
    const started = await supervisor.start({
      destination: 'D1',
      idleTimeoutMs: 40,
    });

    await new Promise((resolve) => setTimeout(resolve, 140));

    // The backstop for an agent that finished and forgot: a proxy holds a port
    // and live credentials for as long as it runs.
    expect(supervisor.mine()).toEqual([]);
    expect(await portIsFree(started.port)).toBe(true);
  });

  it('does not count another session’s instances as its own', async () => {
    const registry = new InstanceRegistry(dir, () => true);
    registry.record({
      pid: 999999,
      port: 4999,
      url: 'http://127.0.0.1:4999',
      destination: 'THEIRS',
      startedAt: new Date().toISOString(),
    });

    await supervisor.start({ destination: 'D1' });

    expect(supervisor.mine()).toHaveLength(1);
    expect(supervisor.others().map((o) => o.destination)).toEqual(['THEIRS']);
  });
});
