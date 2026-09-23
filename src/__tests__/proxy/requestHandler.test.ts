/**
 * The one request handler, shared by the standalone proxy and the MCP mode.
 *
 * They differ in exactly one thing, and it is the reason this is a parameter
 * rather than a method: what an authentication failure MEANS. The standalone
 * proxy treats it as fatal and exits so a supervisor can restart it. The MCP
 * mode must not — exiting there would take the MCP server, and the client's
 * whole session, down with a proxy that failed to authenticate.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import {
  createServer,
  type IncomingMessage,
  request as httpRequest,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createProxyRequestHandler } from '../../proxy/requestHandler.js';

let backend: Server;
let backendUrl: string;

beforeAll(async () => {
  backend = createServer((req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        authorization: req.headers.authorization ?? null,
        client: req.headers['x-sap-client'] ?? null,
        path: req.url,
      }),
    );
  });
  await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
  const address = backend.address();
  backendUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => backend.close(() => resolve()));
});

/** Drive the handler through a real socket and collect what came back. */
async function through(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const front = createServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => front.listen(0, '127.0.0.1', resolve));
  const address = front.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  try {
    return await new Promise((resolve, reject) => {
      const req = httpRequest(
        { hostname: '127.0.0.1', port, path: '/mcp', method: 'POST', headers },
        (res) => {
          let body = '';
          res.on('data', (c) => {
            body += c;
          });
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body }),
          );
        },
      );
      req.on('error', reject);
      req.end();
    });
  } finally {
    await new Promise<void>((resolve) => front.close(() => resolve()));
  }
}

const workingProxy = (over: Record<string, unknown> = {}) => ({
  getAuthorizationHeader: async () => 'Bearer live-token',
  getTargetUrl: async () => backendUrl,
  ...over,
});

describe('createProxyRequestHandler', () => {
  it('refuses a request with no destination, and says why', async () => {
    const handler = createProxyRequestHandler({
      config: {},
      proxy: async () => workingProxy() as never,
    });

    const { status, body } = await through(handler);

    expect(status).toBe(400);
    expect(body).toMatch(/destination/i);
  });

  it("puts the credential's header on the forwarded request", async () => {
    const handler = createProxyRequestHandler({
      config: { btpDestination: 'D1' },
      proxy: async () => workingProxy() as never,
    });

    const { status, body } = await through(handler);

    expect(status).toBe(200);
    expect(JSON.parse(body).authorization).toBe('Bearer live-token');
  });

  it('injects default headers, and lets the client override them', async () => {
    const handler = createProxyRequestHandler({
      config: { btpDestination: 'D1', defaultHeaders: { 'x-sap-client': '100' } },
      proxy: async () => workingProxy() as never,
    });

    const injected = await through(handler);
    const overridden = await through(handler, { 'x-sap-client': '200' });

    expect(JSON.parse(injected.body).client).toBe('100');
    expect(JSON.parse(overridden.body).client).toBe('200');
  });

  it('answers 502 on an authentication failure and reports it to the policy', async () => {
    const seen: string[] = [];
    const handler = createProxyRequestHandler({
      config: { btpDestination: 'D1' },
      proxy: async () =>
        workingProxy({
          getAuthorizationHeader: async () => {
            throw new Error('no service key');
          },
        }) as never,
      onAuthFailure: async (_error, destination) => {
        seen.push(destination);
      },
    });

    const { status } = await through(handler);

    expect(status).toBe(502);
    expect(seen).toEqual(['D1']);
  });

  it('does not call the authentication policy when it is the FORWARD that failed', async () => {
    const seen: string[] = [];
    const handler = createProxyRequestHandler({
      config: { btpDestination: 'D1' },
      proxy: async () =>
        workingProxy({ getTargetUrl: async () => 'http://127.0.0.1:1' }) as never,
      onAuthFailure: async () => {
        seen.push('called');
      },
    });

    const { status } = await through(handler);

    // A dead backend is not a credential problem, and treating it as one is how
    // a proxy ends up exiting over someone else's outage.
    expect(status).toBe(502);
    expect(seen).toEqual([]);
  });

  it('survives an authentication failure when no policy is given', async () => {
    const handler = createProxyRequestHandler({
      config: { btpDestination: 'D1' },
      proxy: async () =>
        workingProxy({
          getAuthorizationHeader: async () => {
            throw new Error('no service key');
          },
        }) as never,
    });

    const { status } = await through(handler);

    expect(status).toBe(502);
  });
});
