import { describe, it, expect } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

// Guards against shipping a bin that fails to parse — e.g. an unescaped ${...}
// inside the --help template literal (regression from 1.6.0, fixed in 1.6.1).
const bin = path.resolve(__dirname, '../../../bin/mcp-abap-adt-proxy.js');

describe('bin entrypoint', () => {
  it('parses with node --check', () => {
    expect(() => execFileSync('node', ['--check', bin])).not.toThrow();
  });

  it('--version prints a semver without crashing', () => {
    const out = execFileSync('node', [bin, '--version'], { encoding: 'utf-8' });
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('--help renders ${VAR} placeholders literally', () => {
    const out = execFileSync('node', [bin, '--help'], { encoding: 'utf-8' });
    expect(out).toContain('${VAR}');
    expect(out).toContain('--env-file');
  });
});

// The management-mode command. Same guard as above: a bin that does not parse
// ships perfectly happily and fails in the client's hands.
const mcpBin = path.resolve(
  __dirname,
  '../../../bin/mcp-abap-adt-proxy-mcp.js',
);

describe('mcp mode entrypoint', () => {
  it('parses with node --check', () => {
    expect(() => execFileSync('node', ['--check', mcpBin])).not.toThrow();
  });

  it('--version prints a semver without crashing', () => {
    const out = execFileSync('node', [mcpBin, '--version'], {
      encoding: 'utf-8',
    });
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('--help names the three tools and renders ${VAR} literally', () => {
    const out = execFileSync('node', [mcpBin, '--help'], { encoding: 'utf-8' });
    expect(out).toContain('proxy_start');
    expect(out).toContain('proxy_stop');
    expect(out).toContain('proxy_status');
    expect(out).toContain('${VAR}');
  });

  it('--help says the proxies die with the session', () => {
    const out = execFileSync('node', [mcpBin, '--help'], { encoding: 'utf-8' });
    expect(out).toMatch(/THIS process/);
  });
});

describe('mcp mode help names the config-driven contract', () => {
  it('names proxy_configs and says where the configs live', () => {
    const out = execFileSync('node', [mcpBin, '--help'], { encoding: 'utf-8' });
    expect(out).toContain('proxy_configs');
    expect(out).toContain('mcp-abap-adt/proxy/');
  });

  it('says the port does not come from the config', () => {
    const out = execFileSync('node', [mcpBin, '--help'], { encoding: 'utf-8' });
    expect(out).toMatch(/PORT does not come from it/);
  });
});
