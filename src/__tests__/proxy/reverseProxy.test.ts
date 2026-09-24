// src/__tests__/proxy/reverseProxy.test.ts
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { forwardRequest } from '../../proxy/reverseProxy.js';

// Test backend server
let backend: Server;
let backendPort: number;

beforeAll(async () => {
  backend = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url || '/';

    if (url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'gpt-4' }] }));
      return;
    }

    if (url === '/v1/chat/completions' && req.method === 'POST') {
      // Check authorization header was forwarded
      const auth = req.headers['authorization'];
      if (!auth || !auth.startsWith('Bearer ')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      // Check if streaming requested
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const parsed = JSON.parse(body);
        if (parsed.stream) {
          // SSE streaming response
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });
          res.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
          res.write('data: {"choices":[{"delta":{"content":" world"}}]}\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            choices: [{ message: { content: 'Hello world' } }],
          }));
        }
      });
      return;
    }

    if (url === '/echo-body' && req.method === 'POST') {
      let seen = '';
      req.on('data', (chunk) => { seen += chunk; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ seen, contentLength: req.headers['content-length'] ?? null }));
      });
      return;
    }

    if (url === '/echo-headers') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ authorization: req.headers['authorization'] ?? null }));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  await new Promise<void>((resolve) => {
    backend.listen(0, () => {
      const addr = backend.address();
      backendPort = typeof addr === 'object' && addr ? addr.port : 0;
      resolve();
    });
  });
});

afterAll(() => {
  backend.close();
});

describe('forwardRequest', () => {
  it('should forward GET request and return response', async () => {
    const { statusCode, headers, body } = await makeProxiedRequest(
      'GET', '/v1/models', undefined, 'Bearer test-jwt-token',
    );
    expect(statusCode).toBe(200);
    expect(headers['content-type']).toContain('application/json');
    const data = JSON.parse(body);
    expect(data.data[0].id).toBe('gpt-4');
  });

  it('should forward POST request with body and JWT', async () => {
    const reqBody = JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] });
    const { statusCode, body } = await makeProxiedRequest(
      'POST', '/v1/chat/completions', reqBody, 'Bearer test-jwt-token',
    );
    expect(statusCode).toBe(200);
    const data = JSON.parse(body);
    expect(data.choices[0].message.content).toBe('Hello world');
  });

  it('should forward streaming response', async () => {
    const reqBody = JSON.stringify({ model: 'gpt-4', messages: [], stream: true });
    const { statusCode, headers, body } = await makeProxiedRequest(
      'POST', '/v1/chat/completions', reqBody, 'Bearer test-jwt-token',
    );
    expect(statusCode).toBe(200);
    expect(headers['content-type']).toContain('text/event-stream');
    expect(body).toContain('data: {"choices"');
    expect(body).toContain('[DONE]');
  });

  it('should return 401 when backend rejects auth', async () => {
    const reqBody = JSON.stringify({ model: 'gpt-4', messages: [] });
    const { statusCode } = await makeProxiedRequest(
      'POST', '/v1/chat/completions', reqBody, '', // empty JWT
    );
    expect(statusCode).toBe(401);
  });

  it('should return 502 when backend is unreachable', async () => {
    const { statusCode } = await makeProxiedRequest(
      'GET', '/v1/models', undefined, 'Bearer jwt', 'http://localhost:1', // bad port
    );
    expect(statusCode).toBe(502);
  });

  it('should inject default headers into forwarded request', async () => {
    const { statusCode } = await makeProxiedRequest(
      'GET', '/v1/models', undefined, 'Bearer test-jwt-token',
      undefined,
      { 'x-sap-destination': 'S4HANA', 'x-sap-client': '100' },
    );
    expect(statusCode).toBe(200);
  });

  it('should not override client headers with default headers', async () => {
    const { statusCode } = await makeProxiedRequest(
      'GET', '/v1/models', undefined, 'Bearer test-jwt-token',
      undefined,
      { 'content-type': 'text/plain' },
    );
    expect(statusCode).toBe(200);
  });

  // The credential answers with a complete header value, not a bare token:
  // `authorizationHeader()` returns `Bearer <token>`. Composing `Bearer` here
  // as well would send `Bearer Bearer <token>`.
  it('forwards the authorization value it is given, verbatim', async () => {
    const { body } = await makeProxiedRequest(
      'GET', '/echo-headers', undefined, 'Bearer abc123',
    );
    expect(JSON.parse(body).authorization).toBe('Bearer abc123');
  });

  // The SSE path reads the body before forwarding, because the JSON-RPC id in
  // it is what an error envelope has to echo. Once read, the stream is spent —
  // piping the request would forward an empty body.
  it('forwards a body that was already read off the request', async () => {
    const payload = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' });
    const { body } = await makeProxiedRequest(
      'POST', '/echo-body', payload, 'Bearer t', undefined, undefined,
      Buffer.from(payload),
    );
    const echoed = JSON.parse(body);
    expect(echoed.seen).toBe(payload);
    expect(echoed.contentLength).toBe(String(Buffer.byteLength(payload)));
  });

  // `closeAllConnections()` on the front server destroys the CLIENT socket. If
  // nothing destroys the upstream one, an abandoned event stream leaves a live
  // connection to the backend — and `proxy_stop` reports a released port while
  // holding a socket. Repeated start/stop then accumulates them.
  it('destroys the upstream connection when the client goes away', async () => {
    let upstreamClosed = false;
    const streaming = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: first\n\n');
      res.on('close', () => {
        upstreamClosed = true;
      });
    });
    await new Promise<void>((r) => streaming.listen(0, '127.0.0.1', r));
    const addr = streaming.address();
    const upstream = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

    const front = createServer((req, res) => {
      void forwardRequest(req, res, upstream, 'Bearer t');
    });
    await new Promise<void>((r) => front.listen(0, '127.0.0.1', r));
    const frontAddr = front.address();
    const frontPort =
      typeof frontAddr === 'object' && frontAddr ? frontAddr.port : 0;

    try {
      // Open it, wait for the first byte, then cut the client the way a stop does.
      await new Promise<void>((resolve, reject) => {
        const req = require('node:http').request(
          { host: '127.0.0.1', port: frontPort, path: '/sse' },
          (res: IncomingMessage) => res.once('data', () => resolve()),
        );
        req.on('error', reject);
        req.end();
      });
      front.closeAllConnections();

      await new Promise((r) => setTimeout(r, 250));
      expect(upstreamClosed).toBe(true);
    } finally {
      await new Promise<void>((r) => front.close(() => r()));
      streaming.closeAllConnections?.();
      await new Promise<void>((r) => streaming.close(() => r()));
    }
  });

  // A credential that is not a header answers `null` — a certificate
  // authenticates through TLS and has none. `null` must reach the backend as an
  // ABSENT header; an empty `Authorization` is a different thing and some
  // servers reject it.
  it('sends no authorization header when the credential has none', async () => {
    const { body } = await makeProxiedRequest(
      'GET', '/echo-headers', undefined, null,
    );
    expect(JSON.parse(body).authorization).toBeNull();
  });
});

// Helper: create a fake client request, forward through reverseProxy, collect response
async function makeProxiedRequest(
  method: string,
  path: string,
  body: string | undefined,
  authorization: string | null,
  targetUrlOverride?: string,
  defaultHeaders?: Record<string, string>,
  preReadBody?: Buffer,
): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  const targetUrl = targetUrlOverride || `http://localhost:${backendPort}`;

  return new Promise((resolve) => {
    // Create a local HTTP server that acts as "client side"
    const testServer = createServer(async (req, res) => {
      if (preReadBody) {
        // Spend the stream the way the SSE path does, then hand over the bytes.
        for await (const _chunk of req) {
          /* drained */
        }
      }
      await forwardRequest(
        req, res, targetUrl, authorization, defaultHeaders, preReadBody,
      );
    });

    testServer.listen(0, () => {
      const addr = testServer.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;

      const http = require('node:http');
      const options = {
        hostname: 'localhost',
        port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
        },
      };

      const clientReq = http.request(options, (clientRes: IncomingMessage) => {
        let responseBody = '';
        clientRes.on('data', (chunk: Buffer) => { responseBody += chunk.toString(); });
        clientRes.on('end', () => {
          testServer.close();
          resolve({
            statusCode: clientRes.statusCode || 500,
            headers: clientRes.headers as Record<string, string>,
            body: responseBody,
          });
        });
      });

      if (body) {
        clientReq.write(body);
      }
      clientReq.end();
    });
  });
}
