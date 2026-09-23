// src/proxy/requestHandler.ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { logger } from '../lib/logger.js';
import { RoutingStrategy } from '../router/headerAnalyzer.js';
import { interceptRequest } from '../router/requestInterceptor.js';
import { forwardRequest } from './reverseProxy.js';

/** The part of `BtpProxy` a forwarded request needs. */
export interface CredentialFacade {
  getAuthorizationHeader(destination: string): Promise<string | null>;
  getTargetUrl(destination: string): Promise<string>;
}

export interface ProxyRequestHandlerOptions {
  config: {
    btpDestination?: string;
    targetUrl?: string;
    defaultHeaders?: Record<string, string>;
  };
  /** Asked per request; the caller decides whether to build or reuse. */
  proxy: () => Promise<CredentialFacade>;
  /**
   * What an AUTHENTICATION failure means here — and it is a parameter because
   * the two callers disagree.
   *
   * The standalone proxy treats it as fatal and exits, so whatever started it
   * can start it again with a credential that works. The MCP mode must not:
   * exiting there takes the MCP server down with it, and the client's session
   * with that. Left out, the failure is simply answered and the process lives.
   *
   * A failure to FORWARD never reaches this. A dead backend is not a credential
   * problem, and treating it as one is how a proxy ends up exiting over
   * someone else's outage.
   */
  onAuthFailure?: (error: unknown, destination: string) => Promise<void> | void;
}

/**
 * The request path, in one place: analyse, authenticate, forward.
 *
 * It was a closure inside the standalone server, which is where it could stay
 * while there was one caller. The MCP mode is the second, and a copy of this
 * flow over there would be two places for the routing rules to drift apart.
 */
export function createProxyRequestHandler(
  options: ProxyRequestHandlerOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { config, proxy, onAuthFailure } = options;

  return async function handle(req, res) {
    const intercepted = interceptRequest(
      req,
      undefined,
      { btpDestination: config.btpDestination, targetUrl: config.targetUrl },
      { skipHeaderValidation: true },
    );

    if (intercepted.routingDecision.strategy === RoutingStrategy.UNKNOWN) {
      logger?.error('Routing decision failed', {
        type: 'ROUTING_DECISION_FAILED',
        reason: intercepted.routingDecision.reason,
      });
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: intercepted.routingDecision.reason }));
      return;
    }

    const destination = intercepted.routingDecision.btpDestination;
    if (!destination) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No BTP destination specified' }));
      return;
    }

    const facade = await proxy();

    // Authentication is separated from forwarding on purpose: the two failures
    // mean different things, and only one of them is about us.
    let authorization: string | null;
    try {
      authorization = await facade.getAuthorizationHeader(destination);
    } catch (authError) {
      logger?.error('Proxy request failed: authentication error', {
        type: 'PROXY_REQUEST_AUTH_ERROR',
        destination,
        error:
          authError instanceof Error ? authError.message : String(authError),
      });
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Authentication failed' }));
      }
      await onAuthFailure?.(authError, destination);
      return;
    }

    try {
      const targetUrl =
        intercepted.routingDecision.targetUrl ||
        (await facade.getTargetUrl(destination));

      await forwardRequest(
        req,
        res,
        targetUrl,
        authorization,
        config.defaultHeaders,
      );
    } catch (error) {
      logger?.error('Proxy request failed', {
        type: 'PROXY_REQUEST_ERROR',
        destination,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : 'Proxy error',
          }),
        );
      }
    }
  };
}
