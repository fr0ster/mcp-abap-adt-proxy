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
 * Proxy needs either:
 * - x-btp-destination (or --btp): destination for BTP Cloud authorization token (Authorization: Bearer) and MCP server URL
 * - x-mcp-destination (or --mcp): destination for SAP ABAP connection (SAP headers) - can be used without BTP for local testing
 * 
 * Also supports:
 * - x-mcp-url (or --mcp-url): direct MCP server URL (used when no BTP destination is provided, for local testing)
 * 
 * Command-line overrides:
 * - --btp=<destination>: overrides x-btp-destination header
 * - --mcp=<destination>: overrides x-mcp-destination header
 * - --mcp-url=<url>: overrides x-mcp-url header (for local testing without BTP)
 * 
 * MCP server URL is obtained from:
 * - x-mcp-url header or --mcp-url parameter (if provided) - takes precedence
 * - service key for x-btp-destination (via auth-broker) if BTP destination is present
 * - service key for x-mcp-destination (via auth-broker) if only MCP destination is present
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

  // Allow proxying if either:
  // 1. BTP destination is present, OR
  // 2. MCP destination is present, OR
  // 3. MCP URL is provided (for local testing without BTP)
  // This enables local testing without BTP authentication
  if (!extractedBtpDestination && !extractedMcpDestination && !extractedMcpUrl) {
    logger.warn("Neither x-btp-destination/x-mcp-destination/x-mcp-url header nor --btp/--mcp/--mcp-url parameter is provided", {
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

  // If only MCP URL is provided without destination, we still need either mcpDestination or btpDestination
  // unless mcpUrl is a full URL that can be used directly
  if (!extractedBtpDestination && !extractedMcpDestination && extractedMcpUrl) {
    // This is OK - we can use mcpUrl directly for local testing
    logger.debug("Using MCP URL directly for local testing (no destination required)", {
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

