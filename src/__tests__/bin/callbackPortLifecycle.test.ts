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

// Every test gets its own ports. Sharing them across tests makes one test's
// teardown a precondition of the next one's setup: a proxy that is still dying
// when the next test starts leaves its successor unable to bind, and the failure
// surfaces in the wrong test. Only the second test deliberately reuses a
// callback port, which is the property it exists to check.
type Proxy = { dest: string; httpPort: number; callbackPort: number };

const RELEASE = { dest: 'lifecycle-release', httpPort: 3041, callbackPort: 7841 };
const REUSE_FIRST = { dest: 'lifecycle-reuse-1', httpPort: 3043, callbackPort: 7843 };
const REUSE_SECOND = { dest: 'lifecycle-reuse-2', httpPort: 3044, callbackPort: 7843 };
const PAIR_A = { dest: 'lifecycle-pair-a', httpPort: 3045, callbackPort: 7845 };
const PAIR_B = { dest: 'lifecycle-pair-b', httpPort: 3046, callbackPort: 7846 };

const BIND_TIMEOUT_MS = 45000;
const RELEASE_TIMEOUT_MS = 10000;

// Ask by connecting, never by binding. A probe that binds to answer "is this
// free?" holds the port for as long as the check takes, and these tests poll
// while the process under test is trying to bind the very same port — the probe
// then intermittently wins that race and the proxy dies with EADDRINUSE, caused
// by the test rather than observed by it.
//
// Connecting is also address-agnostic: a connection to 127.0.0.1 reaches a
// listener bound to the wildcard or to loopback alike, so one probe is correct
// for both the callback server (`listen(PORT)`, no host) and the main HTTP
// server (bound to the configured httpHost). Binding probes are not — Linux
// treats wildcard and loopback binds as conflicting in both directions, macOS
// does not, which silently inverts the answer there.
function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const settle = (free: boolean) => {
      socket.destroy();
      resolve(free);
    };
    socket.setTimeout(1000);
    socket.once('connect', () => settle(false)); // someone is listening
    socket.once('error', () => settle(true)); // refused -> nothing there
    socket.once('timeout', () => settle(false)); // hung -> assume occupied
  });
}

const mainPortIsFree = portIsFree;

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

function makeFixture(proxy: Proxy): string {
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
  let usedPorts: number[] = [];
  // Keep each launcher's own account of what it did; when an expectation about
  // the login fails, this is the only thing that explains why.
  const outputs = new Map<ChildProcess, () => string>();

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
    // Do not let a still-dying proxy become the next test's problem.
    const ports = usedPorts;
    usedPorts = [];
    await waitFor(async () => {
      for (const port of ports) if (!(await portIsFree(port))) return false;
      return true;
    }, RELEASE_TIMEOUT_MS);
  });

  // Start a proxy and wait until its callback server holds the port, i.e. it is
  // sitting in the login window. Surfaces the launcher's own output on failure —
  // on a CI runner nothing else explains why the bind never happened.
  async function startAndAwaitLoginWindow(
    proxy: Proxy,
  ): Promise<ChildProcess> {
    const dir = makeFixture(proxy);
    dirs.push(dir);
    usedPorts.push(proxy.httpPort, proxy.callbackPort);
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
    outputs.set(child, () => output);

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

  // Deliver the authorization code the way a browser redirect would, then wait
  // for the exchange to actually happen.
  //
  // The HTTP status is deliberately not asserted. On success the server responds
  // and then tears the connection down — `finalizeSuccess` closes on the
  // response's `finish` event, which means "handed to the OS", not "read by the
  // client", and `closeAllConnections()` destroys the socket underneath. A
  // client can therefore legitimately see ECONNRESET instead of the success
  // page. What proves the login completed is the token exchange, so that is what
  // is waited on.
  // Deliver the authorization code the way a browser redirect would, and keep
  // trying until the exchange actually happens.
  //
  // Two things make a single request unreliable, neither of them the property
  // under test. On success the server answers and then tears the connection
  // down — `finalizeSuccess` closes on the response's `finish` event, which
  // means "handed to the OS", not "read by the client" — so the client can see
  // ECONNRESET instead of the success page. And the polling above opens many
  // short-lived connections to this exact address, so an occasional new one
  // collides with a TIME_WAIT tuple on loopback and never lands. Retrying makes
  // the delivery robust; the assertion stays on the token exchange, which is
  // what actually proves the login completed.
  async function completeLogin(
    proxy: Proxy,
    child?: ChildProcess,
  ): Promise<void> {
    const before = tokenExchanges;
    const deadline = Date.now() + RELEASE_TIMEOUT_MS;
    let attempts = 0;

    while (Date.now() < deadline && tokenExchanges <= before) {
      attempts += 1;
      try {
        await fetch(
          `http://127.0.0.1:${proxy.callbackPort}/callback?code=code-${proxy.dest}`,
        );
      } catch {
        // Reset or refused: either the server closed on us after handling the
        // code, or the connection never landed. The exchange counter decides.
      }
      await waitFor(async () => tokenExchanges > before, 1500);
    }

    if (tokenExchanges <= before) {
      const log = child ? outputs.get(child)?.() : undefined;
      throw new Error(
        `${proxy.dest}: delivered the authorization code to port ` +
          `${proxy.callbackPort} ${attempts} time(s), but no token exchange ` +
          `reached the stand-in UAA within ${RELEASE_TIMEOUT_MS} ms ` +
          `(alive=${child ? child.exitCode === null : 'unknown'}, ` +
          `exitCode=${child?.exitCode}).\n--- launcher output ---\n` +
          `${log ?? '(not captured)'}\n--- end ---`,
      );
    }
  }

  it('releases the callback port as soon as the login completes, while the proxy keeps running', async () => {
    const child = await startAndAwaitLoginWindow(RELEASE);
    const exchangesBefore = tokenExchanges;

    await completeLogin(RELEASE, child);

    // The port must come back the moment the code has been exchanged — not at
    // shutdown. This is the whole guarantee: a callback port is held for the
    // login and nothing longer.
    const released = await waitFor(
      () => portIsFree(RELEASE.callbackPort),
      RELEASE_TIMEOUT_MS,
    );
    expect(released).toBe(true);

    // ...and the proxy is still serving. A port that is free only because the
    // process died would prove nothing.
    expect(isAlive(child.pid as number)).toBe(true);
    expect(child.exitCode).toBeNull();
    expect(tokenExchanges).toBeGreaterThan(exchangesBefore);
    expect(await mainPortIsFree(RELEASE.httpPort)).toBe(false);
  }, 120000);

  it('lets a second proxy claim the same callback port while the first still runs', async () => {
    const first = await startAndAwaitLoginWindow(REUSE_FIRST);
    await completeLogin(REUSE_FIRST, first);
    expect(
      await waitFor(
        () => portIsFree(REUSE_FIRST.callbackPort),
        RELEASE_TIMEOUT_MS,
      ),
    ).toBe(true);

    // The original symptom, in test form: start, authenticate, then start again
    // against the same configured auth port. The first proxy is deliberately
    // left running — if it were still holding the port, this second login
    // window could not open.
    const second = await startAndAwaitLoginWindow(REUSE_SECOND);

    expect(isAlive(first.pid as number)).toBe(true);
    expect(isAlive(second.pid as number)).toBe(true);
  }, 120000);

  it('runs two proxies on different main ports without interfering', async () => {
    const [first, second] = await Promise.all([
      startAndAwaitLoginWindow(PAIR_A),
      startAndAwaitLoginWindow(PAIR_B),
    ]);

    // Each held its own callback port at the same time.
    await completeLogin(PAIR_A, first);
    await completeLogin(PAIR_B, second);

    for (const proxy of [PAIR_A, PAIR_B]) {
      expect(
        await waitFor(() => portIsFree(proxy.callbackPort), RELEASE_TIMEOUT_MS),
      ).toBe(true);
    }

    // Both alive, each still owning its own main port.
    expect(isAlive(first.pid as number)).toBe(true);
    expect(isAlive(second.pid as number)).toBe(true);
    expect(await mainPortIsFree(PAIR_A.httpPort)).toBe(false);
    expect(await mainPortIsFree(PAIR_B.httpPort)).toBe(false);
  }, 120000);
});
