import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
} from '@jest/globals';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

const bin = path.resolve(__dirname, '../../../bin/mcp-abap-adt-proxy.js');
const dist = path.resolve(__dirname, '../../../dist/index.js');

// Drives the built binary and real process trees. POSIX-only, and pointless
// without dist/.
const canRun = fs.existsSync(dist) && process.platform !== 'win32';
const describeBuilt = canRun ? describe : describe.skip;

// Two independent proxies, each with its own main port and its own callback port.
const A = { dest: 'lifecycle-a', httpPort: 3041, callbackPort: 7841 };
const B = { dest: 'lifecycle-b', httpPort: 3042, callbackPort: 7842 };

const BIND_TIMEOUT_MS = 45000;
const RELEASE_TIMEOUT_MS = 10000;

// Probe the address the callback server actually binds: browserAuth calls
// `server.listen(PORT)` with no host. Probing 127.0.0.1 instead asks a
// different question, and the two answers differ on macOS.
function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, () => s.close(() => resolve(true)));
  });
}

async function waitFor(
  fn: () => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
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

// Stand-in for XSUAA: answers the authorization-code exchange with tokens, so a
// login can actually complete. Without it the proxy would sit in the login
// window and this suite could never observe what happens after success.
let uaa: http.Server;
let uaaPort = 0;
let tokenExchanges = 0;

function startFakeUaa(): Promise<void> {
  return new Promise((resolve) => {
    uaa = http.createServer((req, res) => {
      if (req.url?.startsWith('/oauth/token')) {
        tokenExchanges += 1;
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              access_token: `AT.${'x'.repeat(40)}`,
              refresh_token: `RT.${'y'.repeat(40)}`,
              expires_in: 3600,
            }),
          );
        });
        return;
      }
      res.writeHead(200);
      res.end('ok');
    });
    uaa.listen(0, '127.0.0.1', () => {
      uaaPort = (uaa.address() as net.AddressInfo).port;
      resolve();
    });
  });
}

function makeFixture(proxy: typeof A): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-cb-'));
  fs.mkdirSync(path.join(dir, 'service-keys'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'service-keys', `${proxy.dest}.json`),
    JSON.stringify({
      credentials: {
        url: `http://127.0.0.1:${uaaPort}`,
        clientid: `client-${proxy.dest}`,
        clientsecret: 'secret',
      },
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'config.yaml'),
    [
      'transport: http',
      `httpPort: ${proxy.httpPort}`,
      'httpHost: "127.0.0.1"',
      `btpDestination: "${proxy.dest}"`,
      `targetUrl: "http://127.0.0.1:${uaaPort}"`,
      'browser: "none"',
      `browserAuthPort: ${proxy.callbackPort}`,
      'logLevel: "info"',
      '',
    ].join('\n'),
  );
  return dir;
}

describeBuilt('callback port lifecycle', () => {
  const dirs: string[] = [];
  let children: ChildProcess[] = [];

  beforeAll(async () => {
    await startFakeUaa();
  });

  afterAll(() => {
    uaa?.close();
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  afterEach(async () => {
    for (const child of children) {
      if (child.pid) {
        try {
          process.kill(child.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
    children = [];
    await waitFor(
      async () =>
        (await portIsFree(A.callbackPort)) &&
        (await portIsFree(B.callbackPort)) &&
        (await portIsFree(A.httpPort)) &&
        (await portIsFree(B.httpPort)),
      RELEASE_TIMEOUT_MS,
    );
  });

  // Start a proxy and wait until its callback server holds the port, i.e. it is
  // sitting in the login window. Surfaces the launcher's own output on failure —
  // on a CI runner nothing else explains why the bind never happened.
  async function startAndAwaitLoginWindow(
    proxy: typeof A,
  ): Promise<ChildProcess> {
    const dir = makeFixture(proxy);
    dirs.push(dir);
    let output = '';
    const child = spawn('node', [bin, '--config', path.join(dir, 'config.yaml')], {
      env: { ...process.env, AUTH_BROKER_PATH: dir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    child.stdout?.on('data', (b: Buffer) => {
      output += b.toString();
    });
    child.stderr?.on('data', (b: Buffer) => {
      output += b.toString();
    });

    const bound = await waitFor(
      async () => !(await portIsFree(proxy.callbackPort)),
      BIND_TIMEOUT_MS,
    );
    if (!bound) {
      throw new Error(
        `${proxy.dest}: callback port ${proxy.callbackPort} never bound within ` +
          `${BIND_TIMEOUT_MS} ms (exitCode=${child.exitCode}, signal=${child.signalCode}).\n` +
          `--- launcher output ---\n${output || '(no output)'}\n--- end ---`,
      );
    }
    return child;
  }

  // Deliver the authorization code the way a browser redirect would.
  async function completeLogin(proxy: typeof A): Promise<number> {
    const res = await fetch(
      `http://127.0.0.1:${proxy.callbackPort}/callback?code=code-${proxy.dest}`,
    );
    return res.status;
  }

  it('releases the callback port as soon as the login completes, while the proxy keeps running', async () => {
    const child = await startAndAwaitLoginWindow(A);
    const exchangesBefore = tokenExchanges;

    expect(await completeLogin(A)).toBe(200);

    // The port must come back the moment the code has been exchanged — not at
    // shutdown. This is the whole guarantee: a callback port is held for the
    // login and nothing longer.
    const released = await waitFor(
      () => portIsFree(A.callbackPort),
      RELEASE_TIMEOUT_MS,
    );
    expect(released).toBe(true);

    // ...and the proxy is still serving. A port that is free only because the
    // process died would prove nothing.
    expect(isAlive(child.pid as number)).toBe(true);
    expect(child.exitCode).toBeNull();
    expect(tokenExchanges).toBe(exchangesBefore + 1);
    expect(await portIsFree(A.httpPort)).toBe(false);
  }, 120000);

  it('lets a second proxy claim the same callback port while the first still runs', async () => {
    const first = await startAndAwaitLoginWindow(A);
    expect(await completeLogin(A)).toBe(200);
    expect(
      await waitFor(() => portIsFree(A.callbackPort), RELEASE_TIMEOUT_MS),
    ).toBe(true);

    // The original symptom, in test form: start, authenticate, then start again
    // against the same configured auth port. The first proxy is deliberately
    // left running — if it were still holding the port, this second login
    // window could not open.
    const second = await startAndAwaitLoginWindow({
      ...B,
      callbackPort: A.callbackPort,
    });

    expect(isAlive(first.pid as number)).toBe(true);
    expect(isAlive(second.pid as number)).toBe(true);
  }, 120000);

  it('runs two proxies on different main ports without interfering', async () => {
    const [first, second] = await Promise.all([
      startAndAwaitLoginWindow(A),
      startAndAwaitLoginWindow(B),
    ]);

    // Each held its own callback port at the same time.
    expect(await completeLogin(A)).toBe(200);
    expect(await completeLogin(B)).toBe(200);

    for (const proxy of [A, B]) {
      expect(
        await waitFor(() => portIsFree(proxy.callbackPort), RELEASE_TIMEOUT_MS),
      ).toBe(true);
    }

    // Both alive, each still owning its own main port.
    expect(isAlive(first.pid as number)).toBe(true);
    expect(isAlive(second.pid as number)).toBe(true);
    expect(await portIsFree(A.httpPort)).toBe(false);
    expect(await portIsFree(B.httpPort)).toBe(false);
  }, 120000);
});
