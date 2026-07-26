import { describe, it, expect, beforeAll, afterEach } from '@jest/globals';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

const bin = path.resolve(__dirname, '../../../bin/mcp-abap-adt-proxy.js');
const dist = path.resolve(__dirname, '../../../dist/index.js');

// These tests drive the built binary. Without dist/ there is nothing to test.
// POSIX-only: the test drives process trees via `ps` and POSIX signals.
const canRun = fs.existsSync(dist) && process.platform !== 'win32';
const describeBuilt = canRun ? describe : describe.skip;

const HTTP_PORT = 3099;
const CALLBACK_PORT = 7899;

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

async function waitFor(
  fn: () => Promise<boolean>,
  timeoutMs = 20000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Descendants must be collected BEFORE the parent dies: an orphan is
// re-parented to init/systemd, so afterwards it is no longer reachable
// by walking down from the launcher pid.
function descendantsOf(pid: number): number[] {
  const out = execFileSync('ps', ['-eo', 'pid,ppid'], { encoding: 'utf-8' });
  const byParent = new Map<number, number[]>();
  for (const line of out.trim().split('\n').slice(1)) {
    const [p, pp] = line.trim().split(/\s+/).map(Number);
    if (!Number.isFinite(p) || !Number.isFinite(pp)) continue;
    if (!byParent.has(pp)) byParent.set(pp, []);
    byParent.get(pp)?.push(p);
  }
  const found: number[] = [];
  const stack = [pid];
  while (stack.length > 0) {
    const cur = stack.pop() as number;
    for (const child of byParent.get(cur) ?? []) {
      found.push(child);
      stack.push(child);
    }
  }
  return found;
}

// A destination whose UAA host is never contacted: with browser 'none' the
// proxy binds the callback port, prints the URL and waits. That is a stable
// "up and holding ports" state, reachable with no network and no real key.
function makeFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-signals-'));
  fs.mkdirSync(path.join(dir, 'service-keys'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'service-keys', 'signaltest.json'),
    JSON.stringify({
      credentials: {
        url: 'http://127.0.0.1:9',
        clientid: 'test-client',
        clientsecret: 'test-secret',
      },
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'config.yaml'),
    [
      'transport: http',
      `httpPort: ${HTTP_PORT}`,
      'httpHost: "127.0.0.1"',
      'btpDestination: "signaltest"',
      'targetUrl: "http://127.0.0.1:9"',
      'browser: "none"',
      `browserAuthPort: ${CALLBACK_PORT}`,
      'logLevel: "info"',
      '',
    ].join('\n'),
  );
  return dir;
}

describeBuilt('bin signal handling', () => {
  let dir: string;
  let child: ChildProcess | undefined;

  beforeAll(() => {
    dir = makeFixture();
  });

  afterEach(() => {
    // Belt and braces: never leave a test server behind holding a port.
    if (child?.pid && isAlive(child.pid)) {
      for (const pid of descendantsOf(child.pid)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    child = undefined;
  });

  it('SIGTERM releases the callback port and leaves no surviving process', async () => {
    child = spawn('node', [bin, '--config', path.join(dir, 'config.yaml')], {
      env: { ...process.env, AUTH_BROKER_PATH: dir },
      stdio: 'ignore',
    });
    const launcherPid = child.pid as number;

    const bound = await waitFor(async () => !(await portIsFree(CALLBACK_PORT)));
    expect(bound).toBe(true);

    const before = descendantsOf(launcherPid);

    const exited = new Promise<void>((resolve) => child?.once('exit', () => resolve()));
    process.kill(launcherPid, 'SIGTERM');
    await exited;

    const released = await waitFor(() => portIsFree(CALLBACK_PORT), 10000);
    expect(released).toBe(true);
    expect(before.filter(isAlive)).toEqual([]);
  }, 60000);
});
