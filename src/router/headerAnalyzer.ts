/**
 * Header Analyzer - Analyzes HTTP headers to determine routing strategy
 */

import { IncomingHttpHeaders } from "http";
import { validateAuthHeaders, AuthMethodPriority, HeaderValidationResult } from "@mcp-abap-adt/header-validator";
import { logger } from "../lib/logger.js";

export enum RoutingStrategy {
  /** Route directly to cloud ABAP (x-sap-destination: "S4HANA_E19") */
  DIRECT_CLOUD = "direct-cloud",
  /** Handle locally with basic auth (x-sap-auth-type: "basic") */
  LOCAL_BASIC = "local-basic",
  /** Proxy to cloud-llm-hub with JWT (x-sap-destination: "sk") */
  PROXY_CLOUD_LLM_HUB = "proxy-cloud-llm-hub",
  /** Unknown/unsupported - should not route */
  UNKNOWN = "unknown",
}

export interface RoutingDecision {
  strategy: RoutingStrategy;
  destination?: string;
  authType?: string;
  reason: string;
  validationResult?: HeaderValidationResult;
}

/**
 * Analyze headers and determine routing strategy
 */
export function analyzeHeaders(headers: IncomingHttpHeaders): RoutingDecision {
  // Validate headers using header-validator
  const validationResult = validateAuthHeaders(headers);
  const validatedConfig = validationResult.config;

  // Check for direct cloud destination (e.g., "S4HANA_E19")
  const sapDestination = headers["x-sap-destination"];
  if (sapDestination && typeof sapDestination === "string") {
    const destination = sapDestination.trim();
    
    // If destination is "sk", route to cloud-llm-hub
    if (destination === "sk") {
      logger.debug("Routing decision: PROXY_CLOUD_LLM_HUB", {
        destination,
        priority: validatedConfig?.priority,
      });
      return {
        strategy: RoutingStrategy.PROXY_CLOUD_LLM_HUB,
        destination,
        reason: `Destination "${destination}" requires proxying to cloud-llm-hub with JWT`,
        validationResult,
      };
    }

    // If destination is a direct cloud destination (not "sk"), route directly
    // Examples: "S4HANA_E19", "TRIAL", etc.
    if (destination && destination !== "sk") {
      logger.debug("Routing decision: DIRECT_CLOUD", {
        destination,
        priority: validatedConfig?.priority,
      });
      return {
        strategy: RoutingStrategy.DIRECT_CLOUD,
        destination,
        reason: `Destination "${destination}" routes directly to cloud ABAP`,
        validationResult,
      };
    }
  }

  // Check for basic auth type
  const authType = headers["x-sap-auth-type"];
  if (authType && typeof authType === "string" && authType.trim().toLowerCase() === "basic") {
    logger.debug("Routing decision: LOCAL_BASIC", {
      authType: authType.trim(),
    });
    return {
      strategy: RoutingStrategy.LOCAL_BASIC,
      authType: authType.trim(),
      reason: `Basic authentication handled locally`,
      validationResult,
    };
  }

  // If we have validated config but no clear routing strategy, check priority
  if (validatedConfig && validatedConfig.priority !== AuthMethodPriority.NONE) {
    // If it's a destination-based auth (priority 4 or 3), it should be direct cloud
    if (validatedConfig.priority === AuthMethodPriority.SAP_DESTINATION || 
        validatedConfig.priority === AuthMethodPriority.MCP_DESTINATION) {
      const dest = validatedConfig.destination || (sapDestination as string | undefined);
      if (dest && dest !== "sk") {
        return {
          strategy: RoutingStrategy.DIRECT_CLOUD,
          destination: dest,
          reason: `Destination-based auth (priority ${validatedConfig.priority}) routes to cloud`,
          validationResult,
        };
      }
    }
  }

  // Unknown routing strategy
  logger.warn("Unknown routing strategy", {
    headers: Object.keys(headers).filter(k => k.toLowerCase().startsWith("x-sap")),
    validationResult: {
      isValid: validationResult.isValid,
      priority: validatedConfig?.priority,
      authType: validatedConfig?.authType,
      errors: validationResult.errors,
    },
  });

  return {
    strategy: RoutingStrategy.UNKNOWN,
    reason: "No clear routing strategy could be determined from headers",
    validationResult,
  };
}

/**
 * Check if headers indicate a request that should be proxied
 */
export function shouldProxyToCloudLlmHub(headers: IncomingHttpHeaders): boolean {
  const decision = analyzeHeaders(headers);
  return decision.strategy === RoutingStrategy.PROXY_CLOUD_LLM_HUB;
}

/**
 * Check if headers indicate a direct cloud request
 */
export function isDirectCloudRequest(headers: IncomingHttpHeaders): boolean {
  const decision = analyzeHeaders(headers);
  return decision.strategy === RoutingStrategy.DIRECT_CLOUD;
}

/**
 * Check if headers indicate a local basic auth request
 */
export function isLocalBasicAuth(headers: IncomingHttpHeaders): boolean {
  const decision = analyzeHeaders(headers);
  return decision.strategy === RoutingStrategy.LOCAL_BASIC;
}

