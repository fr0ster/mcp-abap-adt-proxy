import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig } from '../../lib/config.js';

describe('config', () => {
  const originalArgv = process.argv;

  afterEach(() => {
    process.argv = originalArgv;
  });

  describe('defaultHeaders from CLI', () => {
    it('should parse single --header argument', () => {
      process.argv = ['node', 'proxy', '--header', 'x-sap-destination=S4HANA'];
      const config = loadConfig();
      expect(config.defaultHeaders).toEqual({ 'x-sap-destination': 'S4HANA' });
    });

    it('should parse multiple --header arguments', () => {
      process.argv = [
        'node', 'proxy',
        '--header', 'x-sap-destination=S4HANA',
        '--header', 'x-sap-client=100',
      ];
      const config = loadConfig();
      expect(config.defaultHeaders).toEqual({
        'x-sap-destination': 'S4HANA',
        'x-sap-client': '100',
      });
    });

    it('should parse --header=key=value format', () => {
      process.argv = ['node', 'proxy', '--header=x-sap-destination=S4HANA'];
      const config = loadConfig();
      expect(config.defaultHeaders).toEqual({ 'x-sap-destination': 'S4HANA' });
    });

    it('should return undefined when no --header arguments', () => {
      process.argv = ['node', 'proxy'];
      const config = loadConfig();
      expect(config.defaultHeaders).toBeUndefined();
    });
  });
});

describe('config file env interpolation', () => {
  const originalArgv = process.argv;
  const originalEnv = process.env;
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-cfg-'));
  });
  afterEach(() => {
    process.argv = originalArgv;
    process.env = originalEnv;
  });

  const writeConfig = (yaml: string) => {
    const file = path.join(dir, 'config.yaml');
    fs.writeFileSync(file, yaml);
    return file;
  };

  it('interpolates ${VAR} from process.env', () => {
    process.env = { ...originalEnv, SAP_PW: 'pw-from-env' };
    const cfg = writeConfig(
      'btpDestination: btp\ndefaultHeaders:\n  x-sap-password: "${SAP_PW}"\n',
    );
    process.argv = ['node', 'proxy', '--config', cfg];
    const config = loadConfig();
    expect(config.defaultHeaders).toEqual({ 'x-sap-password': 'pw-from-env' });
  });

  it('loads values from an envFile resolved relative to the config dir', () => {
    fs.writeFileSync(path.join(dir, 'secrets.env'), 'SAP_PW=pw-from-file\n');
    const cfg = writeConfig(
      'btpDestination: btp\nenvFile: secrets.env\ndefaultHeaders:\n  x-sap-password: "${SAP_PW}"\n',
    );
    process.env = { ...originalEnv };
    delete process.env.SAP_PW;
    process.argv = ['node', 'proxy', '--config', cfg];
    const config = loadConfig();
    expect(config.defaultHeaders).toEqual({ 'x-sap-password': 'pw-from-file' });
  });

  it('lets --env-file override envFile from YAML', () => {
    fs.writeFileSync(path.join(dir, 'yaml.env'), 'SAP_PW=from-yaml-env\n');
    fs.writeFileSync(path.join(dir, 'cli.env'), 'SAP_PW=from-cli-env\n');
    const cfg = writeConfig(
      'btpDestination: btp\nenvFile: yaml.env\ndefaultHeaders:\n  x-sap-password: "${SAP_PW}"\n',
    );
    process.env = { ...originalEnv };
    delete process.env.SAP_PW;
    process.argv = [
      'node',
      'proxy',
      '--config',
      cfg,
      '--env-file',
      path.join(dir, 'cli.env'),
    ];
    const config = loadConfig();
    expect(config.defaultHeaders).toEqual({ 'x-sap-password': 'from-cli-env' });
  });

  it('fails fast on an unresolved required placeholder', () => {
    const cfg = writeConfig(
      'btpDestination: btp\ndefaultHeaders:\n  x-sap-password: "${NOPE}"\n',
    );
    process.env = { ...originalEnv };
    delete process.env.NOPE;
    process.argv = ['node', 'proxy', '--config', cfg];
    expect(() => loadConfig()).toThrow(/NOPE/);
  });

  it('does not leak envFile into the returned config', () => {
    const cfg = writeConfig('btpDestination: btp\nenvFile: secrets.env\n');
    fs.writeFileSync(path.join(dir, 'secrets.env'), '');
    process.argv = ['node', 'proxy', '--config', cfg];
    const config = loadConfig() as Record<string, unknown>;
    expect(config.envFile).toBeUndefined();
  });
});

describe('--header interpolation (env-only path)', () => {
  const originalArgv = process.argv;
  const originalEnv = process.env;
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-hdr-'));
  });
  afterEach(() => {
    process.argv = originalArgv;
    process.env = originalEnv;
  });

  it('interpolates ${VAR} in --header from process.env', () => {
    process.env = { ...originalEnv, SAP_USER: 'bob' };
    process.argv = ['node', 'proxy', '--header', 'x-sap-login=${SAP_USER}'];
    const config = loadConfig();
    expect(config.defaultHeaders).toEqual({ 'x-sap-login': 'bob' });
  });

  it('interpolates ${VAR} in --header from --env-file', () => {
    fs.writeFileSync(path.join(dir, '.env'), 'SAP_USER=carol\n');
    process.env = { ...originalEnv };
    delete process.env.SAP_USER;
    process.argv = [
      'node',
      'proxy',
      '--header',
      'x-sap-login=${SAP_USER}',
      '--env-file',
      path.join(dir, '.env'),
    ];
    const config = loadConfig();
    expect(config.defaultHeaders).toEqual({ 'x-sap-login': 'carol' });
  });
});
