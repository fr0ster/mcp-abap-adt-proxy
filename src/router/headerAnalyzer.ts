/**
 * Header Analyzer - Analyzes HTTP headers to determine routing strategy
 */

import { IncomingHttpHeaders } from "http";
import { validateAuthHeaders, AuthMethodPriority, HeaderValidationResult } from "@mcp-abap-adt/header-validator";
import { logger } from "../lib/logger.js";

export enum RoutingStrategy {
  /** Proxy request with JWT authentication */
  PROXY = "proxy",
  /** Unknown/unsupported - should not route */
  UNKNOWN = "unknown",
}

export interface RoutingDecision {
  strategy: RoutingStrategy;
  btpDestination?: string; // Destination for BTP Cloud authorization (x-btp-destination)
  mcpDestination?: string; // Destination for SAP ABAP connection (x-mcp-destination)
  mcpUrl?: string; // Direct MCP server URL (x-mcp-url header)
  reason: string;
  validationResult?: HeaderValidationResult;
}

/**
 * Analyze headers and extract routing information
 * 
 * Proxy validates only two headers:
 * - x-btp-destination (or --btp): destination for BTP Cloud authorization token (Authorization: Bearer) and MCP server URL
 * - x-mcp-destination (or --mcp): destination for SAP ABAP connection (SAP headers)
 * 
 * Also supports:
 * - x-mcp-url (or --mcp-url): direct MCP server URL (optional, for local testing)
 * 
 * Command-line overrides (take precedence over headers):
 * - --btp=<destination>: overrides x-btp-destination header
 * - --mcp=<destination>: overrides x-mcp-destination header
 * - --mcp-url=<url>: overrides x-mcp-url header
 * 
 * Other headers (x-sap-url, x-sap-jwt-token, etc.) are passed directly to MCP server without validation.
 * 
 * MCP server URL is obtained from:
 * - x-mcp-url header or --mcp-url parameter (if provided) - takes precedence
 * - service key for x-btp-destination (via auth-broker) if BTP destination is present
 * - service key for x-mcp-destination (via auth-broker) if only MCP destination is present
 * 
 * Note: Proxy does NOT use .env files for connection configuration. Only destinations via auth-broker (service key files) are used.
 */
export function analyzeHeaders(
  headers: IncomingHttpHeaders,
  configOverrides?: { btpDestination?: string; mcpDestination?: string; mcpUrl?: string }
): RoutingDecision {
  // Validate headers using header-validator
  const validationResult = validateAuthHeaders(headers);
  const validatedConfig = validationResult.config;

  // Helper function to extract string value from header (handles arrays)
  const getHeaderValue = (headerValue: string | string[] | undefined): string | undefined => {
    if (!headerValue) return undefined;
    if (Array.isArray(headerValue)) {
      return headerValue[0]?.trim();
    }
    return typeof headerValue === "string" ? headerValue.trim() : undefined;
  };

  // Extract authorization destination for BTP Cloud (x-btp-destination)
  // Command-line parameter --btp takes precedence over header
  const btpDestinationHeader = getHeaderValue(headers["x-btp-destination"]);
  const extractedBtpDestination = configOverrides?.btpDestination 
    ? configOverrides.btpDestination
    : btpDestinationHeader;

  // Extract destination for SAP ABAP connection (x-mcp-destination)
  // Command-line parameter --mcp takes precedence over header
  const mcpDestinationHeader = getHeaderValue(headers["x-mcp-destination"]);
  const extractedMcpDestination = configOverrides?.mcpDestination 
    ? configOverrides.mcpDestination
    : mcpDestinationHeader;

  // Extract direct MCP server URL (x-mcp-url)
  // Command-line parameter --mcp-url takes precedence over header
  const mcpUrlHeader = getHeaderValue(headers["x-mcp-url"]);
  const extractedMcpUrl = configOverrides?.mcpUrl 
    ? configOverrides.mcpUrl
    : mcpUrlHeader;

  // Validate: at least one destination or MCP URL must be provided
  // We validate only x-btp-destination and x-mcp-destination headers
  // Other headers (x-sap-url, x-sap-jwt-token, etc.) are passed directly to MCP server
  if (!extractedBtpDestination && !extractedMcpDestination && !extractedMcpUrl) {
    logger.warn("Neither x-btp-destination/x-mcp-destination header nor --btp/--mcp parameter is provided, and no x-mcp-url/--mcp-url", {
      headers: Object.keys(headers).filter(k => k.toLowerCase().startsWith("x-")),
      hasBtpConfigOverride: !!configOverrides?.btpDestination,
      hasMcpConfigOverride: !!configOverrides?.mcpDestination,
      hasMcpUrlConfigOverride: !!configOverrides?.mcpUrl,
    });

    return {
      strategy: RoutingStrategy.UNKNOWN,
      reason: "Either x-btp-destination/--btp, x-mcp-destination/--mcp, or x-mcp-url/--mcp-url parameter is required for proxying",
      validationResult,
    };
  }

  // If only MCP URL is provided without destinations, that's OK - other headers will be passed directly
  if (!extractedBtpDestination && !extractedMcpDestination && extractedMcpUrl) {
    logger.debug("Using MCP URL directly (no destinations - headers will be passed as-is)", {
      type: "MCP_URL_DIRECT",
      mcpUrl: extractedMcpUrl,
    });
  }

  // If x-btp-destination is present, we can proxy with BTP authentication (URL will be obtained from service key)
  // If only x-mcp-destination is present, we can proxy without BTP authentication (for local testing)
  // If x-mcp-url is provided, we can use it directly (for local testing)
  logger.debug("Routing decision: PROXY", {
    btpDestination: extractedBtpDestination,
    mcpDestination: extractedMcpDestination,
    mcpUrl: extractedMcpUrl || "not provided",
    priority: validatedConfig?.priority,
  });

  const reason = extractedBtpDestination
    ? `Proxying to MCP server from BTP destination "${extractedBtpDestination}"${extractedMcpDestination ? ` with MCP destination "${extractedMcpDestination}"` : ''}`
    : extractedMcpUrl
    ? `Proxying to MCP server at "${extractedMcpUrl}" (no BTP authentication - local testing mode)${extractedMcpDestination ? ` with MCP destination "${extractedMcpDestination}"` : ''}`
    : `Proxying to MCP server with MCP destination "${extractedMcpDestination}" (no BTP authentication - local testing mode)`;

  return {
    strategy: RoutingStrategy.PROXY,
    btpDestination: extractedBtpDestination, // Optional - only used if provided
    mcpDestination: extractedMcpDestination, // Optional - only used if provided
    mcpUrl: extractedMcpUrl, // Optional - direct URL if provided (takes precedence)
    reason,
    validationResult,
  };
}

/**
 * Check if headers indicate a request that should be proxied
 */
export function shouldProxy(headers: IncomingHttpHeaders): boolean {
  const decision = analyzeHeaders(headers);
  return decision.strategy === RoutingStrategy.PROXY;
}

