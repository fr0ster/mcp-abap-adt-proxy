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
 * Forward an HTTP request to a target URL, with the credential's header.
 * Streams both request and response using pipe().
 *
 * `authorization` is a complete header VALUE, not a token: it is what
 * `IAuthProvider.authorizationHeader()` answers, `Bearer <token>` and all.
 * Composing `Bearer` here as well would send `Bearer Bearer <token>`.
 *
 * `requestBody` is for a caller that has already read the request: the SSE path
 * parses the JSON-RPC body because an error envelope has to echo its `id`, and
 * a stream read once cannot be piped. The RESPONSE still streams either way,
 * which is the direction that carries an event stream.
 */
export async function forwardRequest(
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
  targetBaseUrl: string,
  authorization: string | null,
  defaultHeaders?: Record<string, string>,
  requestBody?: Buffer,
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

  // The credential's header, verbatim.
  //
  // `null` means this credential is not a header at all — a certificate
  // authenticates through TLS and has none — and must reach the target as an
  // ABSENT header rather than an empty one, which is a different claim.
  //
  // `''` is treated the same way. The contract calls the empty string a legal
  // header value, but the provider that answers it here returns it for "no
  // token", not for "an empty Authorization" — and that is also what this
  // function did before it carried header values.
  if (authorization) {
    forwardedHeaders.authorization = authorization;
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
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

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
      proxyRes.on('end', finish);
    });

    // The client going away has to take the upstream with it.
    //
    // A stop destroys the CLIENT socket — `closeAllConnections()` — and nothing
    // here destroyed the other one, so an abandoned event stream left a live
    // connection to the target: a released port reported while a socket was
    // still held, accumulating across repeated start/stop. It also left this
    // promise pending forever, since `proxyRes` never ends.
    clientRes.on('close', () => {
      if (!settled) proxyReq.destroy();
      finish();
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
      finish();
    });

    // Pipe client request body to backend — or write what the caller already
    // read off it, since a spent stream pipes nothing.
    if (requestBody === undefined) {
      clientReq.pipe(proxyReq);
    } else {
      proxyReq.end(requestBody);
    }
  });
}
