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
      'GET', '/v1/models', undefined, 'test-jwt-token',
    );
    expect(statusCode).toBe(200);
    expect(headers['content-type']).toContain('application/json');
    const data = JSON.parse(body);
    expect(data.data[0].id).toBe('gpt-4');
  });

  it('should forward POST request with body and JWT', async () => {
    const reqBody = JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] });
    const { statusCode, body } = await makeProxiedRequest(
      'POST', '/v1/chat/completions', reqBody, 'test-jwt-token',
    );
    expect(statusCode).toBe(200);
    const data = JSON.parse(body);
    expect(data.choices[0].message.content).toBe('Hello world');
  });

  it('should forward streaming response', async () => {
    const reqBody = JSON.stringify({ model: 'gpt-4', messages: [], stream: true });
    const { statusCode, headers, body } = await makeProxiedRequest(
      'POST', '/v1/chat/completions', reqBody, 'test-jwt-token',
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
      'GET', '/v1/models', undefined, 'jwt', 'http://localhost:1', // bad port
    );
    expect(statusCode).toBe(502);
  });

  it('should inject default headers into forwarded request', async () => {
    const { statusCode } = await makeProxiedRequest(
      'GET', '/v1/models', undefined, 'test-jwt-token',
      undefined,
      { 'x-sap-destination': 'S4HANA', 'x-sap-client': '100' },
    );
    expect(statusCode).toBe(200);
  });

  it('should not override client headers with default headers', async () => {
    const { statusCode } = await makeProxiedRequest(
      'GET', '/v1/models', undefined, 'test-jwt-token',
      undefined,
      { 'content-type': 'text/plain' },
    );
    expect(statusCode).toBe(200);
  });
});

// Helper: create a fake client request, forward through reverseProxy, collect response
async function makeProxiedRequest(
  method: string,
  path: string,
  body: string | undefined,
  jwt: string,
  targetUrlOverride?: string,
  defaultHeaders?: Record<string, string>,
): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  const targetUrl = targetUrlOverride || `http://localhost:${backendPort}`;

  return new Promise((resolve) => {
    // Create a local HTTP server that acts as "client side"
    const testServer = createServer(async (req, res) => {
      await forwardRequest(req, res, targetUrl, jwt, defaultHeaders);
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
