/**
 * The three tools, and the thing they have to keep saying.
 *
 * A proxy holds a port and live credentials for as long as it runs, and the
 * client that starts one is a language model that reads tool descriptions
 * selectively. So the reminder to stop it is asserted, in the description AND
 * in the text that comes back with the URL — prose is exactly the kind of thing
 * that gets tidied away in an edit, and there would be no failing test.
 */

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InstanceRegistry } from '../../mcp/registry.js';
import { ProxySupervisor } from '../../mcp/supervisor.js';
import { createProxyTools } from '../../mcp/tools.js';

let dir: string;
let supervisor: ProxySupervisor;
let tools: ReturnType<typeof createProxyTools>;

const tool = (name: string) => {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`no tool named ${name}`);
  return found;
};

const textOf = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await tool(name).handler(args as never);
  return result.content.map((c) => c.text).join('\n');
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'proxy-tools-'));
  supervisor = new ProxySupervisor({
    registry: new InstanceRegistry(dir, () => true),
    proxyFor: async () =>
      ({
        getAuthorizationHeader: async () => 'Bearer t',
        getTargetUrl: async () => 'http://127.0.0.1:1',
      }) as never,
  });
  tools = createProxyTools(supervisor);
});

afterEach(async () => {
  await supervisor.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('the proxy tools', () => {
  it('offers exactly start, stop and status', () => {
    expect(tools.map((t) => t.name).sort()).toEqual([
      'proxy_start',
      'proxy_status',
      'proxy_stop',
    ]);
  });

  it('tells the client, in the start description, to stop what it started', () => {
    const description = tool('proxy_start').description.toLowerCase();

    expect(description).toMatch(/proxy_stop/);
    expect(description).toMatch(/port|credential/);
  });

  it('repeats it in the answer, next to the url', async () => {
    const text = await textOf('proxy_start', { destination: 'D1' });

    expect(text).toMatch(/http:\/\/127\.0\.0\.1:\d+/);
    expect(text.toLowerCase()).toMatch(/proxy_stop/);
  });

  it('gives every tool a description', () => {
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(30);
    }
  });

  it('starts a proxy the supervisor then owns', async () => {
    await textOf('proxy_start', { destination: 'D1' });

    expect(supervisor.mine()).toHaveLength(1);
  });

  it('stops the instance it is given', async () => {
    await textOf('proxy_start', { destination: 'D1' });
    const [started] = supervisor.mine();

    await textOf('proxy_stop', { instanceId: started.instanceId });

    expect(supervisor.mine()).toEqual([]);
  });

  it('stops everything when told nothing in particular', async () => {
    await textOf('proxy_start', { destination: 'D1' });
    await textOf('proxy_start', { destination: 'D2' });

    await textOf('proxy_stop');

    expect(supervisor.mine()).toEqual([]);
  });

  it('says plainly when there was nothing of ours to stop', async () => {
    const text = await textOf('proxy_stop', { instanceId: 'not-ours' });

    expect(text.toLowerCase()).toMatch(/nothing|no proxy/);
  });

  it('reports this session’s proxies and other sessions’ separately', async () => {
    new InstanceRegistry(dir, () => true).record({
      pid: 999999,
      port: 4999,
      url: 'http://127.0.0.1:4999',
      destination: 'THEIRS',
      startedAt: new Date().toISOString(),
    });
    await textOf('proxy_start', { destination: 'MINE' });

    const text = await textOf('proxy_status');

    expect(text).toMatch(/MINE/);
    expect(text).toMatch(/THEIRS/);
    // Another session's proxy is shown so the agent can see it, and marked so
    // it does not try to stop it.
    expect(text.toLowerCase()).toMatch(/another session|other session/);
  });

  it('says so when nothing is running at all', async () => {
    const text = await textOf('proxy_status');

    expect(text.toLowerCase()).toMatch(/no proxies|nothing/);
  });
});
