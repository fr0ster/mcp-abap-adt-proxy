/**
 * What config the MCP mode hands to a proxy it starts.
 *
 * The bug this exists to prevent was silent: the mode spread a baseline config
 * under the loaded one, and `applyDefaults` sets EVERY key — including
 * `defaultHeaders: undefined`. Spreading that over a baseline erased it. The
 * baseline is the documented place for `x-sap-login` / `x-sap-password`, so the
 * failure mode was a request going out with no ABAP credentials and nothing
 * saying so.
 */

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../lib/config.js';
import { createMcpModeServer } from '../../mcp/server.js';

let dir: string;
let argv: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-server-'));
  argv = process.argv;
});

afterEach(() => {
  process.argv = argv;
  rmSync(dir, { recursive: true, force: true });
});

/** Start one proxy and report the config the facade was built from. */
async function configHandedToTheProxy(
  file: string,
): Promise<Record<string, unknown>> {
  let seen: Record<string, unknown> | undefined;
  const { supervisor } = createMcpModeServer(loadConfig(), {
    proxyFor: async (options) => {
      seen = options.config as unknown as Record<string, unknown>;
      return {
        getAuthorizationHeader: async () => 'Bearer t',
        getTargetUrl: async () => 'http://127.0.0.1:1',
      } as never;
    },
  });
  try {
    await supervisor.start({ name: 'probe', config: loadConfig(file) });
  } finally {
    await supervisor.stop();
  }
  if (!seen) throw new Error('the supervisor never asked for a credential');
  return seen;
}

describe('createMcpModeServer', () => {
  it("hands over the proxy config's own headers, not an erased baseline", async () => {
    const file = join(dir, 'per-proxy.yaml');
    writeFileSync(
      file,
      [
        'btpDestination: "nvcr"',
        'httpPort: 3001',
        'defaultHeaders:',
        '  x-sap-login: "the-user"',
        '  x-sap-client: "600"',
      ].join('\n'),
    );

    const handed = await configHandedToTheProxy(file);

    expect(handed.defaultHeaders).toEqual({
      'x-sap-login': 'the-user',
      'x-sap-client': '600',
    });
    expect(handed.btpDestination).toBe('nvcr');
  });

  it('does not invent headers for a config that carries none', async () => {
    const file = join(dir, 'bare.yaml');
    writeFileSync(file, 'btpDestination: "nvcr"\n');

    const handed = await configHandedToTheProxy(file);

    expect(handed.defaultHeaders).toBeUndefined();
  });

  it('carries a CLI flag given to the management command', async () => {
    const file = join(dir, 'bare.yaml');
    writeFileSync(file, 'btpDestination: "nvcr"\n');
    // `loadConfig` overlays explicit CLI flags on a config file, which is how a
    // flag on the management command reaches every proxy it starts — without
    // any baseline spreading of its own.
    process.argv = ['node', 'proxy-mcp', '--unsafe'];

    const handed = await configHandedToTheProxy(file);

    expect(handed.unsafe).toBe(true);
  });
});
