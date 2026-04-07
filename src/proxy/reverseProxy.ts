// src/proxy/reverseProxy.ts
import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';
import { logger } from '../lib/logger.js';

/**
 * Hop-by-hop headers that should not be forwarded
 */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
]);

/**
 * Forward an HTTP request to a target URL with JWT injection.
 * Streams both request and response using pipe().
 */
export async function forwardRequest(
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
  targetBaseUrl: string,
  jwtToken: string,
  defaultHeaders?: Record<string, string>,
): Promise<void> {
  const targetUrl = new URL(clientReq.url || '/', targetBaseUrl);

  // Build forwarded headers: defaults first, then client headers override
  const forwardedHeaders: Record<string, string | string[]> = {};

  // 1. Inject default headers (low priority)
  if (defaultHeaders) {
    for (const [key, value] of Object.entries(defaultHeaders)) {
      forwardedHeaders[key.toLowerCase()] = value;
    }
  }

  // 2. Copy client headers (high priority — overrides defaults)
  for (const [key, value] of Object.entries(clientReq.headers)) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
    if (key.toLowerCase() === 'authorization') continue;
    if (value !== undefined) {
      forwardedHeaders[key] = value;
    }
  }

  // Inject JWT
  if (jwtToken) {
    forwardedHeaders.authorization = `Bearer ${jwtToken}`;
  }

  // Set correct host for target
  forwardedHeaders.host = targetUrl.host;

  // Debug: log incoming vs forwarded headers to diagnose header drops
  logger?.debug('Headers forwarding detail', {
    type: 'REVERSE_PROXY_HEADERS',
    incoming: Object.keys(clientReq.headers),
    forwarded: Object.keys(forwardedHeaders),
    hasAccept: !!forwardedHeaders.accept || !!forwardedHeaders.Accept,
    defaultHeaderKeys: defaultHeaders ? Object.keys(defaultHeaders) : [],
  });

  const isHttps = targetUrl.protocol === 'https:';
  const transport = isHttps ? https : http;

  const options: http.RequestOptions = {
    hostname: targetUrl.hostname,
    port: targetUrl.port || (isHttps ? 443 : 80),
    path: targetUrl.pathname + targetUrl.search,
    method: clientReq.method || 'GET',
    headers: forwardedHeaders,
  };

  logger?.info('Forwarding request', {
    type: 'REVERSE_PROXY_FORWARD',
    method: options.method,
    target: targetUrl.toString(),
  });

  return new Promise<void>((resolve) => {
    const proxyReq = transport.request(options, (proxyRes) => {
      // Forward status code
      const statusCode = proxyRes.statusCode || 502;

      // Forward response headers (skip hop-by-hop)
      const responseHeaders: Record<string, string | string[]> = {};
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
        if (value !== undefined) {
          responseHeaders[key] = value;
        }
      }

      logger?.info('Backend responded', {
        type: 'REVERSE_PROXY_RESPONSE',
        statusCode,
        contentType: proxyRes.headers['content-type'],
      });

      clientRes.writeHead(statusCode, responseHeaders);
      proxyRes.pipe(clientRes);
      proxyRes.on('end', resolve);
    });

    proxyReq.on('error', (err) => {
      logger?.error('Reverse proxy connection error', {
        type: 'REVERSE_PROXY_ERROR',
        error: err.message,
        target: targetUrl.toString(),
      });
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'Content-Type': 'application/json' });
        clientRes.end(JSON.stringify({ error: `Proxy error: ${err.message}` }));
      }
      resolve();
    });

    // Pipe client request body to backend
    clientReq.pipe(proxyReq);
  });
}
