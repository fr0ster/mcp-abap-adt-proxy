/**
 * Deterministic verification of default-header forwarding + env interpolation.
 *
 * Drives the REAL loadConfig() (with the exact CLI argv the proxy uses) and the
 * REAL reverseProxy.forwardRequest() against a local echo backend, so we can see
 * precisely which headers reach the target — no BTP / browser auth involved.
 *
 * Build first (`npm run build`), then point it at your config:
 *   node tools/verify-default-headers.cjs --config <path> [--env-file <path>]
 *   PROXY_CONFIG=<path> PROXY_ENV_FILE=<path> node tools/verify-default-headers.cjs
 *
 * Everything is derived from the supplied config — no hardcoded paths,
 * destinations, clients, or secrets.
 */
const http = require('node:http');

function flagValue(flag) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : undefined;
}

const CONFIG = flagValue('--config') || process.env.PROXY_CONFIG;
const ENVFILE = flagValue('--env-file') || process.env.PROXY_ENV_FILE;

if (!CONFIG) {
  console.error(
    'Usage: node tools/verify-default-headers.cjs --config <path> [--env-file <path>]\n' +
      '   or: PROXY_CONFIG=<path> [PROXY_ENV_FILE=<path>] node tools/verify-default-headers.cjs',
  );
  process.exit(2);
}

// Mimic the exact command line the proxy is launched with.
process.argv = [
  process.execPath,
  'verify',
  `--config=${CONFIG}`,
  ...(ENVFILE ? ['--env-file', ENVFILE] : []),
];

const { loadConfig } = require('../dist/lib/config.js');
const { forwardRequest } = require('../dist/proxy/reverseProxy.js');

function maskSecret(k, v) {
  return /password|secret|authorization|token/i.test(k)
    ? `${String(v).slice(0, 4)}***(len=${String(v).length})`
    : v;
}

(async () => {
  const config = loadConfig();
  const defaults = config.defaultHeaders || {};

  console.log('\n=== 1. loadConfig() result (defaultHeaders) ===');
  for (const [k, v] of Object.entries(defaults)) {
    console.log(`  ${k}: ${maskSecret(k, v)}`);
  }

  const login = defaults['x-sap-login'];
  const pass = defaults['x-sap-password'];
  const destination = defaults['x-sap-destination'];
  const defaultClient = defaults['x-sap-client'];

  // Sanity: secrets must be interpolated, not left as ${VAR}.
  const interpolated =
    (login === undefined || !login.includes('${')) &&
    (pass === undefined || !pass.includes('${'));
  console.log(
    `\n  Interpolation OK: ${interpolated ? 'YES' : 'NO'} (no leftover \${VAR} in login/password)`,
  );

  // 2. Echo backend: returns the headers it received.
  const echo = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ received: req.headers }));
  });
  await new Promise((r) => echo.listen(0, '127.0.0.1', r));
  const echoUrl = `http://127.0.0.1:${echo.address().port}`;

  // 3. Front server that runs the real forwardRequest with config.defaultHeaders.
  const front = http.createServer((req, res) => {
    forwardRequest(req, res, echoUrl, 'FAKE.JWT.TOKEN', defaults);
  });
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  const frontPort = front.address().port;

  // 4. Client request. Sends an x-sap-client that differs from the configured
  //    default (to confirm client-wins) plus its own authorization (to confirm
  //    JWT replacement). The override value is picked relative to the default,
  //    so nothing is hardcoded to a specific environment.
  const overrideClient = defaultClient === '777' ? '778' : '777';
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
  const received = await new Promise((resolve, reject) => {
    const r = http.request(
      {
        host: '127.0.0.1',
        port: frontPort,
        method: 'POST',
        path: '/mcp',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'x-sap-client': overrideClient,
          authorization: 'Bearer CLIENT_TOKEN_SHOULD_BE_REPLACED',
        },
      },
      (resp) => {
        let d = '';
        resp.on('data', (c) => (d += c));
        resp.on('end', () => resolve(JSON.parse(d).received));
      },
    );
    r.on('error', reject);
    r.end(body);
  });

  console.log('\n=== 2. Headers the TARGET actually received ===');
  for (const [k, v] of Object.entries(received)) {
    if (k === 'host' || k === 'content-length' || k === 'connection') continue;
    console.log(`  ${k}: ${maskSecret(k, v)}`);
  }

  console.log('\n=== 3. Assertions (derived from config) ===');
  const checks = [['no leftover ${VAR} in secrets', interpolated]];
  if (destination !== undefined) {
    checks.push([
      `x-sap-destination forwarded (${destination})`,
      received['x-sap-destination'] === destination,
    ]);
  }
  if (login !== undefined) {
    checks.push([
      'x-sap-login forwarded from .env',
      received['x-sap-login'] === login,
    ]);
  }
  if (pass !== undefined) {
    checks.push([
      'x-sap-password forwarded from .env',
      received['x-sap-password'] === pass,
    ]);
  }
  checks.push([
    `client x-sap-client=${overrideClient} overrides default${defaultClient ? ` (${defaultClient})` : ''}`,
    received['x-sap-client'] === overrideClient,
  ]);
  checks.push([
    'authorization replaced with proxy JWT',
    received['authorization'] === 'Bearer FAKE.JWT.TOKEN',
  ]);

  let allPass = true;
  for (const [name, ok] of checks) {
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`);
    if (!ok) allPass = false;
  }

  echo.close();
  front.close();
  console.log(`\n=== ${allPass ? 'ALL PASS' : 'FAILURES PRESENT'} ===`);
  process.exit(allPass ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
