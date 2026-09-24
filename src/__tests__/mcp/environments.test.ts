/**
 * The environments a proxy can be started with.
 *
 * `sessions/` holds one `.env` per SAP system, and a config that references
 * `${SAP_LOGIN}` needs one of them. The config names the service; the
 * environment names the system's credentials. Both are chosen by name from the
 * standard folders, which is what lets a client pick them without being told
 * any paths.
 */

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listEnvironments,
  resolveEnvironment,
} from '../../mcp/environments.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'proxy-envs-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, body = 'SAP_LOGIN=u\nSAP_PASSWORD=p\n') =>
  writeFileSync(join(dir, name), body);

describe('listEnvironments', () => {
  it('names each environment by its file, without the extension', () => {
    write('e19.env');
    write('nvcr.env');

    expect(listEnvironments(dir).map((e) => e.name)).toEqual(['e19', 'nvcr']);
  });

  it('reports which variables each one carries, never their values', () => {
    write('e19.env', 'SAP_LOGIN=alice\nSAP_PASSWORD=hunter2\n');

    const [entry] = listEnvironments(dir);

    expect(entry.variables).toEqual(['SAP_LOGIN', 'SAP_PASSWORD']);
    expect(JSON.stringify(entry)).not.toMatch(/alice|hunter2/);
  });

  it('leaves out templates and anything that is not a .env', () => {
    write('e19.env');
    write('e19.env.template');
    write('notes.md', '# not an environment');
    mkdirSync(join(dir, 'subdir'));

    expect(listEnvironments(dir).map((e) => e.name)).toEqual(['e19']);
  });

  it('lists one it cannot read rather than hiding it', () => {
    write('broken.env', '\u0000\u0000binary junk');

    expect(listEnvironments(dir).map((e) => e.name)).toEqual(['broken']);
    expect(listEnvironments(dir)[0].variables).toEqual([]);
  });

  it('reports nothing when the directory does not exist', () => {
    expect(listEnvironments(join(dir, 'nope'))).toEqual([]);
  });
});

describe('resolveEnvironment', () => {
  it('finds an environment by name', () => {
    write('e19.env');

    expect(resolveEnvironment('e19', dir)).toBe(join(dir, 'e19.env'));
  });

  it('accepts the file name as written', () => {
    write('e19.env');

    expect(resolveEnvironment('e19.env', dir)).toBe(join(dir, 'e19.env'));
  });

  it('names what IS available when the environment is not', () => {
    write('e19.env');
    write('nvcr.env');

    expect(() => resolveEnvironment('e20', dir)).toThrow(/e19/);
    expect(() => resolveEnvironment('e20', dir)).toThrow(/nvcr/);
  });

  it('refuses a name that would leave the directory', () => {
    write('e19.env');

    // The value comes from a language model, and `../proxy/` and
    // `../service-keys/` are real neighbouring folders.
    expect(() => resolveEnvironment('../proxy/nvcr.yaml', dir)).toThrow();
    expect(() => resolveEnvironment('..', dir)).toThrow();
  });
});
