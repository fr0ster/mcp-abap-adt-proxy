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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootedAt, InstanceRegistry } from '../../mcp/registry.js';
import { ProxySupervisor } from '../../mcp/supervisor.js';
import { createProxyTools } from '../../mcp/tools.js';

let dir: string;
let configDir: string;
let envDir: string;
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
  configDir = mkdtempSync(join(tmpdir(), 'proxy-tools-cfg-'));
  envDir = mkdtempSync(join(tmpdir(), 'proxy-tools-env-'));
  writeFileSync(join(envDir, 'e19.env'), 'PROBE_LOGIN=e19-user\n');
  writeFileSync(join(envDir, 'nvcr.env'), 'PROBE_LOGIN=nvcr-user\n');
  // Two configs naming the SAME destination, which is the case a destination
  // argument could not have told apart.
  writeFileSync(
    join(configDir, 'nvcr_d24.yaml'),
    'btpDestination: "nvcr"\nhttpPort: 3001\ntargetUrl: "https://d24.example"\n',
  );
  writeFileSync(
    join(configDir, 'nvcr_cr2.yaml'),
    'btpDestination: "nvcr"\nhttpPort: 3001\ntargetUrl: "https://cr2.example"\n',
  );
  supervisor = new ProxySupervisor({
    registry: new InstanceRegistry(dir, () => true),
    proxyFor: async () =>
      ({
        getAuthorizationHeader: async () => 'Bearer t',
        getTargetUrl: async () => 'http://127.0.0.1:1',
      }) as never,
  });
  tools = createProxyTools(supervisor, configDir, envDir);
});

afterEach(async () => {
  await supervisor.stop();
  rmSync(dir, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
  rmSync(envDir, { recursive: true, force: true });
});

describe('the proxy tools', () => {
  it('offers configs, environments, start, stop and status', () => {
    expect(tools.map((t) => t.name).sort()).toEqual([
      'proxy_configs',
      'proxy_environments',
      'proxy_start',
      'proxy_status',
      'proxy_stop',
    ]);
  });

  it('lists the environments by the name proxy_start takes', async () => {
    const listed = await textOf('proxy_environments');

    expect(listed).toMatch(/e19/);
    expect(listed).toMatch(/nvcr/);
    expect(listed).toMatch(/PROBE_LOGIN/);
  });

  it('never puts a credential VALUE in the environment listing', async () => {
    const listed = await textOf('proxy_environments');

    expect(listed).not.toMatch(/e19-user|nvcr-user/);
  });

  it('starts a config with the environment it is given', async () => {
    writeFileSync(
      join(configDir, 'needs-env.yaml'),
      'btpDestination: "nvcr"\ndefaultHeaders:\n  x-sap-login: "${PROBE_LOGIN}"\n',
    );

    const text = await textOf('proxy_start', {
      config: 'needs-env',
      environment: 'e19',
    });

    expect(text).toMatch(/Proxy running at/);
    expect(text).toMatch(/e19/);
  });

  it('names the environments that exist when given one that does not', async () => {
    writeFileSync(join(configDir, 'plain.yaml'), 'btpDestination: "nvcr"\n');

    await expect(
      textOf('proxy_start', { config: 'plain', environment: 'e20' }),
    ).rejects.toThrow(/e19/);
  });

  it('lists the configs by the name proxy_start takes', async () => {
    const listed = await textOf('proxy_configs');

    expect(listed).toMatch(/nvcr_d24/);
    expect(listed).toMatch(/nvcr_cr2/);
    expect(listed).toMatch(/proxy_start/);
  });

  it('starts the config it is named, not a destination', async () => {
    // Both configs name destination "nvcr"; only the config name separates them.
    const text = await textOf('proxy_start', { config: 'nvcr_cr2' });

    expect(text).toMatch(/nvcr_cr2/);
  });

  it('ignores the port in the config, which is how they collide', async () => {
    const text = await textOf('proxy_start', { config: 'nvcr_d24' });

    expect(text).not.toMatch(/:3001\b/);
  });

  it('names the configs that DO exist when given one that does not', async () => {
    await expect(
      textOf('proxy_start', { config: 'nvcr_d25' }),
    ).rejects.toThrow(/nvcr_d24/);
  });

  it('tells the client, in the start description, to stop what it started', () => {
    const description = tool('proxy_start').description.toLowerCase();

    expect(description).toMatch(/proxy_stop/);
    expect(description).toMatch(/port|credential/);
  });

  it('repeats it in the answer, next to the url', async () => {
    const text = await textOf('proxy_start', { config: 'nvcr_d24' });

    expect(text).toMatch(/http:\/\/127\.0\.0\.1:\d+/);
    expect(text.toLowerCase()).toMatch(/proxy_stop/);
  });

  it('gives every tool a description', () => {
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(30);
    }
  });

  it('starts a proxy the supervisor then owns', async () => {
    await textOf('proxy_start', { config: 'nvcr_d24' });

    expect(supervisor.mine()).toHaveLength(1);
  });

  it('stops the instance it is given', async () => {
    await textOf('proxy_start', { config: 'nvcr_d24' });
    const [started] = supervisor.mine();

    await textOf('proxy_stop', { instanceId: started.instanceId });

    expect(supervisor.mine()).toEqual([]);
  });

  it('stops everything when told nothing in particular', async () => {
    await textOf('proxy_start', { config: 'nvcr_d24' });
    await textOf('proxy_start', { config: 'nvcr_cr2' });

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
      config: 'theirs',
      startedAt: new Date().toISOString(),
      bootedAt: bootedAt(),
    });
    await textOf('proxy_start', { config: 'nvcr_d24' });

    const text = await textOf('proxy_status');

    expect(text).toMatch(/nvcr_d24/);
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
