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
  mcpUrl?: string; // MCP server URL from x-mcp-url header
  reason: string;
  validationResult?: HeaderValidationResult;
}

/**
 * Analyze headers and extract routing information
 * Proxy needs:
 * - x-mcp-url: where to forward the request
 * - x-btp-destination: destination for BTP Cloud authorization token (Authorization: Bearer)
 * - x-mcp-destination: destination for SAP ABAP connection (SAP headers)
 * 
 * Also supports command-line overrides:
 * - --btp=<destination>: overrides x-btp-destination header
 * - --mcp=<destination>: overrides x-mcp-destination header
 */
export function analyzeHeaders(
  headers: IncomingHttpHeaders,
  configOverrides?: { btpDestination?: string; mcpDestination?: string }
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

  // Extract MCP URL from x-mcp-url header (required)
  const extractedMcpUrl = getHeaderValue(headers["x-mcp-url"]);

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

  // x-mcp-url is required
  if (!extractedMcpUrl) {
    logger.warn("x-mcp-url header is missing", {
      headers: Object.keys(headers).filter(k => k.toLowerCase().startsWith("x-")),
      validationResult: {
        isValid: validationResult.isValid,
        priority: validatedConfig?.priority,
        authType: validatedConfig?.authType,
        errors: validationResult.errors,
      },
    });

    return {
      strategy: RoutingStrategy.UNKNOWN,
      reason: "x-mcp-url header is required for proxying",
      validationResult,
    };
  }

  // x-btp-destination or --btp is required for Authorization header
  if (!extractedBtpDestination) {
    logger.warn("x-btp-destination header or --btp parameter is missing", {
      headers: Object.keys(headers).filter(k => k.toLowerCase().startsWith("x-")),
      hasConfigOverride: !!configOverrides?.btpDestination,
    });

    return {
      strategy: RoutingStrategy.UNKNOWN,
      reason: "x-btp-destination header or --btp parameter is required for proxying (needed for Authorization: Bearer token)",
      validationResult,
    };
  }

  // If x-mcp-url and x-btp-destination are present, we can proxy
  logger.debug("Routing decision: PROXY", {
    btpDestination: extractedBtpDestination,
    mcpDestination: extractedMcpDestination,
    mcpUrl: extractedMcpUrl,
    priority: validatedConfig?.priority,
  });
  return {
    strategy: RoutingStrategy.PROXY,
    btpDestination: extractedBtpDestination,
    mcpDestination: extractedMcpDestination, // Optional - only used if provided
    mcpUrl: extractedMcpUrl,
    reason: `Proxying to ${extractedMcpUrl} with BTP destination "${extractedBtpDestination}"${extractedMcpDestination ? ` and MCP destination "${extractedMcpDestination}"` : ''}`,
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

