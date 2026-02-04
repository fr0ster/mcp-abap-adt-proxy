/**
 * Header Analyzer - Analyzes HTTP headers to determine routing strategy
 */

import type { IncomingHttpHeaders } from 'node:http';
import { HEADER_BTP_DESTINATION } from '@mcp-abap-adt/interfaces';
import { logger } from '../lib/logger.js';

export enum RoutingStrategy {
  /** Proxy request with JWT authentication */
  PROXY = 'proxy',

  /** Unknown/unsupported - should not route */
  UNKNOWN = 'unknown',
}

export interface RoutingDecision {
  strategy: RoutingStrategy;
  btpDestination?: string; // Destination for BTP Cloud authorization (x-btp-destination)

  reason: string;
}

/**
 * Analyze headers and extract routing information
 *
 * Proxy validates only one header for authentication:
 * - x-btp-destination (or --btp): destination for BTP Cloud authorization token (Authorization: Bearer) and MCP server URL
 *

 *
 * Command-line overrides (take precedence over headers):
 * - --btp=<destination>: overrides x-btp-destination header
 *
 * Other headers are passed directly to MCP server without validation.
 *
 * MPC server URL is obtained from:
 * - service key for x-btp-destination (via auth-broker)
 *
 *
 * Note: Proxy does NOT use .env files for connection configuration. Only destinations via auth-broker (service key files) are used.
 */
export function analyzeHeaders(
  headers: IncomingHttpHeaders,
  configOverrides?: {
    btpDestination?: string;
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

  // Extract direct MCP server URL (x-mcp-url) - REMOVED
  // Command-line parameter --mcp-url takes precedence over header
  // const mcpUrlHeader = getHeaderValue(HEADER_MCP_URL);
  // const extractedMcpUrl = configOverrides?.mcpUrl
  //   ? configOverrides.mcpUrl
  //   : mcpUrlHeader;

  // Check if proxy headers exist in the actual HTTP request (not in config overrides)
  const hasBtpInRequest = !!btpDestinationHeader;

  // If no proxy headers in the actual request, default to what's available or error out
  if (!extractedBtpDestination) {
    return {
      strategy: RoutingStrategy.UNKNOWN,
      reason:
        'No BTP destination provided (missing x-btp-destination or --btp)',
    };
  }

  // If x-btp-destination is present, we can proxy with BTP authentication (URL will be obtained from service key)
  // If x-mcp-url is provided, we can use it directly (for local testing)
  logger?.debug('Routing decision: PROXY', {
    btpDestination: extractedBtpDestination,
  });

  const reason = `Proxying to MCP server from BTP destination "${extractedBtpDestination}"`;

  return {
    strategy: RoutingStrategy.PROXY,
    btpDestination: extractedBtpDestination,
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
