/**
 * Direct Cloud Router - Routes requests directly to cloud ABAP systems
 * 
 * For requests with x-sap-destination (not "sk"), routes directly to cloud ABAP
 * using the same approach as mcp-abap-adt
 */

import { IncomingHttpHeaders } from "http";
import { AuthBroker } from "@mcp-abap-adt/auth-broker";
import { createAbapConnection, AbapConnection, FileSessionStorage } from "@mcp-abap-adt/connection";
import { logger } from "../lib/logger.js";
import { RoutingDecision } from "./headerAnalyzer.js";

export interface DirectCloudConfig {
  sapUrl: string;
  destination?: string;
  authType: "jwt" | "basic";
  jwtToken?: string;
  refreshToken?: string;
  username?: string;
  password?: string;
  sapClient?: string;
  uaaUrl?: string;
  uaaClientId?: string;
  uaaClientSecret?: string;
}

/**
 * Convert validated auth config to direct cloud config
 */
export function createDirectCloudConfig(
  routingDecision: RoutingDecision,
  headers: IncomingHttpHeaders
): DirectCloudConfig | null {
  const validatedConfig = routingDecision.validationResult?.config;
  if (!validatedConfig) {
    logger.warn("No validated config available for direct cloud routing", {
      type: "DIRECT_CLOUD_CONFIG_ERROR",
      strategy: routingDecision.strategy,
    });
    return null;
  }

  // Extract SAP URL
  let sapUrl = validatedConfig.sapUrl;
  if (!sapUrl && routingDecision.destination) {
    // For destination-based auth, URL comes from destination service key
    // We'll need to load it from AuthBroker
    // For now, return null and let the caller handle it
    logger.debug("SAP URL not in validated config, will load from destination", {
      destination: routingDecision.destination,
    });
  }

  // Convert xsuaa to jwt (they're the same for connection purposes)
  const authType = validatedConfig.authType === "xsuaa" ? "jwt" : validatedConfig.authType;

  const config: DirectCloudConfig = {
    sapUrl: sapUrl || "", // Will be loaded from destination if needed
    destination: validatedConfig.destination || routingDecision.destination,
    authType: authType as "jwt" | "basic",
    sapClient: validatedConfig.sapClient,
  };

  // Add JWT-specific fields
  if (validatedConfig.authType === "jwt" || validatedConfig.authType === "xsuaa") {
    config.jwtToken = validatedConfig.jwtToken;
    config.refreshToken = validatedConfig.refreshToken;
    config.uaaUrl = validatedConfig.uaaUrl;
    config.uaaClientId = validatedConfig.uaaClientId;
    config.uaaClientSecret = validatedConfig.uaaClientSecret;
  }

  // Add basic auth fields
  if (validatedConfig.authType === "basic") {
    config.username = validatedConfig.username;
    config.password = validatedConfig.password;
  }

  return config;
}

/**
 * Connection cache for direct cloud connections
 */
const connectionCache = new Map<string, {
  connection: AbapConnection;
  configSignature: string;
  lastUsed: Date;
}>();

/**
 * Generate cache key for connection
 */
function generateConnectionCacheKey(sessionId: string, config: DirectCloudConfig): string {
  const crypto = require("crypto");
  const hash = crypto.createHash("sha256");
  hash.update(sessionId);
  hash.update(config.sapUrl);
  hash.update(config.destination || "");
  hash.update(config.authType);
  hash.update(config.sapClient || "");
  return hash.digest("hex");
}

/**
 * Clean up old connections from cache
 */
function cleanupConnectionCache(): void {
  const now = new Date();
  const maxAge = 60 * 60 * 1000; // 1 hour

  for (const [key, entry] of connectionCache.entries()) {
    const age = now.getTime() - entry.lastUsed.getTime();
    if (age > maxAge) {
      logger.debug("Cleaning up old connection cache entry", {
        type: "CONNECTION_CACHE_CLEANUP",
        key: key.substring(0, 16),
      });
      connectionCache.delete(key);
    }
  }
}

/**
 * Get or create ABAP connection for direct cloud routing
 */
export async function getDirectCloudConnection(
  sessionId: string,
  config: DirectCloudConfig,
  authBroker?: AuthBroker
): Promise<AbapConnection> {
  // Clean up old entries periodically
  if (connectionCache.size > 100) {
    cleanupConnectionCache();
  }

  const cacheKey = generateConnectionCacheKey(sessionId, config);
  let entry = connectionCache.get(cacheKey);

  // If we have a destination and no SAP URL, load it from AuthBroker
  if (config.destination && !config.sapUrl && authBroker) {
    try {
      // Get token from AuthBroker (this will also provide the SAP URL from destination)
      const token = await authBroker.getToken(config.destination);
      config.jwtToken = token;
      
      // Load destination config to get SAP URL from AuthBroker
      // AuthBroker stores session data, we can access it through the broker
      // For now, we'll rely on the token being valid and the URL being set from destination
      // The actual URL will be loaded when we create the connection
    } catch (error) {
      logger.error("Failed to load destination config from AuthBroker", {
        type: "AUTH_BROKER_LOAD_ERROR",
        destination: config.destination,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  if (!entry || entry.configSignature !== cacheKey) {
    logger.debug("Creating new direct cloud connection", {
      type: "DIRECT_CLOUD_CONNECTION_CREATE",
      sessionId: sessionId.substring(0, 8),
      destination: config.destination,
      sapUrl: config.sapUrl,
    });

    // Dispose old connection if exists
    if (entry) {
      // Connection disposal will be handled by connection package
    }

    // Create SAP config for connection
    const sapConfig = {
      url: config.sapUrl,
      authType: config.authType,
      jwtToken: config.jwtToken,
      refreshToken: config.refreshToken,
      username: config.username,
      password: config.password,
      sapClient: config.sapClient,
      uaaUrl: config.uaaUrl,
      uaaClientId: config.uaaClientId,
      uaaClientSecret: config.uaaClientSecret,
    };

    // Create connection
    const connectionSessionId = `mcp-proxy-direct-${sessionId}`;
    const sessionStorage = new FileSessionStorage();
    const connection = createAbapConnection(
      sapConfig,
      logger, // Use our logger
      sessionStorage,
      connectionSessionId
    );

    // Connect
    try {
      await connection.connect();
    } catch (error) {
      logger.error("Failed to connect to cloud ABAP", {
        type: "DIRECT_CLOUD_CONNECTION_ERROR",
        error: error instanceof Error ? error.message : String(error),
        destination: config.destination,
      });
      throw error;
    }

    entry = {
      connection,
      configSignature: cacheKey,
      lastUsed: new Date(),
    };

    connectionCache.set(cacheKey, entry);
  } else {
    entry.lastUsed = new Date();
    logger.debug("Reusing cached direct cloud connection", {
      type: "DIRECT_CLOUD_CONNECTION_REUSE",
      sessionId: sessionId.substring(0, 8),
    });
  }

  return entry.connection;
}

