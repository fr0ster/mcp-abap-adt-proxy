/**
 * The proxy configs a user already keeps on disk.
 *
 * `~/.config/mcp-abap-adt/proxy/` holds one YAML per proxy — target, default
 * headers, browser, timeouts — and that file, not a destination, is the unit a
 * client means by "start the nvcr_d24 proxy". Four of the configs there name
 * the same `btpDestination`, so a destination cannot identify one.
 */

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listProxyConfigs, resolveProxyConfig } from '../../mcp/configs.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'proxy-configs-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, body = 'btpDestination: "D1"\n') =>
  writeFileSync(join(dir, name), body);

describe('listProxyConfigs', () => {
  it('names each config by its file, without the extension', () => {
    write('nvcr.yaml');
    write('nvcr_d24.yaml');

    expect(listProxyConfigs(dir).map((c) => c.name)).toEqual([
      'nvcr',
      'nvcr_d24',
    ]);
  });

  it('accepts .yml and .json alongside .yaml', () => {
    write('a.yaml');
    write('b.yml');
    write('c.json', '{"btpDestination":"D1"}');

    expect(listProxyConfigs(dir).map((c) => c.name)).toEqual(['a', 'b', 'c']);
  });

  it('ignores everything that is not a config', () => {
    write('real.yaml');
    write('notes.md', '# not a config');
    write('key.json.bak.1784619714', 'stale backup');
    mkdirSync(join(dir, 'subdir'));

    expect(listProxyConfigs(dir).map((c) => c.name)).toEqual(['real']);
  });

  it('reports the destination each config names, so a listing is useful', () => {
    write('nvcr_d24.yaml', 'btpDestination: "nvcr"\ntargetUrl: "https://d24"\n');

    expect(listProxyConfigs(dir)[0]).toEqual(
      expect.objectContaining({ name: 'nvcr_d24', destination: 'nvcr' }),
    );
  });

  it('still lists a config it cannot parse, rather than hiding it', () => {
    write('broken.yaml', ':\n  this is not: [valid');

    // Hiding it would make "no such config" the error a user sees for a file
    // that is sitting right there.
    expect(listProxyConfigs(dir).map((c) => c.name)).toEqual(['broken']);
    expect(listProxyConfigs(dir)[0].destination).toBeUndefined();
  });

  it('reports nothing when the directory does not exist', () => {
    expect(listProxyConfigs(join(dir, 'nope'))).toEqual([]);
  });
});

describe('resolveProxyConfig', () => {
  it('finds a config by name', () => {
    write('nvcr_d24.yaml');

    expect(resolveProxyConfig('nvcr_d24', dir)).toBe(
      join(dir, 'nvcr_d24.yaml'),
    );
  });

  it('accepts the file name as written, extension and all', () => {
    write('nvcr_d24.yaml');

    expect(resolveProxyConfig('nvcr_d24.yaml', dir)).toBe(
      join(dir, 'nvcr_d24.yaml'),
    );
  });

  it('names what IS available when the config is not', () => {
    write('nvcr.yaml');
    write('epam-sap-mcp.yaml');

    // A client that cannot guess names has to be told them, and the moment it
    // guesses wrong is the moment it is listening.
    expect(() => resolveProxyConfig('nvcrr', dir)).toThrow(/epam-sap-mcp/);
    expect(() => resolveProxyConfig('nvcrr', dir)).toThrow(/nvcr/);
  });

  it('refuses a name that would climb out of the directory', () => {
    write('nvcr.yaml');

    expect(() => resolveProxyConfig('../sessions/nvcr.env', dir)).toThrow();
    expect(() => resolveProxyConfig('/etc/passwd', dir)).toThrow();
  });
});
