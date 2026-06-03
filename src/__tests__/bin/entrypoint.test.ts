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
