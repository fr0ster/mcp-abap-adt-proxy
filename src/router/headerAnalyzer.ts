/**
 * Header Analyzer - Analyzes HTTP headers to determine routing strategy
 */

import type { IncomingHttpHeaders } from 'node:http';
import {
  HEADER_BTP_DESTINATION,
  HEADER_MCP_URL,
} from '@mcp-abap-adt/interfaces';
import { logger } from '../lib/logger.js';

export enum RoutingStrategy {
  /** Proxy request with JWT authentication */
  PROXY = 'proxy',
  /** Pass through request without modifications (no proxy headers) */
  PASSTHROUGH = 'passthrough',
  /** Unknown/unsupported - should not route */
  UNKNOWN = 'unknown',
}

export interface RoutingDecision {
  strategy: RoutingStrategy;
  btpDestination?: string; // Destination for BTP Cloud authorization (x-btp-destination)
  mcpUrl?: string; // Direct MCP server URL (x-mcp-url header)
  reason: string;
}

/**
 * Analyze headers and extract routing information
 *
 * Proxy validates only one header for authentication:
 * - x-btp-destination (or --btp): destination for BTP Cloud authorization token (Authorization: Bearer) and MCP server URL
 *
 * Also supports:
 * - x-mcp-url (or --mcp-url): direct MCP server URL (optional, for local testing)
 *
 * Command-line overrides (take precedence over headers):
 * - --btp=<destination>: overrides x-btp-destination header
 * - --mcp-url=<url>: overrides x-mcp-url header
 *
 * Other headers are passed directly to MCP server without validation.
 *
 * MCP server URL is obtained from:
 * - x-mcp-url header or --mcp-url parameter (if provided) - takes precedence
 * - service key for x-btp-destination (via auth-broker) if BTP destination is present
 *
 * Note: Proxy does NOT use .env files for connection configuration. Only destinations via auth-broker (service key files) are used.
 */
export function analyzeHeaders(
  headers: IncomingHttpHeaders,
  configOverrides?: {
    btpDestination?: string;
    mcpUrl?: string;
  },
): RoutingDecision {
  // Helper function to extract string value from header (handles arrays and case-insensitive lookup)
  const getHeaderValue = (headerName: string): string | undefined => {
    let headerValue = headers[headerName.toLowerCase()];
    if (!headerValue) {
      headerValue = headers[headerName];
    }
    if (!headerValue) return undefined;
    if (Array.isArray(headerValue)) {
      return headerValue[0]?.trim();
    }
    return typeof headerValue === 'string' ? headerValue.trim() : undefined;
  };

  // Extract authorization destination for BTP Cloud (x-btp-destination)
  // Command-line parameter --btp takes precedence over header
  const btpDestinationHeader = getHeaderValue(HEADER_BTP_DESTINATION);
  const extractedBtpDestination = configOverrides?.btpDestination
    ? configOverrides.btpDestination
    : btpDestinationHeader;

  // Extract direct MCP server URL (x-mcp-url)
  // Command-line parameter --mcp-url takes precedence over header
  const mcpUrlHeader = getHeaderValue(HEADER_MCP_URL);
  const extractedMcpUrl = configOverrides?.mcpUrl
    ? configOverrides.mcpUrl
    : mcpUrlHeader;

  // Check if proxy headers exist in the actual HTTP request (not in config overrides)
  const hasBtpInRequest = !!btpDestinationHeader;
  const hasMcpUrlInRequest = !!mcpUrlHeader;

  // If no proxy headers in the actual request, pass through without modifications
  if (!hasBtpInRequest && !hasMcpUrlInRequest) {
    logger?.debug(
      'No proxy headers found in request - passing through without modifications',
      {
        type: 'PASSTHROUGH_REQUEST',
        headers: Object.keys(headers).filter((k) =>
          k.toLowerCase().startsWith('x-'),
        ),
        hasBtpConfigOverride: !!configOverrides?.btpDestination,
        hasMcpUrlConfigOverride: !!configOverrides?.mcpUrl,
      },
    );

    return {
      strategy: RoutingStrategy.PASSTHROUGH,
      mcpUrl: extractedMcpUrl, // Use --mcp-url as target URL for passthrough
      reason:
        'No proxy headers found in request - request will be passed through without modifications',
    };
  }

  // If only MCP URL is provided without BTP destination, that's OK - other headers will be passed directly
  if (!extractedBtpDestination && extractedMcpUrl) {
    logger?.debug(
      'Using MCP URL directly (no BTP destination - headers will be passed as-is)',
      {
        type: 'MCP_URL_DIRECT',
        mcpUrl: extractedMcpUrl,
      },
    );
  }

  // If x-btp-destination is present, we can proxy with BTP authentication (URL will be obtained from service key)
  // If x-mcp-url is provided, we can use it directly (for local testing)
  logger?.debug('Routing decision: PROXY', {
    btpDestination: extractedBtpDestination,
    mcpUrl: extractedMcpUrl || 'not provided',
  });

  const reason = extractedBtpDestination
    ? `Proxying to MCP server from BTP destination "${extractedBtpDestination}"`
    : `Proxying to MCP server at "${extractedMcpUrl}" (no BTP authentication - local testing mode)`;

  return {
    strategy: RoutingStrategy.PROXY,
    btpDestination: extractedBtpDestination,
    mcpUrl: extractedMcpUrl,
    reason,
  };
}

/**
 * Check if headers indicate a request that should be proxied
 */
export function shouldProxy(headers: IncomingHttpHeaders): boolean {
  const decision = analyzeHeaders(headers);
  return decision.strategy === RoutingStrategy.PROXY;
}
