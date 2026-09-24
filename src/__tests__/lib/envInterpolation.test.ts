import { afterEach, describe, it, expect } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildLookup,
  interpolateConfig,
  interpolateString,
  loadEnvFile,
} from '../../lib/envInterpolation.js';

const lookup =
  (map: Record<string, string | undefined>) => (k: string) => map[k];

describe('interpolateString', () => {
  it('substitutes ${VAR} from the lookup', () => {
    const out = interpolateString('${USER}', lookup({ USER: 'alice' }), 'f');
    expect(out).toBe('alice');
  });

  it('substitutes inside a larger string', () => {
    const out = interpolateString('Bearer ${TOK}!', lookup({ TOK: 'x' }), 'f');
    expect(out).toBe('Bearer x!');
  });

  it('uses the default when the variable is unset', () => {
    const out = interpolateString('${MISS:-fallback}', lookup({}), 'f');
    expect(out).toBe('fallback');
  });

  it('uses the default when the variable is empty', () => {
    const out = interpolateString('${E:-fallback}', lookup({ E: '' }), 'f');
    expect(out).toBe('fallback');
  });

  it('prefers the set value over the default', () => {
    const out = interpolateString('${V:-d}', lookup({ V: 'real' }), 'f');
    expect(out).toBe('real');
  });

  it('keeps an empty value for ${VAR} with no default', () => {
    const out = interpolateString('${E}', lookup({ E: '' }), 'f');
    expect(out).toBe('');
  });

  it('throws naming the variable and field when unresolved and no default', () => {
    expect(() =>
      interpolateString('${MISS}', lookup({}), 'defaultHeaders.x-sap-password'),
    ).toThrow(/MISS.*defaultHeaders\.x-sap-password/);
  });

  it('leaves a literal $ untouched', () => {
    expect(interpolateString('price $5', lookup({}), 'f')).toBe('price $5');
  });
});

describe('interpolateConfig', () => {
  const lk = (map: Record<string, string>) => (k: string) => map[k];

  it('interpolates nested string values', () => {
    const out = interpolateConfig(
      { defaultHeaders: { 'x-sap-password': '${PW}' }, targetUrl: '${URL}' },
      lk({ PW: 'secret', URL: 'https://h' }),
    );
    expect(out).toEqual({
      defaultHeaders: { 'x-sap-password': 'secret' },
      targetUrl: 'https://h',
    });
  });

  it('leaves non-string values untouched', () => {
    const out = interpolateConfig(
      { httpPort: 3001, unsafe: false, defaultHeaders: { a: '${A}' } },
      lk({ A: '1' }),
    );
    expect(out).toEqual({
      httpPort: 3001,
      unsafe: false,
      defaultHeaders: { a: '1' },
    });
  });

  it('interpolates inside arrays', () => {
    const out = interpolateConfig(['${A}', 'plain'], lk({ A: 'x' }));
    expect(out).toEqual(['x', 'plain']);
  });

  it('reports the field path on an unresolved placeholder', () => {
    expect(() =>
      interpolateConfig(
        { defaultHeaders: { 'x-sap-login': '${MISS}' } },
        lk({}),
      ),
    ).toThrow(/MISS.*defaultHeaders\.x-sap-login/);
  });
});

describe('loadEnvFile', () => {
  const tmp = (name: string, content: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-env-'));
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    return file;
  };

  it('parses KEY=value pairs', () => {
    const file = tmp('.env', 'SAP_USER=alice\nSAP_PASSWORD=s3cret\n');
    expect(loadEnvFile(file)).toEqual({
      SAP_USER: 'alice',
      SAP_PASSWORD: 's3cret',
    });
  });

  it('throws when the file does not exist', () => {
    expect(() => loadEnvFile('/no/such/.env')).toThrow(/not found/i);
  });
});

describe('buildLookup', () => {
  const originalEnv = process.env;
  afterEach(() => {
    process.env = originalEnv;
  });

  it('prefers process.env over the .env map', () => {
    process.env = { ...originalEnv, K: 'from-process' };
    const lookup = buildLookup({ K: 'from-file' });
    expect(lookup('K')).toBe('from-process');
  });

  it('falls back to the .env map when process.env lacks the key', () => {
    process.env = { ...originalEnv };
    delete process.env.ONLY_IN_FILE;
    const lookup = buildLookup({ ONLY_IN_FILE: 'v' });
    expect(lookup('ONLY_IN_FILE')).toBe('v');
  });

  it('returns undefined when neither source has the key', () => {
    const lookup = buildLookup({});
    expect(lookup('TOTALLY_MISSING_XYZ')).toBeUndefined();
  });
});

describe('buildLookup precedence', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('does not let an EMPTY environment variable shadow the env file', () => {
    // Windows carries variables a user never set deliberately, and an empty one
    // used to win: `process.env[key] ?? map[key]` only skips undefined, so `''`
    // counted as a value. The file the user pointed at with --env-file lost to
    // an accident of the environment, and the header went out empty.
    process.env.SAP_LOGIN = '';
    const lookup = buildLookup({ SAP_LOGIN: 'from-the-file' });

    expect(lookup('SAP_LOGIN')).toBe('from-the-file');
  });

  it('still lets a REAL environment variable win', () => {
    process.env.SAP_LOGIN = 'from-the-environment';
    const lookup = buildLookup({ SAP_LOGIN: 'from-the-file' });

    expect(lookup('SAP_LOGIN')).toBe('from-the-environment');
  });

  it('falls back to the file when the variable is absent', () => {
    delete process.env.SAP_LOGIN;
    const lookup = buildLookup({ SAP_LOGIN: 'from-the-file' });

    expect(lookup('SAP_LOGIN')).toBe('from-the-file');
  });

  it('reports nothing when neither has it', () => {
    delete process.env.SAP_LOGIN;

    expect(buildLookup({})('SAP_LOGIN')).toBeUndefined();
  });
});

describe('what the failure says', () => {
  it('names the env file and what it yielded, not just the variable', () => {
    // The old message was `Config references undefined env variable: SAP_LOGIN`
    // and nothing else — so a file that was never read, read empty, or shadowed
    // all produced the same sentence, and the cause had to be guessed.
    expect(() =>
      interpolateString(
        '${SAP_LOGIN}',
        () => undefined,
        'defaultHeaders.x-sap-login',
        'env file /tmp/e19.env (2 keys: SAP_LOGIN, SAP_PASSWORD)',
      ),
    ).toThrow(/\/tmp\/e19\.env/);
  });

  it('says plainly when no env file was in play at all', () => {
    expect(() =>
      interpolateString('${SAP_LOGIN}', () => undefined, 'h', 'no env file'),
    ).toThrow(/no env file/);
  });

  it('reads an env file that yields nothing without complaining', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envprobe-'));
    const file = path.join(dir, 'empty.env');
    fs.writeFileSync(file, '# only a comment\n\n');
    try {
      // An empty `.env` is legitimate — a config may take every value from the
      // environment. The emptiness is reported by whoever then needs a variable,
      // where it can be said usefully, rather than refused here.
      expect(loadEnvFile(file)).toEqual({});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
