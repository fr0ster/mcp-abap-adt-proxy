/**
 * Request Interceptor - Intercepts and analyzes MCP requests
 */

import type { IncomingMessage } from 'node:http';
import { validateProxyHeaders } from '@mcp-abap-adt/header-validator';
import {
  HEADER_AUTHORIZATION,
  HEADER_MCP_SESSION_ID,
  HEADER_SAP_JWT_TOKEN,
  HEADER_SAP_PASSWORD,
  HEADER_SAP_REFRESH_TOKEN,
  HEADER_SAP_UAA_CLIENT_SECRET,
  HEADER_SESSION_ID,
  HEADER_X_MCP_SESSION_ID,
} from '@mcp-abap-adt/interfaces';
import { logger } from '../lib/logger.js';
import {
  analyzeHeaders,
  type RoutingDecision,
  RoutingStrategy,
} from './headerAnalyzer.js';

export interface InterceptedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body?: any;
  routingDecision: RoutingDecision;
  sessionId?: string;
  clientId?: string;
}

/**
 * Intercept and analyze incoming HTTP request
 */
export function interceptRequest(
  req: IncomingMessage,
  body?: any,
  configOverrides?: {
    btpDestination?: string;
    mcpUrl?: string;
  },
): InterceptedRequest {
  // Extract headers
  const headers: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    headers[key] = value;
  }

  // Analyze headers for routing decision (with config overrides)
  const routingDecision = analyzeHeaders(req.headers, configOverrides);

  // Validate proxy headers only if request will be processed as PROXY (not PASSTHROUGH)
  // For PASSTHROUGH requests, validation is not needed as headers are passed as-is
  if (routingDecision.strategy !== RoutingStrategy.PASSTHROUGH) {
    const validation = validateProxyHeaders(req.headers);
    if (!validation.isValid && validation.errors.length > 0) {
      logger?.warn('Proxy header validation failed', {
        type: 'PROXY_HEADER_VALIDATION_ERROR',
        errors: validation.errors,
        warnings: validation.warnings,
      });
    } else if (validation.warnings.length > 0) {
      logger?.warn('Proxy header validation warnings', {
        type: 'PROXY_HEADER_VALIDATION_WARNINGS',
        warnings: validation.warnings,
      });
    }
  }

  // Extract session ID if present
  const sessionId = (req.headers[HEADER_SESSION_ID] ||
    req.headers[HEADER_MCP_SESSION_ID] ||
    req.headers[HEADER_X_MCP_SESSION_ID]) as string | undefined;

  // Generate client ID
  const clientId = `${req.socket.remoteAddress}:${req.socket.remotePort}`;

  // Log intercepted request
  logger?.debug('Request intercepted', {
    type: 'REQUEST_INTERCEPTED',
    method: req.method,
    url: req.url,
    clientId,
    sessionId,
    routingStrategy: routingDecision.strategy,
    routingReason: routingDecision.reason,
  });

  return {
    method: req.method || 'GET',
    url: req.url || '/',
    headers,
    body,
    routingDecision,
    sessionId,
    clientId,
  };
}

/**
 * Sanitize headers for logging (remove sensitive data)
 */
export function sanitizeHeadersForLogging(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  const sensitiveKeys = [
    HEADER_AUTHORIZATION,
    HEADER_SAP_JWT_TOKEN,
    HEADER_SAP_REFRESH_TOKEN,
    HEADER_SAP_PASSWORD,
    HEADER_SAP_UAA_CLIENT_SECRET,
  ].map((k) => k.toLowerCase());

  for (const [key, value] of Object.entries(headers)) {
    if (sensitiveKeys.includes(key.toLowerCase())) {
      sanitized[key] = '[REDACTED]';
    } else {
      sanitized[key] = Array.isArray(value) ? value.join(', ') : value || '';
    }
  }

  return sanitized;
}
