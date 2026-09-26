/**
 * The target URL reaches the broker; the session file keeps its own URL.
 *
 * Run against the real AbapSessionStore on a temporary directory, because the
 * point is what lands in the file: with `unsafe`, it is the session file
 * mcp-auth writes, and writing the MCP server's URL into it replaced SAP_URL.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AbapSessionStore } from '@mcp-abap-adt/auth-stores';
import { TargetUrlSessionStore } from '../../proxy/targetUrlSessionStore';

const TARGET = 'https://mcp-server.example';
const OWN = 'https://abap.example';

function sessionDir(withFile: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'target-url-'));
  if (withFile) {
    fs.writeFileSync(
      path.join(dir, 'D.env'),
      [
        `SAP_URL=${OWN}`,
        'SAP_JWT_TOKEN=eyJ.old.sig',
        'SAP_REFRESH_TOKEN=refresh-token-34-characters-long-x',
        'SAP_UAA_URL=https://uaa.example',
        'SAP_UAA_CLIENT_ID=client',
        '',
      ].join('\n'),
    );
  }
  return dir;
}

const fileOf = (dir: string) => fs.readFileSync(path.join(dir, 'D.env'), 'utf8');

describe('TargetUrlSessionStore', () => {
  it('answers the target URL to every read', async () => {
    const store = new TargetUrlSessionStore(
      new AbapSessionStore(sessionDir(true)),
      TARGET,
    );
    expect((await store.getConnectionConfig('D'))?.serviceUrl).toBe(TARGET);
    expect((await store.loadSession('D'))?.serviceUrl).toBe(TARGET);
  });

  it('answers it for a destination with no session at all', async () => {
    const store = new TargetUrlSessionStore(
      new AbapSessionStore(sessionDir(false)),
      TARGET,
    );
    expect((await store.getConnectionConfig('D'))?.serviceUrl).toBe(TARGET);
  });

  it('keeps the session file its own URL when the broker writes a new token', async () => {
    const dir = sessionDir(true);
    const store = new TargetUrlSessionStore(new AbapSessionStore(dir), TARGET);

    // What auth-broker 3's persist() writes: the resolved URL with the token.
    await store.setConnectionConfig('D', {
      serviceUrl: TARGET,
      authorizationToken: 'eyJ.new.sig',
    });
    await store.saveSession('D', {
      serviceUrl: TARGET,
      refreshToken: 'refresh-token-34-characters-new-yy',
    });

    const file = fileOf(dir);
    expect(file).toContain(`SAP_URL=${OWN}`);
    expect(file).not.toContain(TARGET);
    expect(file).toContain('SAP_JWT_TOKEN=eyJ.new.sig');
    expect(file).toContain('SAP_REFRESH_TOKEN=refresh-token-34-characters-new-yy');
  });

  it('creates a missing session with the target URL, the only one there is', async () => {
    const dir = sessionDir(false);
    const store = new TargetUrlSessionStore(new AbapSessionStore(dir), TARGET);

    await store.setConnectionConfig('D', {
      serviceUrl: TARGET,
      authorizationToken: 'eyJ.new.sig',
    });

    expect(fileOf(dir)).toContain(`SAP_URL=${TARGET}`);
  });

  it('passes an unreadable session on as the store raised it', async () => {
    const failing = new Error('EACCES: permission denied, open D.env');
    const inner = {
      getConnectionConfig: async () => {
        throw failing;
      },
    } as unknown as AbapSessionStore;
    const store = new TargetUrlSessionStore(inner, TARGET);
    await expect(store.getConnectionConfig('D')).rejects.toBe(failing);
  });
});
