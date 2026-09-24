/**
 * The four folders, in one place.
 *
 * `~/.config/mcp-abap-adt/` (Windows: `Documents\mcp-abap-adt\`) holds
 * `service-keys/`, `sessions/`, `proxy/` and `runtime/`. Three modules had
 * grown their own copy of that convention, which is three places for it to
 * drift.
 *
 * Two shapes, and the difference matters. `getPlatformPaths()` is a SEARCH
 * path: several candidates, ending in the working directory, for finding a
 * service key wherever it happens to be. `storeDir()` is THE directory: one
 * answer, no working-directory fallback, because a PID file written relative to
 * wherever a client was launched from is a PID file nobody will find again.
 */

import { afterEach, describe, expect, it } from '@jest/globals';
import * as os from 'node:os';
import * as path from 'node:path';
import { getPlatformPaths, storeBaseDir, storeDir } from '../../lib/stores.js';

const originalEnv = process.env.AUTH_BROKER_PATH;
const originalPlatform = process.platform;

const setPlatform = (value: string) =>
  Object.defineProperty(process, 'platform', { value, configurable: true });

afterEach(() => {
  if (originalEnv === undefined) delete process.env.AUTH_BROKER_PATH;
  else process.env.AUTH_BROKER_PATH = originalEnv;
  setPlatform(originalPlatform);
});

describe('storeDir', () => {
  it('names all four folders under the one base', () => {
    delete process.env.AUTH_BROKER_PATH;
    const base = storeBaseDir();

    for (const folder of [
      'service-keys',
      'sessions',
      'proxy',
      'runtime',
    ] as const) {
      expect(storeDir(folder)).toBe(path.join(base, folder));
    }
  });

  it('uses ~/.config/mcp-abap-adt on unix', () => {
    delete process.env.AUTH_BROKER_PATH;
    setPlatform('linux');

    expect(storeBaseDir()).toBe(
      path.join(os.homedir(), '.config', 'mcp-abap-adt'),
    );
  });

  it('uses Documents\\mcp-abap-adt on windows', () => {
    delete process.env.AUTH_BROKER_PATH;
    setPlatform('win32');

    expect(storeBaseDir()).toBe(
      path.join(os.homedir(), 'Documents', 'mcp-abap-adt'),
    );
  });

  it('follows AUTH_BROKER_PATH, so relocating the base moves all four', () => {
    process.env.AUTH_BROKER_PATH = '/tmp/relocated-store';

    expect(storeBaseDir()).toBe(path.resolve('/tmp/relocated-store'));
    expect(storeDir('runtime')).toBe(
      path.join(path.resolve('/tmp/relocated-store'), 'runtime'),
    );
  });

  it('takes the first entry when AUTH_BROKER_PATH lists several, on unix', () => {
    setPlatform('linux');
    process.env.AUTH_BROKER_PATH = '/tmp/first:/tmp/second';

    expect(storeBaseDir()).toBe(path.resolve('/tmp/first'));
  });

  it('takes the first entry when AUTH_BROKER_PATH lists several, on windows', () => {
    setPlatform('win32');
    process.env.AUTH_BROKER_PATH = 'C:\\first;C:\\second';

    // The separator is the platform's, so a test that does not say which
    // platform it means passes on one and fails on the other — which is what the
    // first version of this test did, on Windows CI.
    expect(storeBaseDir()).toBe(path.resolve('C:\\first'));
  });

  it('uses the platform delimiter, so a Windows drive letter survives', () => {
    setPlatform('win32');
    process.env.AUTH_BROKER_PATH = 'C:\\store';

    // Splitting on /[:;]/ turned `C:\store` into `C`, resolved against cwd.
    expect(storeBaseDir()).toBe(path.resolve('C:\\store'));
  });

  it('takes the parent when AUTH_BROKER_PATH points at one of the folders', () => {
    process.env.AUTH_BROKER_PATH = '/tmp/relocated/service-keys';

    // The search path already tolerates this, so the single-directory answer
    // must too: otherwise records land in `.../service-keys/runtime`.
    expect(storeDir('runtime')).toBe(
      path.join(path.resolve('/tmp/relocated'), 'runtime'),
    );
  });

  it('never answers with the working directory', () => {
    delete process.env.AUTH_BROKER_PATH;

    // The search path ends in cwd on purpose; this one must not. A runtime
    // record written beside whatever directory a client was launched from is a
    // record the next session will not find.
    expect(storeDir('runtime')).not.toBe(process.cwd());
    expect(storeDir('runtime').startsWith(storeBaseDir())).toBe(true);
  });
});

describe('getPlatformPaths', () => {
  it('still ends in the working directory, being a search path', () => {
    delete process.env.AUTH_BROKER_PATH;
    const paths = getPlatformPaths('service-keys');

    expect(paths[paths.length - 1]).toBe(path.normalize(process.cwd()));
  });

  it('accepts the two new folders as well', () => {
    delete process.env.AUTH_BROKER_PATH;

    expect(getPlatformPaths('proxy')[0]).toBe(storeDir('proxy'));
    expect(getPlatformPaths('runtime')[0]).toBe(storeDir('runtime'));
  });
});
