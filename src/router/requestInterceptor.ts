/**
 * Request Interceptor - Intercepts and analyzes MCP requests
 */

import { IncomingMessage } from "http";
import { analyzeHeaders, RoutingDecision } from "./headerAnalyzer.js";
import { logger } from "../lib/logger.js";

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
  configOverrides?: { btpDestination?: string; mcpDestination?: string; mcpUrl?: string }
): InterceptedRequest {
  // Extract headers
  const headers: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    headers[key] = value;
  }

  // Analyze headers for routing decision (with config overrides)
  const routingDecision = analyzeHeaders(req.headers, configOverrides);

  // Extract session ID if present
  const sessionId = 
    (req.headers["x-session-id"] || 
     req.headers["mcp-session-id"] || 
     req.headers["x-mcp-session-id"]) as string | undefined;

  // Generate client ID
  const clientId = `${req.socket.remoteAddress}:${req.socket.remotePort}`;

  // Log intercepted request
  logger.debug("Request intercepted", {
    type: "REQUEST_INTERCEPTED",
    method: req.method,
    url: req.url,
    clientId,
    sessionId,
    routingStrategy: routingDecision.strategy,
    routingReason: routingDecision.reason,
  });

  return {
    method: req.method || "GET",
    url: req.url || "/",
    headers,
    body,
    routingDecision,
    sessionId,
    clientId,
  };
}

/**
 * Check if request requires SAP configuration
 * Only tools/call requires SAP config - all other methods don't
 */
export function requiresSapConfig(body: any): boolean {
  if (!body || typeof body !== "object") {
    return false;
  }

  const method = body.method;
  return method === "tools/call";
}

/**
 * Sanitize headers for logging (remove sensitive data)
 */
export function sanitizeHeadersForLogging(
  headers: Record<string, string | string[] | undefined>
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  const sensitiveKeys = [
    "authorization",
    "x-sap-jwt-token",
    "x-sap-refresh-token",
    "x-sap-password",
    "x-sap-uaa-client-secret",
  ];

  for (const [key, value] of Object.entries(headers)) {
    if (sensitiveKeys.includes(key.toLowerCase())) {
      sanitized[key] = "[REDACTED]";
    } else {
      sanitized[key] = Array.isArray(value) 
        ? value.join(", ") 
        : (value || "");
    }
  }

  return sanitized;
}

