/**
 * Sends live MCP requests through a running proxy (cross-platform, no shell).
 *
 * The proxy injects the JWT + default headers (x-sap-destination/client/login/
 * password) and forwards to the BTP target. This script only drives the proxy's
 * HTTP endpoint and prints what comes back.
 *
 * Usage:
 *   node tools/test-requests.cjs                 # http://127.0.0.1:3001/mcp/stream/http
 *   node tools/test-requests.cjs --url <url>
 *   PROXY_URL=<url> node tools/test-requests.cjs
 */
const http = require('node:http');
const https = require('node:https');

function flagValue(flag) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : undefined;
}

const BASE_URL =
  flagValue('--url') ||
  process.env.PROXY_URL ||
  'http://127.0.0.1:3001/mcp/stream/http';

// MCP streamable-HTTP wants both JSON and SSE acceptable.
const ACCEPT = 'application/json, text/event-stream';

/**
 * POST a JSON-RPC body to the proxy. Returns { status, headers, body }.
 */
function send(name, bodyObj, sessionId) {
  const json = JSON.stringify(bodyObj);
  const url = new URL(BASE_URL);
  const client = url.protocol === 'https:' ? https : http;
  const headers = {
    'content-type': 'application/json',
    accept: ACCEPT,
    'content-length': Buffer.byteLength(json),
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  return new Promise((resolve, reject) => {
    console.log(`\n=== ${name} ===`);
    console.log(`POST ${BASE_URL}`);
    console.log(`body: ${json}`);
    const req = client.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers,
        timeout: 30_000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: data }),
        );
      },
    );
    req.on('timeout', () => req.destroy(new Error('request timed out after 30s')));
    req.on('error', reject);
    req.end(json);
  });
}

function printResult({ status, body }) {
  const ok = status < 400;
  console.log(`HTTP ${status}${ok ? '' : '  <-- non-2xx'}`);
  const shown = body.length > 1500 ? `${body.slice(0, 1500)} ...[truncated]` : body;
  console.log(shown);
}

(async () => {
  const init = await send('initialize', {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'verify-script', version: '1.0.0' },
    },
  });
  printResult(init);

  // Carry the session id forward so tools/list runs in the initialized session.
  const sessionId = init.headers['mcp-session-id'];
  if (sessionId) console.log(`(mcp-session-id: ${sessionId})`);

  const tools = await send(
    'tools/list',
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    sessionId,
  );
  printResult(tools);

  process.exit(init.status < 400 && tools.status < 400 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
